# Backend Interview Guide — Observe Insurance Claims Agent

**Purpose:** Deep-dive documentation for explaining how the backend was built, end to end. Use this to prepare for your Observe.AI interview tomorrow.

**Live service:** `https://observe-insurance-claims-agent.onrender.com`  
**Stack:** Node.js 18 · Express · Airtable · Retell AI · Slack · Render

---

## Table of Contents

1. [30-Second Elevator Pitch](#1-30-second-elevator-pitch)
2. [What Problem the Backend Solves](#2-what-problem-the-backend-solves)
3. [Architecture Overview](#3-architecture-overview)
4. [Project Structure — File by File](#4-project-structure--file-by-file)
5. [The Three Traffic Lanes](#5-the-three-traffic-lanes)
6. [Lane 1 — Inbound Webhook (Call Start)](#6-lane-1--inbound-webhook-call-start)
7. [Lane 2 — Tool Webhooks (During Call)](#7-lane-2--tool-webhooks-during-call)
8. [Lane 3 — Post-Call Webhook Pipeline](#8-lane-3--post-call-webhook-pipeline)
9. [Airtable Data Layer](#9-airtable-data-layer)
10. [Supporting Services](#10-supporting-services)
11. [Operations & Dashboard APIs](#11-operations--dashboard-apis)
12. [Key Design Decisions (With Why)](#12-key-design-decisions-with-why)
13. [Problems We Hit and How We Fixed Them](#13-problems-we-hit-and-how-we-fixed-them)
14. [Security, PII, and Scope Guards](#14-security-pii-and-scope-guards)
15. [What You Would Do Differently in Production](#15-what-you-would-do-differently-in-production)
16. [Interview Q&A — Likely Questions & Strong Answers](#16-interview-qa--likely-questions--strong-answers)
17. [Demo Script — What to Show Live](#17-demo-script--what-to-show-live)
18. [Quick Reference Cheat Sheet](#18-quick-reference-cheat-sheet)

---

## 1. 30-Second Elevator Pitch

> "I built a Node/Express backend that sits between Retell's voice agent and Airtable. Retell calls my endpoints in three phases: at call start for caller identification, during the call for authentication and claim lookups, and after the call for post-call analytics. The backend enforces security boundaries — every claim lookup requires an authenticated customer ID — handles graceful degradation when Airtable is slow or down, and runs a two-phase post-call pipeline that writes interaction records to Airtable with exactly-once semantics. Escalations fire Slack alerts without blocking warm transfers."

---

## 2. What Problem the Backend Solves

Retell is great at conversation, but it should **not** be your system of record or security boundary. The backend exists to:


| Responsibility                  | Why not leave it to Retell alone?                                    |
| ------------------------------- | -------------------------------------------------------------------- |
| **Authenticate callers**        | DOB comparison must happen server-side; PII must not leak into logs  |
| **Scope claim lookups**         | Prevent cross-customer data access via `customer_id` enforcement     |
| **Persist interaction records** | Survive hangups, mid-call drops, and agent errors                    |
| **Integrate external systems**  | Airtable, Slack, Retell Get Call API                                 |
| **Graceful degradation**        | Structured fallbacks so the agent warm-transfers instead of freezing |
| **Idempotency**                 | Retell retries webhooks; duplicate writes must not happen            |


The voice agent handles **conversation**. The backend handles **truth, security, and persistence**.

---

## 3. Architecture Overview

```
                         ┌─────────────────────────────────┐
                         │         RETELL AI               │
                         │  (Voice + LLM + Telephony)      │
                         └───────────┬─────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
  POST /webhook/inbound      POST /tools/*              POST /webhooks/call-end
  (phone number level)       (during call)              (agent level, post-call)
         │                           │                           │
         └───────────────────────────┼───────────────────────────┘
                                     ▼
                    ┌────────────────────────────────┐
                    │   Express Backend (Render)     │
                    │                                │
                    │  index.js      — core routes   │
                    │  routes/tools  — 6 tool APIs   │
                    │  routes/webhooks — post-call   │
                    │  services/airtable — data layer│
                    │  services/slack  — alerts      │
                    │  services/callActivity — phone │
                    │  demo/failSwitch — demo mode   │
                    └───────────────┬────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
         Airtable              Retell API              Slack
    (Customers, Claims,     GET /v2/get-call      Incoming Webhook
     Interactions, Callbacks)
```

### Request lifecycle (one complete call)

```
1. CALL STARTS
   Retell → POST /webhook/inbound
   Backend looks up phone in Airtable → returns dynamic variables
   Agent greets caller by name (if known)

2. DURING CALL
   Retell → POST /tools/lookup-customer
   Retell → POST /tools/verify-identity
   Retell → POST /tools/get-claim-status
   (optional) POST /tools/request-callback
   (optional) POST /tools/notify-escalation → Slack

3. CALL ENDS
   Retell → POST /webhooks/call-end  event=call_started  → cache phone
   Retell → POST /webhooks/call-end  event=call_ended    → Phase 1 write
   Retell → POST /webhooks/call-end  event=call_analyzed → Phase 2 enrich
```

---

## 4. Project Structure — File by File

```
src/
├── index.js                 # Express app entry — inbound webhook, health, dashboard APIs
├── routes/
│   ├── tools.js             # All Retell tool endpoints (/tools/*)
│   └── webhooks.js          # Post-call pipeline (/webhooks/call-end)
├── services/
│   ├── airtable.js          # Single data layer — all DB reads/writes
│   ├── slack.js             # Escalation notifications
│   ├── callActivity.js      # Phone resolution + transcript parsing
│   └── cache.js             # In-memory lookup cache (15 min TTL)
└── demo/
    └── failSwitch.js        # Simulated backend failure for live demo

public/
└── dashboard.html           # Ops dashboard (static, served by Express)
```

**Design principle:** Routes are thin HTTP handlers. Business logic lives in `services/`. No SQL/Airtable calls inside route files except through the service layer.

---

## 5. The Three Traffic Lanes

Retell talks to your backend through **three separate integration points**. This is a common interview topic — understand why they're separate:


| Lane                | Retell config location | When it fires           | Endpoint                  |
| ------------------- | ---------------------- | ----------------------- | ------------------------- |
| **Inbound webhook** | Phone number settings  | Before agent speaks     | `POST /webhook/inbound`   |
| **Tool webhooks**   | Agent tool definitions | When LLM invokes a tool | `POST /tools/`*           |
| **Agent webhook**   | Agent global settings  | Call lifecycle events   | `POST /webhooks/call-end` |


They are **not interchangeable**. The inbound webhook has a special response envelope. Tool webhooks expect flat JSON args. Agent webhooks carry `{ event, call }`.

---

## 6. Lane 1 — Inbound Webhook (Call Start)

**File:** `src/index.js` → `POST /webhook/inbound`

### What it does

When a PSTN call arrives, Retell hits this endpoint **before the agent says anything**. We look up the caller's phone number in Airtable and return dynamic variables (DVs) that pre-populate the agent's context.

### Request shape (Retell-specific)

```json
{
  "event": "call_inbound",
  "call_inbound": {
    "from_number": "+16179349090",
    "to_number": "+12183181089"
  }
}
```

**Critical bug we fixed:** `from_number` is nested under `call_inbound`, not at the top level. Reading `req.body.from_number` returns `undefined`.

### Response shape (Retell-required envelope)

```json
{
  "call_inbound": {
    "override_agent_id": "agent_xxx",
    "dynamic_variables": {
      "customer_found": "true",
      "customer_id": "CUST004",
      "first_name": "Jibin"
    }
  }
}
```

**Rules:**

- Must use the `call_inbound.dynamic_variables` envelope — flat JSON does not work
- All DV values must be **strings** — Retell rejects booleans and numbers
- If caller not found, return `customer_found: "false"` with empty strings

### Error handling philosophy

On **any** error (Airtable down, timeout), return the "not found" response — never fail the call. The agent falls back to asking for the phone number manually.

### Debug support

- In-memory ring buffer: last 20 inbound calls
- `GET /debug/inbound-log` — verify Retell is hitting the endpoint

---

## 7. Lane 2 — Tool Webhooks (During Call)

**File:** `src/routes/tools.js`

Every tool route follows the same pattern:

```
1. Validate required parameters
2. Check demo fail switch (returns 500 if active)
3. Call airtable service (8s timeout)
4. On error → return JSON with `fallback` string (never throw to caller)
```

Middleware on all `/tools/*` routes injects simulated failure when demo mode is active.

### Tool 1: `POST /tools/lookup-customer`

| Input | `phone_number` (any format) |
| Output | `{ found, customer_id?, first_name?, last_name? }` |
| Cache | In-memory, 15 min TTL — avoids repeat Airtable hits mid-call |
| PII | Phone logged as `[REDACTED]` — only digit length logged |

**Phone normalization:** Strips non-digits, converts 10-digit US numbers to 11-digit (`6179349090` → `16179349090`) to match Airtable storage format.

### Tool 2: `POST /tools/verify-identity`

| Input | `customer_id`, `dob_last4` |
| Output | `{ verified: true/false }` |
| Security | `dob_last4` is **never logged** — comparison happens server-side only |
| Normalization | Takes last 4 digits after stripping non-digits |

Brute-force protection (max 2 attempts) lives in the **agent prompt**, not the backend — worth mentioning in interview as a deliberate split of concerns.

### Tool 3: `POST /tools/get-claim-status`

| Input | `customer_id` (required), `claim_id` (optional) |
| Output | Single claim, multi-claim list, or `{ found: false }` |

**Security boundary — know this cold:**

```javascript
// ALWAYS scoped — claim_id alone is never sufficient
const formula = claim_id
  ? `AND({customer_id} = "${customer_id}", {claim_id} = "${claim_id}")`
  : `{customer_id} = "${customer_id}"`;
```

A caller who knows another customer's claim ID but not their customer ID gets `found: false`. Cross-customer leaks are structurally impossible.

**Multi-claim optimization:** When `claim_id` is omitted, returns all claims with `status_detail` in one response — agent doesn't need a second tool call.

Response shapes:

```json
// Single
{ "found": true, "single": true, "claim_id": "CLM-005", "status_detail": "..." }

// Multiple
{ "found": true, "multiple": true, "claims": [{ "claim_id": "CLM-001", ... }] }
```

### Tool 4: `POST /tools/request-callback` (in-call write)

| Input | `customer_id`, `caller_name`, `phone`, `preferred_time`, `reason` |
| Output | `{ success, callback_id, message }` — agent reads `message` aloud |
| Writes to | Airtable `Callbacks` table immediately |

This is the **intentional mid-call write** — demonstrates write capability without relying on post-call pipeline timing.

### Tool 5: `POST /tools/notify-escalation`

| Input | `caller_name`, `reason`, `summary` |
| Response | `202 Accepted` immediately — **before** Slack call |
| Writes to | Slack only — **not** Airtable |

**Fire-and-forget pattern:**

```javascript
res.status(202).json({ notified: true, async: true });
slack.notifyEscalation({ ... }).catch(err => console.error(...));
```

Why 202 before Slack? Warm transfer must never wait on a third-party notification service. Slack outage ≠ blocked transfer.

Escalation **is** captured in Airtable indirectly via post-call webhook (`escalated: "Yes"`, `resolution: "escalated"` when `disconnection_reason === "call_transfer"`).

### Tool 6: `POST /tools/write-interaction-record` (legacy)

Originally the in-call post-call write. **Superseded** by the webhook pipeline (`call_ended` + `call_analyzed`), which is more robust — survives hangups and mid-call drops. Kept for backward compatibility with agent export.

---

## 8. Lane 3 — Post-Call Webhook Pipeline

**File:** `src/routes/webhooks.js` → `POST /webhooks/call-end`

This is the most sophisticated part of the backend. Retell fires **multiple events** to the same URL:


| Event           | When              | What we do                                     |
| --------------- | ----------------- | ---------------------------------------------- |
| `call_started`  | Call connects     | Cache `call_id → from_number`                  |
| `call_ended`    | Hangup / transfer | **Phase 1** — write initial interaction record |
| `call_analyzed` | ~seconds later    | **Phase 2** — fetch Retell API, enrich record  |


**Always respond `200` immediately** — processing happens after acknowledgment. Retell retries on non-200.

### Phase 1 — `call_ended`

Writes an initial Airtable record with what we know immediately:


| Field          | Source                                                        |
| -------------- | ------------------------------------------------------------- |
| `call_id`      | Retell (idempotency key)                                      |
| `caller_phone` | `resolveCallerPhone()` — from_number, cache, or spoken number |
| `caller_name`  | DVs or fallback Airtable lookup                               |
| `customer_id`  | DVs or fallback lookup                                        |
| `resolution`   | Inferred from `disconnection_reason`                          |
| `call_summary` | Placeholder — overwritten in Phase 2                          |
| `sentiment`    | `"Neutral"` placeholder                                       |


**Resolution inference:**

```
call_transfer     → escalated
agent_hangup      → resolved
user_hangup       → incomplete
inactivity        → incomplete
```

### Phase 2 — `call_analyzed`

**Key design decision:** We do **not** trust the webhook payload for analysis data. Instead:

1. `call_analyzed` event is a **trigger only**
2. Backend calls `GET https://api.retellai.com/v2/get-call/{call_id}`
3. Patches Airtable with authoritative data from API response

Why? The webhook payload can be incomplete or arrive before analysis settles. The API is the same source Retell's dashboard uses.

**What Phase 2 enriches:**


| Airtable field             | Source                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `call_summary`             | `call_analysis.call_summary`                                      |
| `sentiment`                | `call_analysis.user_sentiment`                                    |
| `resolution`               | `call_analysis.call_successful`                                   |
| `intent`, `claims_checked` | `custom_analysis_data` (Retell post-call variables)               |
| `customer_id`              | Parsed from `transcript_with_tool_calls` (multi-customer support) |
| `claims_checked`           | Parsed from tool results in transcript                            |
| `caller_phone`             | `resolveCallerPhone()` with API + transcript fallbacks            |


### Transcript parsing (`callActivity.js`)

 Parses `transcript_with_tool_calls` without any agent changes:

```
tool_call_invocation (lookup_customer) → extract phone_number argument
tool_call_result (lookup_customer)     → extract customer_id
tool_call_result (get_claim_status)    → extract claim_id(s)
```

This handles **multi-customer calls** — one call checking two different accounts stores `customer_id: "CUST004, CUST001"`.

### Race condition handling

`call_ended` and `call_analyzed` fire within **~20ms** of each other. Two guards:

**1. In-memory lock (`pendingWrites` Set in airtable.js):**

```javascript
if (pendingWrites.has(call_id)) return { reason: 'write_in_progress' };
pendingWrites.add(call_id);
try { /* write */ } finally { pendingWrites.delete(call_id); }
```

**2. DB-level idempotency:**

```javascript
// Check if record already exists for this call_id before inserting
filterByFormula: `{call_id} = "${call_id}"`
```

**3. Phase 2 retry:**
If `updateInteractionRecord` returns `not_found` (Phase 1 still in-flight), wait 3 seconds and retry once. If still missing, create fallback record from API data.

### Phone resolution priority chain

```
1. call.from_number (webhook payload)
2. callData.from_number (Retell Get Call API)
3. call_started cache (in-memory, keyed by call_id)
4. Spoken phone from lookup_customer tool invocations in transcript
```

---

## 9. Airtable Data Layer

**File:** `src/services/airtable.js`

All database access goes through this single file. Every function is wrapped in an **8-second timeout**:

```javascript
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Airtable timeout after ${ms}ms`)), ms)
    ),
  ]);
}
```

Why 8 seconds? Voice calls need fast responses. If Airtable is slow, we'd rather return a graceful fallback in 8s than leave the caller in silence for 30s.

### Tables


| Table          | Operations                            |
| -------------- | ------------------------------------- |
| `Customers`    | READ — lookup, verify                 |
| `Claims`       | READ — status (scoped by customer_id) |
| `Interactions` | WRITE — post-call records             |
| `Callbacks`    | WRITE — in-call callback requests     |


### `writeInteractionRecord` — idempotency

- Primary key: `call_id` (Retell's call ID)
- Checks for existing record before insert
- In-memory `pendingWrites` guard against concurrent writes
- Returns `{ written: false, reason: 'already_logged' }` on duplicate — not an error

### `updateInteractionRecord` — enrichment

- Finds record by `call_id`
- Patches **only supplied fields** — leaves everything else untouched
- Safe to call multiple times

### Airtable field gotcha we hit

`escalated` is a Single Select field expecting `"Yes"` / omitted — not boolean `true`. We normalize:

```javascript
const escalatedBool = data.escalated === true || data.escalated === 'true';
...(escalatedBool ? { escalated: 'Yes' } : {}),
```

---

## 10. Supporting Services

### `services/cache.js`

In-memory TTL cache for `lookup-customer` results. Key: `customer:{phone_number}`. TTL: 15 minutes.

**Interview answer for "what about production?":** Swap the Map for Redis with the same get/set interface — callers don't change.

### `services/callActivity.js`

Phone resolution and transcript parsing. Shared by webhooks and `/api/sync-call` sync endpoint.

### `services/slack.js`

Posts formatted message to Slack Incoming Webhook. Gracefully skips if `SLACK_WEBHOOK_URL` not set.

### `demo/failSwitch.js`

In-memory flag. When active, all `/tools/`* routes return 500 with a `fallback` message. Auto-recovers after N seconds.

**Demo flow:** Hit `/demo/fail?duration=30` mid-call → agent gets fallback → warm transfers. Hit `/demo/recover` to reset early.

---

## 11. Operations & Dashboard APIs


| Endpoint                      | Purpose                                        |
| ----------------------------- | ---------------------------------------------- |
| `GET /health`                 | Render health check + env diagnostics (masked) |
| `GET /api/dashboard-data`     | Stats + recent interactions for dashboard      |
| `GET /api/callbacks`          | Recent callback requests                       |
| `GET /api/sync-call/:call_id` | Manual Retell API sync → patch Airtable        |
| `GET /debug/test-slack`       | Verify Slack integration                       |
| `GET /debug/inbound-log`      | Last 20 inbound webhook hits                   |
| `GET /webhooks/event-log`     | Last 20 post-call webhook events               |


Dashboard is static HTML served from `public/dashboard.html` — no separate frontend build.

---

## 12. Key Design Decisions (With Why)

### Decision 1: Auth is a boundary, not a step

Authentication happens in the Auth sub-agent. Every downstream tool requires `customer_id`. The backend enforces this in `getClaimStatus` — not just the agent prompt.

**Why:** Prompts can be jailbroken or misconfigured. Server-side scope guards cannot.

### Decision 2: Post-call writes belong in webhooks, not in-call tools

The webhook pipeline (`call_ended` + `call_analyzed`) survives:

- Mid-call hangups
- Agent errors
- Natural endings
- Transfers

An in-call `write-interaction-record` tool only fires if the agent explicitly calls it before hanging up.

### Decision 3: Phase 2 uses Retell API, not webhook payload

`call_analyzed` webhook is a trigger. We fetch `GET /v2/get-call/:call_id` for authoritative analysis.

**Why:** Eliminates timing issues, payload incompleteness, and race conditions with analysis data.

### Decision 4: Slack is fire-and-forget

`notify-escalation` returns 202 before Slack POST completes.

**Why:** Third-party notification latency must never block a warm transfer.

### Decision 5: Graceful degradation everywhere

Every tool returns a `fallback` string on error — explicit instruction for the agent to warm-transfer.

**Why:** The caller's experience must never depend on Airtable being up. A failed write ≠ a frozen agent.

### Decision 6: Exactly-once interaction records

Dual guard: in-memory lock + DB idempotency check on `call_id`.

**Why:** Retell fires `call_ended` and `call_analyzed` within milliseconds. Both can pass a naive idempotency check before either write completes.

### Decision 7: Thin routes, fat services

2Routes validate HTTP input and call services. All Airtable logic, timeouts, and normalization live in `airtable.js`.

**Why:** Testability, single place to swap Airtable for a real DB later.

---

## 13. Problems We Hit and How We Fixed Them

Use these as "war stories" in the interview — they show debugging ability.

### Problem 1: Inbound webhook DVs not reaching agent

**Symptom:** Agent didn't greet caller by name despite successful lookup.  
**Root cause:** Response was flat JSON instead of `{ call_inbound: { dynamic_variables: {...} } }` envelope.  
**Fix:** Wrap response in required Retell envelope. Configure on phone number level, not agent level.

### Problem 2: `from_number` was undefined

**Symptom:** Inbound webhook logged "unknown" caller.  
**Root cause:** Reading `req.body.from_number` — Retell nests it under `req.body.call_inbound.from_number`.  
**Fix:** Correct path extraction with fallback.

### Problem 3: Wrong AIRTABLE_BASE_ID on Render

**Symptom:** All lookups returned `found: false`.  
**Root cause:** Env var had table path suffix (`appXXX/tblYYY`) instead of base ID only.  
**Fix:** Added `env_check` to `/health` with `AIRTABLE_BASE_ID_has_slash` diagnostic flag.

### Problem 4: Duplicate interaction records

**Symptom:** Two Airtable rows for same `call_id`.  
**Root cause:** `call_ended` and `call_analyzed` fired within 30ms; both passed DB idempotency check before either write completed.  
**Fix:** In-memory `pendingWrites` Set as synchronous guard + 3s retry in Phase 2.

### Problem 5: Post-call analysis not enriching records

**Symptom:** Sentiment stuck at "Neutral", placeholder summary never replaced.  
**Root cause:** Phase 2 ran before Phase 1 write finished; update returned `not_found`.  
**Fix:** 3-second retry + switched Phase 2 to fetch from Retell Get Call API instead of webhook payload.

### Problem 6: `retell_llm_dynamic_variables` empty at call end

**Symptom:** `customer_id` blank in Airtable despite successful inbound identification.  
**Root cause:** Retell only persists DVs set via tool `response_variables`, not inbound webhook DVs.  
**Fix:** Fallback lookup using `from_number` in Phase 1 + transcript parsing in Phase 2.

### Problem 7: Unknown callers showing no phone in dashboard

**Symptom:** Dashboard showed "Unknown" with no phone for unrecognized numbers.  
**Root cause:** `from_number` missing on web test calls; not parsing spoken phone from transcript.  
**Fix:** `call_started` cache + parse `lookup_customer` phone arguments from transcript.

---

## 14. Security, PII, and Scope Guards


| Data                    | Handling                                                              |
| ----------------------- | --------------------------------------------------------------------- |
| `dob_last4`             | Never logged. Server-side comparison only.                            |
| Phone numbers           | Logged as `[REDACTED]` or length only                                 |
| `customer_id` on claims | Always required — structural scope guard                              |
| Inbound errors          | Return safe default, never expose stack traces to Retell              |
| Debug endpoints         | Unauthenticated — fine for demo, would gate behind auth in production |


**Scope guard code to memorize:**

```javascript
if (!customer_id) throw new Error('customer_id is required for getClaimStatus');
// Formula always includes customer_id — claim_id alone never works
```

---

## 15. What You Would Do Differently in Production

Interviewers love this question. Show you think beyond the take-home:


| Current (demo)                    | Production                                        |
| --------------------------------- | ------------------------------------------------- |
| Airtable                          | PostgreSQL or proper CRM with connection pooling  |
| In-memory cache                   | Redis with TTL                                    |
| In-memory phone cache / logs      | Redis or persistent store                         |
| No webhook signature verification | Verify Retell webhook signatures                  |
| Debug endpoints open              | Auth-gated or removed                             |
| Single Render instance            | Horizontal scaling with shared Redis for locks    |
| 8s Airtable timeout               | Circuit breaker pattern (e.g. opossum)            |
| Escalation reason in Slack only   | Also persist to Interactions or Escalations table |
| No retry queue                    | SQS/dead-letter queue for failed Airtable writes  |
| E.164 inconsistent                | Normalize to E.164 everywhere including Airtable  |


---

## 16. Interview Q&A — Likely Questions & Strong Answers

### Architecture & Design

**Q: Walk me through what happens when someone calls your agent.**

> A caller dials the Retell number. Before the agent speaks, Retell hits our inbound webhook with their phone number. We look them up in Airtable and return dynamic variables — customer ID, first name, whether they're known. During the call, the agent invokes our tool endpoints for authentication and claim lookup — every claim query requires a customer ID scoped server-side. When the call ends, Retell fires call_ended and call_analyzed to our post-call webhook. Phase 1 writes an initial interaction record immediately — even on hangups. Phase 2 fetches the full call from Retell's API and enriches the record with AI summary, sentiment, and parsed tool activity.

---

**Q: Why did you separate inbound webhook, tool webhooks, and post-call webhook?**

> They serve different lifecycle phases and have different Retell configuration points. The inbound webhook runs at the phone number level before the agent speaks — it needs a special response envelope for dynamic variables. Tool webhooks run during the conversation when the LLM decides to invoke an action. The agent webhook fires on lifecycle events after the call. Mixing them would create coupling and make error handling harder — a post-call write failure shouldn't affect mid-call claim lookups.

---

**Q: Why use a backend at all? Why not let Retell call Airtable directly?**

> Three reasons: security, reliability, and control. Security — DOB verification and claim scoping must happen server-side; you can't trust the LLM or client to enforce boundaries. Reliability — we wrap every Airtable call in an 8-second timeout and return structured fallbacks so the agent degrades gracefully. Control — idempotency, post-call pipeline orchestration, transcript parsing, and Slack fire-and-forget all require server-side logic that doesn't belong in a voice platform config.

---

### Post-Call Pipeline

**Q: Explain your post-call analysis pipeline.**

> It's two-phase. Phase 1 triggers on call_ended — we write an initial interaction record immediately with caller info, disconnection reason, and a placeholder summary. This guarantees every call gets a record, including mid-call hangups. Phase 2 triggers on call_analyzed — but instead of trusting the webhook payload, we call Retell's Get Call API for authoritative analysis data, then patch the existing Airtable record. We also parse the structured tool-call transcript to extract all customer IDs and claim IDs touched during multi-customer calls. There's a 3-second retry if Phase 2 runs before Phase 1 finishes writing.

---

**Q: How do you prevent duplicate interaction records?**

> Two layers. First, an in-memory Set tracks in-flight writes by call_id — if call_ended and call_analyzed arrive within milliseconds, the second write is blocked synchronously before hitting Airtable. Second, a DB-level check queries Airtable for an existing call_id before inserting. Updates in Phase 2 are idempotent patches, not inserts. Together this gives exactly-once semantics for inserts and at-least-once for enrichment.

---

**Q: What if Airtable is down when the call ends?**

> Phase 1 catches the error, logs it, and the call still completes normally — the caller never knows. We have a manual recovery path: GET /api/sync-call/:call_id fetches analysis from Retell's API and patches Airtable retroactively. In production I'd add a retry queue for failed writes.

---

### Security

**Q: How do you prevent one caller from accessing another customer's claims?**

> getClaimStatus always requires customer_id. The Airtable query uses AND({customer_id}, {claim_id}) — a claim ID belonging to another customer returns found:false. This is enforced in the backend service, not just the agent prompt. Even if someone social-engineered the agent into passing a wrong claim ID, the scope guard blocks it.

---

**Q: How do you handle PII?**

> DOB last-four is never logged — we log customer_id and `[REDACTED]` for DOB. Phone numbers are logged as length only in production-style logging. The verifyIdentity comparison happens entirely server-side; the agent never receives the stored DOB value.

---

### Integrations

**Q: How does Slack escalation work without blocking the transfer?**

> notify-escalation returns HTTP 202 immediately, then fires the Slack POST asynchronously with .catch() for error logging. The agent proceeds to warm transfer without waiting. If Slack is down, the transfer still happens — we log the failure but never propagate it to the caller.

---

**Q: What's the difference between request-callback and the post-call interaction write?**

> request-callback is an intentional mid-call write — the caller asks to be called back, we write to the Callbacks table immediately, and the agent reads back a reference number. The interaction record is post-call — written by the webhook pipeline after the call ends. We moved away from in-call interaction writes because the webhook pipeline survives hangups and doesn't depend on the agent calling a tool before hanging up.

---

### Retell-Specific

**Q: What are dynamic variables and how do you use them?**

> DVs are key-value pairs injected into the agent's context. We set them at call start via the inbound webhook — customer_found, customer_id, first_name. The agent uses them to skip asking for phone number when the caller is known. Important caveat: inbound webhook DVs aren't automatically persisted in retell_llm_dynamic_variables at call end — only tool response_variables are. We compensate with fallback phone lookup and transcript parsing in the post-call pipeline.

---

**Q: What happens with web test calls vs real PSTN calls?**

> Web test calls often don't have from_number in the Retell payload — no PSTN line. For those, we parse the phone number the caller spoke during lookup_customer tool invocations from the transcript. Real PSTN calls get from_number from call_started cache and call_ended payload.

---

### Demo & Reliability

**Q: What's the demo fail switch?**

> GET /demo/fail?duration=30 sets an in-memory flag that makes all tool routes return 500 with a fallback message for 30 seconds, then auto-recovers. During a live demo, I trigger this mid-call to show the agent receiving the fallback and warm-transferring instead of freezing or hallucinating. It proves graceful degradation is real, not just described in the README.

---

**Q: How would you scale this?**

> Tool routes are stateless — scale horizontally behind a load balancer. Replace in-memory cache and pendingWrites lock with Redis. Move post-call writes to an async queue so webhook handlers acknowledge instantly. Add connection pooling for the database. Verify Retell webhook signatures at the edge.

---

### Curveball Questions

**Q: What would you improve if you had another day?**

> Persist escalation reason/summary to Airtable, not just Slack. Add Retell webhook signature verification. Replace the in-memory phone cache with Redis for multi-instance deployments. Add structured logging (JSON) with call_id correlation across all log lines. Write integration tests for the post-call pipeline with mocked Retell payloads.

---

**Q: How do you handle a caller checking two different accounts in one call?**

> The agent re-runs full auth for each account. In post-call Phase 2, we parse transcript_with_tool_calls for every lookup_customer and get_claim_status tool result. We store customer_id as comma-separated values and claims_checked as all claim IDs touched. No agent changes needed — the data is already in the transcript.

---

**Q: Why Airtable instead of a real database?**

> For a take-home demo, Airtable gives a visible system of record the interviewer can inspect without running SQL. The architecture treats it as a data layer behind a service abstraction — swapping to PostgreSQL means changing airtable.js, not the routes or Retell config.

---

## 17. Demo Script — What to Show Live

**Order matters — tell a story:**

1. `**GET /health`** — show env_check, confirm Airtable configured
2. **Dashboard** — `https://observe-insurance-claims-agent.onrender.com/dashboard.html`
3. **Make a call** — known number greets by name; claim status returned
4. **Show interaction record** — click row, show summary, sentiment, claims checked
5. **Unknown number call** — show phone captured even without account
6. **Callback** — ask agent for callback, show Callbacks panel + reference number
7. **Escalation** — trigger human transfer, show Slack alert
8. **Fail mode** — `/demo/fail?duration=30`, call again, show graceful degradation
9. **Recover** — `/demo/recover`, show normal operation restored

---

## 18. Quick Reference Cheat Sheet

### Environment variables

```
AIRTABLE_TOKEN=       required
AIRTABLE_BASE_ID=     required (base ID only, no /table)
RETELL_API_KEY=       required for post-call API sync
SLACK_WEBHOOK_URL=    optional
RETELL_AGENT_ID=      optional (inbound routing override)
```

### All endpoints

```
GET  /health
GET  /demo/fail?duration=30
GET  /demo/recover
POST /webhook/inbound
POST /tools/lookup-customer
POST /tools/verify-identity
POST /tools/get-claim-status
POST /tools/request-callback
POST /tools/notify-escalation
POST /tools/write-interaction-record   (legacy)
POST /webhooks/call-end
GET  /webhooks/event-log
GET  /api/dashboard-data
GET  /api/callbacks
GET  /api/sync-call/:call_id
GET  /debug/test-slack
GET  /debug/inbound-log
```

### Numbers to remember

- **8 seconds** — Airtable timeout per call
- **15 minutes** — lookup cache TTL
- **3 seconds** — Phase 2 retry delay
- **20 events** — debug ring buffer size
- **202** — notify-escalation response code

### One-liners for design principles

- "Caller experience never depends on a write succeeding."
- "Auth is a server-side boundary, not a prompt instruction."
- "Phase 2 uses the Retell API, not the webhook payload."
- "Slack is fire-and-forget — transfer never waits."
- "call_id is the idempotency key — exactly-once inserts."

---

*Good luck tomorrow. You built something real — explain it as a system designed for reliability under failure, not just a happy-path demo.*