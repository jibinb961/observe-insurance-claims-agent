# Observe Insurance — AI Claims Support Agent

A production-grade VoiceAI agent for inbound insurance claims support. Built for the Observe.AI take-home assessment: authenticate callers, retrieve claim status, answer FAQs, escalate to humans, and persist a complete post-call record to an external system.

**Live backend:** `https://observe-insurance-claims-agent.onrender.com`  
**Operations dashboard:** `https://observe-insurance-claims-agent.onrender.com/dashboard.html`

---

## Table of Contents

1. [Platform Overview](#platform-overview)
2. [Architecture](#architecture)
3. [Retell Agent Design](#retell-agent-design)
4. [Call Flows](#call-flows)
5. [Post-Call Analysis Pipeline](#post-call-analysis-pipeline)
6. [Integrations](#integrations)
7. [Airtable Data Model](#airtable-data-model)
8. [Backend API Reference](#backend-api-reference)
9. [Environment Variables](#environment-variables)
10. [Retell Configuration Checklist](#retell-configuration-checklist)
11. [Operations Dashboard](#operations-dashboard)
12. [Security & PII](#security--pii)
13. [Demo & Resilience Features](#demo--resilience-features)
14. [Local Development](#local-development)
15. [Deployment](#deployment)
16. [Project Structure](#project-structure)
17. [Design Decisions](#design-decisions)

---

## Platform Overview

| Layer | Technology | Role |
|---|---|---|
| Voice platform | Retell AI (Conversational Flow, Rigid Mode) | Speech, LLM orchestration, telephony, warm transfer |
| LLM | GPT-4o (temperature ~0.1) | Intent routing, tool use, natural responses |
| Telephony | Retell built-in (Twilio-backed) | Inbound PSTN + web test calls |
| Data layer | Airtable | Customers, Claims, Interactions, Callbacks |
| Backend | Node.js 18+ / Express | Tool webhooks, inbound hook, post-call pipeline |
| Hosting | Render (Starter, always-on) | Production deployment |
| Notifications | Slack Incoming Webhook | Real-time escalation alerts |
| Knowledge base | Retell KB | FAQ grounding (hours, address, process) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CALLER (PSTN / Web)                            │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RETELL AI PLATFORM                                │
│  ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐  │
│  │ Phone Number    │   │ Auth Triage Agent│   │ Post-Call Analysis       │  │
│  │ Inbound Webhook │──▶│ (Conversational  │──▶│ call_ended / call_analyzed│  │
│  │ (call start)    │   │  Flow + sub-agents)│  │ + custom extraction vars │  │
│  └────────┬────────┘   └────────┬─────────┘   └────────────┬─────────────┘  │
│           │                     │                          │                │
│           │              Tool calls during call            │                │
└───────────┼─────────────────────┼──────────────────────────┼────────────────┘
            │                     │                          │
            ▼                     ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    NODE.JS BACKEND (Express on Render)                      │
│                                                                             │
│  POST /webhook/inbound          POST /tools/*           POST /webhooks/call-end
│  (pre-populate DVs)             (lookup, verify,        (two-phase write +
│                                  claims, callback,       Retell API enrich)
│                                  notify-escalation)
│                                                                             │
│  GET  /dashboard.html           GET  /api/dashboard-data                    │
│  GET  /api/sync-call/:id        GET  /debug/*                             │
└───────────┬─────────────────────────────┬───────────────────┬───────────────┘
            │                             │                   │
            ▼                             ▼                   ▼
     ┌─────────────┐              ┌─────────────┐    ┌─────────────┐
     │  Airtable   │              │ Retell API  │    │   Slack     │
     │  (4 tables) │              │ GET /v2/    │    │  Webhook    │
     │             │              │ get-call    │    │             │
     └─────────────┘              └─────────────┘    └─────────────┘
```

### Request lifecycle

1. **Call starts** — Retell hits `POST /webhook/inbound` with `from_number`. Backend looks up the caller in Airtable and returns dynamic variables (`customer_found`, `customer_id`, `first_name`).
2. **During call** — Retell sub-agents invoke backend tools (`lookup-customer`, `verify-identity`, `get-claim-status`, `request-callback`, `notify-escalation`).
3. **Call ends** — Retell fires `call_ended` and `call_analyzed` to `POST /webhooks/call-end`. Backend writes an initial interaction record, then auto-fetches full analysis from the Retell Get Call API and enriches Airtable.
4. **Escalation** — Agent calls `notify-escalation` (Slack alert, fire-and-forget) then warm-transfers to a human number.

---

## Retell Agent Design

The agent is implemented as a **single Conversational Flow agent** (`Auth Triage Agent`) with specialized sub-agent nodes — not three separate Retell agents. This keeps routing, shared state, and tool definitions in one place.

### Sub-agents (flow nodes)

| Node | Purpose |
|---|---|
| **Main Router** | Greets caller, routes by intent (claims / FAQ / escalation) |
| **Auth Agent** | Phone lookup, DOB last-4 verification, supports re-auth for a second account mid-call |
| **Extract Variables** | Captures `dob_last_four` from speech |
| **Verify Identity** | Calls `verify_identity` tool |
| **Claims Sub Agent** | Auto-calls `get_claim_status`, handles single/multi-claim disambiguation, `request_callback` |
| **FAQ Sub Agent** | KB-grounded answers; escalates when KB cannot answer |
| **Escalation Agent** | Gathers context, calls `notify_escalation`, routes to transfer |
| **Transfer Call** | Warm transfer to human (`+16179349090` in demo config) |
| **End Call** | Graceful hangup |

### Retell tools (backend webhooks)

| Tool name | Endpoint | When used |
|---|---|---|
| `lookup_customer` | `POST /tools/lookup-customer` | Auth — find account by phone |
| `verify_identity` | `POST /tools/verify-identity` | Auth — DOB last-4 check |
| `get_claim_status` | `POST /tools/get-claim-status` | Claims — scoped to authenticated `customer_id` |
| `request_callback` | `POST /tools/request-callback` | In-call write — schedule callback (Callbacks table) |
| `notify_escalation` | `POST /tools/notify-escalation` | Escalation — Slack alert before transfer |
| `write_interaction_record` | `POST /tools/write-interaction-record` | Legacy in-call write (superseded by webhook pipeline) |

### Dynamic variables

| Variable | Source | Purpose |
|---|---|---|
| `customer_found` | Inbound webhook | `"true"` / `"false"` — skip phone ask if known |
| `customer_id` | Inbound webhook or `lookup_customer` | Scoped claim lookups |
| `first_name` | Inbound webhook or `lookup_customer` | Personalised greeting |
| `dob_last_four` | Extract Variables node | Passed to `verify_identity` |
| `call_id` | Retell system | Idempotency key for interaction records |
| `user_number` | Retell system | Caller's phone (for callback tool) |

> **Important:** Inbound webhook DVs are used at call start but are **not** automatically persisted in `retell_llm_dynamic_variables` at call end unless a tool sets them via `response_variables`. The backend compensates by parsing `transcript_with_tool_calls` and falling back to `from_number` lookup.

---

## Call Flows

### Standard authenticated claims call

```
Caller → Main Router → Auth Agent
  → lookup_customer(phone)
  → extract dob_last_four
  → verify_identity
  → Claims Sub Agent
  → get_claim_status(customer_id)
  → [answer + optional request_callback]
  → End Call
```

### Anonymous FAQ call (no authentication)

```
Caller → Main Router → FAQ Sub Agent
  → KB answer
  → End Call (no customer_id in Interactions — expected)
```

### Multi-customer call (same session)

The agent re-runs full auth when the caller asks about a different account. The backend records **all** customer IDs and claim IDs touched by parsing tool results from the call transcript during post-call enrichment.

Example: caller checks CUST004 (CLM-005), then CUST001 (CLM-001, CLM-002) → `customer_id` stored as `CUST004, CUST001`, `claims_checked` as `CLM-005, CLM-001, CLM-002`.

### Escalation flow

```
Any sub-agent (upset caller / auth failed / KB gap / system error)
  → Escalation Agent
  → notify_escalation (Slack alert — async, non-blocking)
  → Transfer Call (warm transfer)
  → disconnection_reason: call_transfer → resolution: escalated
```

---

## Post-Call Analysis Pipeline

Every call produces an Airtable interaction record via a **two-phase webhook pipeline**. No manual sync is required under normal operation.

### Phase 1 — `call_ended` (immediate)

Triggered when the call hangs up (natural end, user hangup, transfer, etc.).

| Input | Used for |
|---|---|
| `call_id` | Primary key (idempotent write) |
| `from_number` | `caller_phone` + fallback customer lookup |
| `disconnection_reason` | Initial `resolution` inference |
| `retell_llm_dynamic_variables` | `customer_id`, `caller_name`, `intent` (if set by tools) |

Writes an initial record with placeholder summary and `sentiment: Neutral`. Phase 2 overwrites analysis fields.

### Phase 2 — `call_analyzed` (auto-sync via Retell API)

`call_analyzed` is used as a **trigger only**. The handler does not trust the webhook payload alone — it calls:

```
GET https://api.retellai.com/v2/get-call/{call_id}
Authorization: Bearer {RETELL_API_KEY}
```

From the API response it extracts:

| Source | Airtable fields |
|---|---|
| `call_analysis.call_summary` | `call_summary` |
| `call_analysis.user_sentiment` | `sentiment` |
| `call_analysis.call_successful` | `resolution` |
| `call_analysis.custom_analysis_data.*` | `intent`, `caller_name`, `claims_checked`, etc. |
| `transcript_with_tool_calls` (parsed) | `customer_id` (all IDs), `claims_checked` (all claim IDs) |
| `from_number` | `caller_phone` |

**Race handling:** `call_analyzed` often arrives before Phase 1 finishes writing. The handler retries the Airtable patch after 3 seconds, then creates a fallback record if still missing.

### Three ways to consume Retell analysis data

| Method | Implementation | Use case |
|---|---|---|
| **Webhook** | `POST /webhooks/call-end` | Real-time, automatic (primary) |
| **Get Call API** | Called inside `call_analyzed` handler + `GET /api/sync-call/:call_id` | Authoritative data + manual recovery |
| **Retell Dashboard** | Built-in | Operator review during demos |

### Recommended Retell post-call extraction variables

Configure under **Agent → Post-Call Analysis → Add Variable**:

| Variable | Type | Example prompt |
|---|---|---|
| `intent` | Enum | `claim_status`, `faq`, `callback_request`, `escalation`, `other` |
| `caller_name` | String | Name the caller provided during the call |
| `claims_checked` | String | Comma-separated claim IDs discussed (e.g. `CLM-001, CLM-002`) |

Built-in Retell fields (`call_summary`, `user_sentiment`, `call_successful`) are mapped automatically — no custom config needed.

---

## Integrations

| # | System | Direction | Trigger | Purpose |
|---|---|---|---|---|
| 1 | Airtable — Customers | READ | `lookup-customer`, inbound webhook | Caller identification |
| 2 | Airtable — Customers | READ | `verify-identity` | DOB last-4 verification |
| 3 | Airtable — Claims | READ | `get-claim-status` | Claim status (scoped by `customer_id`) |
| 4 | Airtable — Interactions | WRITE | Post-call webhooks | Interaction records (idempotent on `call_id`) |
| 5 | Airtable — Callbacks | WRITE | `request-callback` tool | Mid-call callback scheduling |
| 6 | Slack | WRITE | `notify-escalation` tool | Escalation alerts (fire-and-forget) |
| 7 | Retell — Inbound webhook | IN | Call start (phone number level) | Pre-populate caller DVs |
| 8 | Retell — Agent webhook | IN | `call_ended`, `call_analyzed`, `call_started` | Post-call pipeline |
| 9 | Retell — Get Call API | READ | `call_analyzed` handler, sync endpoint | Authoritative post-call analysis |
| 10 | Retell — Knowledge Base | READ | FAQ sub-agent | Grounded FAQ answers |
| 11 | Retell — Warm Transfer | OUT | Transfer Call node | Human escalation |

---

## Airtable Data Model

Base ID is set via `AIRTABLE_BASE_ID`. Phone numbers are stored as **11-digit US format** (e.g. `16179349090`) — no `+` prefix.

### Table: `Customers`

| Field | Type | Notes |
|---|---|---|
| `customer_id` | Single line text | Primary business key (e.g. `CUST001`) |
| `first_name` | Single line text | |
| `last_name` | Single line text | |
| `phone` | Single line text | Normalized 11-digit format |
| `dob_last4` | Single line text | Last 4 digits of DOB — never returned to agent or logs |

### Table: `Claims`

| Field | Type | Notes |
|---|---|---|
| `claim_id` | Single line text | e.g. `CLM-001` |
| `customer_id` | Single line text | Scope guard — must match authenticated caller |
| `type` | Single select | Auto, Home, etc. |
| `status` | Single select | Under Review, Pending Documents, etc. |
| `status_detail` | Long text | Spoken explanation for the agent |
| `docs_required` | Checkbox | |
| `docs_list` | Multiple select | Required document types |
| `last_updated` | Date / text | |

### Table: `Interactions`

One record per call. Primary key: `call_id` (Retell call ID).

| Field | Type | Notes |
|---|---|---|
| `call_id` | Single line text | **Idempotency key** — one record per call |
| `timestamp` | Date/time (ISO) | Written at Phase 1 |
| `caller_name` | Single line text | May be blank for anonymous/web test calls |
| `caller_phone` | Single line text | PSTN `from_number`; blank on web test calls |
| `customer_id` | Single line text | Single ID or comma-separated for multi-customer calls |
| `claims_checked` | Single line text | Comma-separated claim IDs accessed during call |
| `call_summary` | Long text | Retell AI summary (Phase 2) |
| `sentiment` | Single select | Positive, Neutral, Negative |
| `intent` | Single line text | claim_status, faq, callback_request, escalation, other |
| `resolution` | Single line text | resolved, incomplete, escalated |
| `escalated` | Single select | `Yes` when transferred; omitted when false |

### Table: `Callbacks`

| Field | Type | Notes |
|---|---|---|
| `callback_id` | Single line text | Auto-generated `CB-{timestamp}` |
| `customer_id` | Single line text | Authenticated caller |
| `caller_name` | Single line text | |
| `phone` | Single line text | From `{{user_number}}` |
| `preferred_time` | Single line text | Free-form ("next available", "tomorrow AM") |
| `reason` | Long text | Why callback was requested |
| `status` | Single select | Default: `Pending` |
| `created_at` | Date/time (ISO) | |

---

## Backend API Reference

Base URL: `https://observe-insurance-claims-agent.onrender.com`

### Health & status

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service status, uptime, env check (masked), fail mode |
| `GET` | `/demo/fail?duration=30` | Enable simulated tool failure for N seconds |
| `GET` | `/demo/recover` | Disable fail mode immediately |

### Retell inbound webhook (phone number level)

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook/inbound` | Call-start hook — returns `{ call_inbound: { dynamic_variables: {...} } }` |

**Required response envelope:**
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

All DV values must be **strings**. Set `RETELL_AGENT_ID` in env to include `override_agent_id`.

### Retell tool webhooks

| Method | Path | Required body fields | Response |
|---|---|---|---|
| `POST` | `/tools/lookup-customer` | `phone_number` | `{ found, customer_id?, first_name?, last_name? }` |
| `POST` | `/tools/verify-identity` | `customer_id`, `dob_last4` | `{ verified: true/false }` |
| `POST` | `/tools/get-claim-status` | `customer_id`, `claim_id?` | Single, multi, or not-found shape (see below) |
| `POST` | `/tools/request-callback` | `customer_id`, `preferred_time`, `reason?` | `{ success, callback_id, message }` |
| `POST` | `/tools/notify-escalation` | `caller_name`, `reason`, `summary` | `202 { notified: true }` — Slack async |
| `POST` | `/tools/write-interaction-record` | `call_id`, metadata fields | `{ written: true/false }` — legacy |

**`get-claim-status` response shapes:**

```json
// Single claim
{ "found": true, "single": true, "claim_id": "CLM-005", "type": "Auto", "status": "Under Review", "status_detail": "...", "docs_required": false, "docs_list": "", "last_updated": "" }

// Multiple claims (no claim_id param)
{ "found": true, "multiple": true, "claims": [{ "claim_id": "CLM-001", "type": "Auto", "status": "...", "status_detail": "..." }] }

// Not found
{ "found": false }
```

All tool endpoints return a `fallback` string on error so the agent can warm-transfer instead of freezing. Timeout: **8 seconds** per Airtable call.

### Retell post-call webhook (agent level)

| Method | Path | Events handled |
|---|---|---|
| `POST` | `/webhooks/call-end` | `call_started` (logged), `call_ended` (Phase 1), `call_analyzed` (Phase 2 + API sync) |
| `GET` | `/webhooks/event-log` | Debug ring buffer — last 20 webhook events |

Always responds `200` immediately to avoid Retell retries.

### Dashboard & ops APIs

| Method | Path | Description |
|---|---|---|
| `GET` | `/dashboard.html` | Contact center operations UI |
| `GET` | `/api/dashboard-data` | Health, today's stats, recent interactions, inbound log |
| `GET` | `/api/callbacks` | Recent callback requests |
| `GET` | `/api/sync-call/:call_id` | Manual Retell API sync → patch Airtable record |

### Debug endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/debug/inbound-log` | Last 20 inbound webhook calls (in-memory) |
| `GET` | `/debug/test-slack` | Fire a test escalation alert to Slack |

---

## Environment Variables

Create a `.env` file in the project root:

```bash
# Required
AIRTABLE_TOKEN=pat...          # Airtable personal access token
AIRTABLE_BASE_ID=app...        # Base ID only — NOT a table URL or path

# Strongly recommended
RETELL_API_KEY=key_...         # Enables post-call API auto-sync + manual sync endpoint

# Optional
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...   # Escalation alerts
RETELL_AGENT_ID=agent_...      # Included in inbound webhook as override_agent_id
PORT=3000                      # Default: 3000
```

| Variable | Required | Purpose |
|---|---|---|
| `AIRTABLE_TOKEN` | Yes | Airtable API authentication |
| `AIRTABLE_BASE_ID` | Yes | Target base (must not include `/` or table name) |
| `RETELL_API_KEY` | Recommended | Phase 2 auto-sync + `/api/sync-call` recovery |
| `SLACK_WEBHOOK_URL` | Optional | Escalation notifications via `notify-escalation` |
| `RETELL_AGENT_ID` | Optional | Forces agent routing from inbound webhook |
| `PORT` | Optional | Server port (Render sets this automatically) |

---

## Retell Configuration Checklist

### Phone number settings

| Setting | Value |
|---|---|
| Inbound Webhook URL | `https://observe-insurance-claims-agent.onrender.com/webhook/inbound` |
| Inbound Call Agent | Leave blank if using `RETELL_AGENT_ID` in backend env |

### Agent global settings

| Setting | Value |
|---|---|
| Post-call Webhook URL | `https://observe-insurance-claims-agent.onrender.com/webhooks/call-end` |
| Post-Call Analysis variables | `intent`, `caller_name`, `claims_checked` (recommended) |

### Tool URLs (all POST)

```
https://observe-insurance-claims-agent.onrender.com/tools/lookup-customer
https://observe-insurance-claims-agent.onrender.com/tools/verify-identity
https://observe-insurance-claims-agent.onrender.com/tools/get-claim-status
https://observe-insurance-claims-agent.onrender.com/tools/request-callback
https://observe-insurance-claims-agent.onrender.com/tools/notify-escalation
```

### Slack setup

1. [api.slack.com/apps](https://api.slack.com/apps) → Create App → Incoming Webhooks → ON
2. Add webhook to a channel (e.g. `#escalations`)
3. Set `SLACK_WEBHOOK_URL` in Render env
4. Verify: `GET /debug/test-slack`

---

## Operations Dashboard

**URL:** `/dashboard.html`

### Features

| Section | Description |
|---|---|
| **Stat cards** | Calls today, resolved, escalated, fail mode status |
| **Recent Interactions** | Click any row → slide-in detail drawer |
| **Call detail drawer** | Full summary, sentiment, resolution, caller phone, customer IDs, claims checked badges, inline Retell sync |
| **Callback Requests** | Records from `request-callback` in-call tool |
| **Inbound Call Log** | Last 20 phone-level webhook hits (in-memory) |
| **Demo Controls** | Trigger/recover backend failure, Slack test, customer lookup |
| **Status bar** | Backend, Slack, Airtable connectivity |

Auto-refreshes every 30 seconds. Press `Esc` to close the call detail drawer.

---

## Security & PII

| Data | Handling |
|---|---|
| `dob_last4` | Never logged. Comparison server-side only. |
| Phone numbers | Logged as `[REDACTED]` or length only in production logs |
| `customer_id` scope | `get-claim-status` always requires `customer_id` — cross-customer claim access is structurally impossible |
| Auth boundary | Identity verified once per account session; re-auth required for a different phone number |
| Idempotency | Interaction writes keyed on `call_id` — duplicate webhook events do not create duplicate records |
| Race guard | In-memory `pendingWrites` Set prevents concurrent Phase 1/2 double-inserts |

---

## Demo & Resilience Features

### Graceful degradation

Every tool endpoint catches errors and returns a structured `fallback` message instructing the agent to warm-transfer. The caller experience never depends on Airtable or Slack succeeding.

### Live failure simulation

```bash
# Inject 30s of 500 errors on all /tools/* endpoints
curl "https://observe-insurance-claims-agent.onrender.com/demo/fail?duration=30"

# Recover immediately
curl "https://observe-insurance-claims-agent.onrender.com/demo/recover"
```

Also available from the dashboard Demo Controls panel.

### Resolution inference (Phase 1)

| `disconnection_reason` | `resolution` |
|---|---|
| `agent_hangup` | resolved |
| `call_transfer` | escalated |
| `user_hangup`, `inactivity`, `dial_no_answer`, etc. | incomplete |

Phase 2 may override with Retell's `call_successful` boolean.

---

## Local Development

```bash
git clone <repo-url>
cd observe-insurance-claims-agent

# Create .env with required variables (see above)
npm install
npm run dev    # nodemon on port 3000
```

Verify:

```bash
curl http://localhost:3000/health
open http://localhost:3000/dashboard.html
```

For Retell to reach local endpoints during development, use a tunnel (ngrok, Cloudflare Tunnel, etc.) and point tool/webhook URLs to the tunnel URL.

---

## Deployment

Deployed on **Render** (Starter plan, always-on).

| Step | Action |
|---|---|
| 1 | Connect GitHub repo to Render Web Service |
| 2 | Build command: `npm install` |
| 3 | Start command: `npm start` |
| 4 | Set all environment variables in Render dashboard |
| 5 | Update Retell tool + webhook URLs to Render URL |
| 6 | Hit `/health` and `/debug/test-slack` before demo |

Render URL: `https://observe-insurance-claims-agent.onrender.com`

---

## Project Structure

```
observe-insurance-claims-agent/
├── public/
│   └── dashboard.html          # Contact center operations UI
├── src/
│   ├── index.js                  # Express app, inbound webhook, dashboard APIs
│   ├── routes/
│   │   ├── tools.js              # Retell tool webhook handlers
│   │   └── webhooks.js           # Post-call pipeline (call_ended + call_analyzed)
│   ├── services/
│   │   ├── airtable.js           # All Airtable read/write operations
│   │   ├── slack.js              # Escalation notifications
│   │   └── cache.js              # In-memory session cache for lookups
│   └── demo/
│       └── failSwitch.js         # Live demo failure injection
├── Auth_Triage_Agent-4.json      # Retell agent export (reference)
├── PHASE3_RETELL_CONFIG.md       # Detailed Retell setup guide
├── PHASE3_CONVERSATION_FLOW.md   # Flow design notes
├── package.json
└── README.md
```

---

## Design Decisions

**Auth is a boundary, not a step.** Authentication is established per account in the Auth Agent. Claims lookups always require `customer_id`. A caller-provided `claim_id` alone cannot retrieve another customer's data.

**Post-call writes belong in the webhook pipeline, not in-call tools.** The `call_ended` + `call_analyzed` two-phase pipeline survives mid-call hangups, agent errors, and transfers. The in-call write tool (`write-interaction-record`) is legacy; `request-callback` demonstrates intentional mid-call writes.

**Authoritative analysis comes from the Retell API.** The `call_analyzed` webhook is a trigger. The handler fetches `GET /v2/get-call/:call_id` for complete, settled analysis data rather than relying on webhook payload timing.

**Multi-customer calls are a first-class edge case.** Customer IDs and claim IDs are extracted from `transcript_with_tool_calls` — every `lookup_customer` and `get_claim_status` tool result during the call — and stored as comma-separated values. No agent prompt changes required.

**Slack never blocks transfer.** `notify-escalation` returns `202 Accepted` immediately, then sends the Slack message asynchronously. A Slack outage does not delay the warm transfer.

**Exactly-once interaction records.** DB-level idempotency on `call_id` plus an in-memory write lock prevents duplicate records when `call_ended` and `call_analyzed` fire within milliseconds of each other.

**Anonymous callers are valid.** FAQ callers with no authentication produce interaction records with blank `customer_id` — by design. `caller_phone` from PSTN fills the identity gap in production.

---

## Production Hardening & Interview Prep

This project includes comprehensive documentation for production readiness and technical interview preparation:

### Critical Improvements Implemented

**✅ Airtable Rate Limit Handling**
- Token bucket rate limiter (4 req/sec, burst of 8) in `src/services/rateLimiter.js`
- Exponential backoff retry logic with jitter (100ms, 200ms, 400ms)
- Handles 429 rate limit errors and transient network failures automatically
- No changes to Retell agent configuration required

**✅ Retell Webhook Signature Verification**
- HMAC-SHA256 signature verification in `src/routes/webhooks.js`
- Prevents spoofed webhook requests from polluting analytics
- Returns 401 for invalid signatures
- Graceful fallback for development (when `RETELL_API_KEY` not set)

**✅ PII Security Audit**
- Verified `dob_last4` never appears in logs (PII boundary)
- Removed debug logging that could expose customer data
- Phone numbers redacted in inbound webhook logs: `+***9090`
- All error paths documented with security implications

**✅ Code Quality Improvements**
- Function-level documentation for all endpoints
- Error path comments explaining fallback behavior
- No redundant or obvious comments
- Clear variable naming throughout

### Documentation

- **[`PRODUCTION_HARDENING.md`](./PRODUCTION_HARDENING.md)** — Comprehensive 10-question production review
  - Phone number normalization and fallback strategies
  - Voice agent quality evaluation metrics (LLM-as-judge, containment rate, turn analysis)
  - Complete error handling inventory with gaps analysis
  - Rate limiting and Airtable scalability solutions
  - Integration discovery framework (5-question checklist)
  - Security hardening (signature verification, PII audit)
  - Code quality pass on all core files
  - End-to-end code walkthrough (line-by-line)
  - Dashboard as production tool
  - "What would you do differently?" with honest assessment

- **[`PRODUCTION_HARDENING_SUMMARY.md`](./PRODUCTION_HARDENING_SUMMARY.md)** — Quick reference
  - Changes implemented vs production TODOs
  - Testing instructions
  - Key metrics to quote in interview
  - Final preparation checklist

- **[`BACKEND_INTERVIEW_GUIDE.md`](./BACKEND_INTERVIEW_GUIDE.md)** — Deep technical walkthrough
  - File-by-file explanation of every module
  - Tool call flow (from Retell → backend → Airtable → response)
  - Post-call pipeline internals
  - Probable interview questions with strong answers

- **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** — Visual diagrams
  - 8 Mermaid diagrams for interview presentation
  - System context, internal modules, call lifecycle
  - Post-call pipeline, idempotency guards, multi-customer handling

### Production TODOs (Interview Talking Points)

**Scalability:**
- Replace Airtable with Postgres (5 req/sec → 1000+ req/sec)
- Replace in-memory cache with Redis (shared across instances)
- Add Dead Letter Queue for failed writes (zero data loss)
- Circuit breaker pattern for database outages

**Quality Evaluation:**
- LLM-as-judge framework (automated quality scoring per call)
- Grafana dashboards (containment rate, tool latency, escalation reasons)
- Real-time alerting (Slack when metrics degrade)

**Robustness:**
- Levenshtein distance matching for ASR mishears
- Last-4 phone lookup tool for partial numbers
- Name + DOB compound lookup as fallback

---

## Additional Documentation

- [`PHASE3_RETELL_CONFIG.md`](./PHASE3_RETELL_CONFIG.md) — Step-by-step Retell dashboard setup, tool definitions, copy-paste prompts
- [`PHASE3_CONVERSATION_FLOW.md`](./PHASE3_CONVERSATION_FLOW.md) — Conversation flow design notes
- [`Auth_Triage_Agent-4.json`](./Auth_Triage_Agent-4.json) — Exported Retell agent configuration

---

## License

Built as a take-home assessment project for Observe.AI.
