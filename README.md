# Observe Insurance — AI Claims Support Agent

A production-grade VoiceAI agent handling inbound insurance claim calls. Built on **Retell AI** with **Airtable** as the data layer and **Slack** for real-time escalation alerts.

## Architecture

Three Retell agents with shared authenticated state:

- **Triage / Auth Agent** — greets, authenticates (phone + DOB last-4), routes
- **Claims Agent** — retrieves and explains claim status, handles doc-required flow
- **FAQ Agent** — knowledge-base-grounded answers (hours, address, process)

Plus: warm-transfer escalation, emergency safety override, and idempotent post-call write-back.

## Integrations

| # | Integration | Direction | Purpose |
|---|---|---|---|
| 1 | Airtable (Customers + Claims) | READ | Authentication + claim status lookup |
| 2 | Airtable (Interactions) | WRITE | Post-call interaction record (idempotent) |
| 3 | Slack | WRITE | Real-time escalation alerts (fire-and-forget) |
| 4 | Retell Knowledge Base | READ | FAQ grounding |
| 5 | Retell Warm Transfer | — | Native human escalation with context |

## Backend Endpoints

```
GET  /health                → Service status + fail mode indicator
GET  /demo/fail?duration=30 → Simulate backend failure for N seconds (auto-recovers)
GET  /demo/recover          → Reset failure state immediately

POST /tools/lookup-customer        → Airtable Customers lookup by phone
POST /tools/verify-identity        → DOB last-4 verification (PII never logged)
POST /tools/get-claim-status       → Claim lookup scoped to authenticated customer_id
POST /tools/write-interaction-record → Idempotent post-call record write
POST /tools/notify-escalation      → Async Slack alert (never blocks transfer)

POST /webhooks/call-end    → Retell post-call webhook (fallback record writer)
```

## Tech Stack

- **Voice platform:** Retell AI (GPT-4o)
- **Telephony:** Retell's built-in Twilio
- **Data layer:** Airtable
- **Backend:** Node.js / Express, deployed on Render (Starter, always-on)
- **Notifications:** Slack incoming webhook

## Local Development

```bash
cp .env.example .env   # fill in your credentials
npm install
npm run dev
```

Required environment variables:

```
AIRTABLE_TOKEN=
AIRTABLE_BASE_ID=
RETELL_API_KEY=
SLACK_WEBHOOK_URL=     # optional until Phase 4
PORT=3000
```

## Production Design Decisions

**Auth is a boundary, not a step.** Authentication is established once in the Triage agent and carried as trusted state (`customer_id`, `verified: true`) to every specialist agent. The Claims Agent never accepts a caller-provided `claim_id` alone — every lookup is scoped to the authenticated `customer_id`.

**The interaction record is sacred.** It writes via two paths: (1) the agent calls `write_interaction_record` before hanging up, and (2) Retell's post-call webhook triggers a fallback write. Both paths are idempotent on `call_id` — exactly-once semantics.

**Graceful degradation everywhere.** Every tool call has an 8-second timeout and a structured fallback response that tells the agent to warm-transfer rather than freeze or hallucinate. The `/demo/fail` endpoint lets you trigger and recover from simulated backend failure live during a demo.

**PII boundary.** `dob_last4` is never logged. Phone numbers are logged only as length (redacted). The auth comparison happens server-side only.
