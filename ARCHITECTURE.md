# Architecture Diagrams — Observe Insurance Claims Agent

Use these Mermaid diagrams in your interview. They render on GitHub, in VS Code/Cursor, and at [mermaid.live](https://mermaid.live).

**Tip for presenting:** Start with Diagram 1 (big picture), then zoom into Diagram 3 (call lifecycle), then Diagram 4 (post-call pipeline) when they ask about persistence.

---

## Diagram 1 — System Context (Start Here)

High-level view: who talks to whom.

```mermaid
flowchart TB
    subgraph External["External Actors"]
        Caller(["📞 Caller<br/>(PSTN / Web Test)"])
        Rep(["👤 Human Rep<br/>(Warm Transfer)"])
        Ops(["🖥 Ops / Interviewer<br/>(Dashboard)"])
    end

    subgraph Retell["Retell AI Platform"]
        Phone["Phone Number<br/>+ Inbound Webhook"]
        Agent["Conversational Flow Agent<br/>(Auth · Claims · FAQ · Escalation)"]
        PCA["Post-Call Analysis<br/>(summary · sentiment · custom vars)"]
        KB["Knowledge Base<br/>(FAQ grounding)"]
        Transfer["Warm Transfer"]
    end

    subgraph Backend["Node.js Backend · Render"]
        Express["Express API"]
    end

    subgraph Data["External Systems"]
        AT[("Airtable<br/>Customers · Claims<br/>Interactions · Callbacks")]
        Slack["Slack<br/>Escalation Alerts"]
        RetellAPI["Retell Get Call API<br/>GET /v2/get-call/:id"]
    end

    Caller --> Phone
    Phone --> Agent
    Agent --> KB
    Agent --> Transfer
    Transfer --> Rep

    Phone -->|"POST /webhook/inbound<br/>(call start)"| Express
    Agent -->|"POST /tools/*<br/>(during call)"| Express
    Agent -->|"POST /webhooks/call-end<br/>(call lifecycle)"| Express

    Express --> AT
    Express --> Slack
    Express --> RetellAPI
    RetellAPI -.->|"analysis data"| Express

    PCA -.->|"call_ended · call_analyzed"| Express
    Ops -->|"GET /dashboard.html<br/>GET /api/*"| Express
```

---

## Diagram 2 — Backend Internal Modules

How the Express app is organized inside `src/`.

```mermaid
flowchart LR
    subgraph Entry["src/index.js"]
        Health["/health"]
        Inbound["POST /webhook/inbound"]
        DashAPI["/api/dashboard-data<br/>/api/sync-call/:id"]
        Demo["/demo/fail · /demo/recover"]
        Static["public/dashboard.html"]
    end

    subgraph Routes["Routes"]
        Tools["routes/tools.js<br/>6 tool endpoints"]
        Webhooks["routes/webhooks.js<br/>post-call pipeline"]
    end

    subgraph Services["Services"]
        AT["services/airtable.js<br/>all DB I/O · 8s timeout"]
        Slack["services/slack.js<br/>fire-and-forget alerts"]
        Activity["services/callActivity.js<br/>phone resolve · transcript parse"]
        Cache["services/cache.js<br/>lookup TTL cache"]
    end

    subgraph DemoMod["Demo"]
        Fail["demo/failSwitch.js<br/>simulated 500s"]
    end

    Inbound --> AT
    DashAPI --> AT
    DashAPI --> Activity
    Tools --> Fail
    Tools --> AT
    Tools --> Slack
    Tools --> Cache
    Webhooks --> AT
    Webhooks --> Activity
    Webhooks --> RetellAPI["Retell API"]
```

---

## Diagram 3 — Full Call Lifecycle (Sequence)

Walk through this when asked *"what happens when someone calls?"*

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller
    participant R as Retell Agent
    participant IB as POST /webhook/inbound
    participant T as POST /tools/*
    participant WH as POST /webhooks/call-end
    participant AT as Airtable
    participant API as Retell Get Call API
    participant SL as Slack

    Note over C,R: PHASE 0 — Call Start
    C->>R: Inbound call
    R->>IB: from_number
    IB->>AT: lookupCustomer(phone)
    AT-->>IB: customer_id, first_name (or not found)
    IB-->>R: dynamic_variables (customer_found, customer_id, first_name)
    R->>C: Greet (by name if known)

    Note over C,R: PHASE 1 — During Call
    alt Claims flow
        R->>T: lookup_customer(phone)
        T->>AT: lookupCustomer
        AT-->>T: found / not found
        T-->>R: result
        R->>T: verify_identity(customer_id, dob_last4)
        T->>AT: verifyIdentity (DOB never logged)
        AT-->>T: verified: true/false
        T-->>R: result
        R->>T: get_claim_status(customer_id)
        T->>AT: getClaimStatus (scoped by customer_id)
        AT-->>T: claim(s) + status_detail
        T-->>R: result
        R->>C: Explain claim status
    else FAQ flow
        R->>R: Answer from Knowledge Base
    else Escalation
        R->>T: notify_escalation(reason, summary)
        T->>SL: async Slack alert
        T-->>R: 202 Accepted (immediate)
        R->>C: Warm transfer to human
    else Callback
        R->>T: request_callback(...)
        T->>AT: createCallbackRequest
        AT-->>T: callback_id CB-XXXXXX
        T-->>R: message + reference number
        R->>C: Confirm callback logged
    end

    Note over C,R: PHASE 2 — Call End
    R->>WH: event=call_started
    WH->>WH: cache call_id → from_number
    R->>WH: event=call_ended
    WH->>AT: writeInteractionRecord (Phase 1)
    Note right of AT: placeholder summary<br/>resolution from disconnect reason
    R->>WH: event=call_analyzed
    WH->>API: GET /v2/get-call/:call_id
    API-->>WH: call_analysis + transcript_with_tool_calls
    WH->>WH: parse customers, claims, phone
    WH->>AT: updateInteractionRecord (Phase 2 enrich)
    Note right of AT: real summary · sentiment<br/>claims_checked · caller_phone
```

---

## Diagram 4 — Post-Call Two-Phase Pipeline

Deep dive for *"how do interaction records get written?"*

```mermaid
flowchart TD
    Start(["Retell fires webhooks<br/>to POST /webhooks/call-end"])

    Start --> CS{event type?}

    CS -->|call_started| Cache["Cache from_number<br/>keyed by call_id<br/>(callActivity.js)"]
    Cache --> Ack1["Return 200 immediately"]

    CS -->|call_ended| P1["Phase 1: handleCallEnded"]

    P1 --> P1A["Resolve caller_phone<br/>(from_number · cache · spoken)"]
    P1A --> P1B["Resolve customer_id / name<br/>(DVs · fallback lookup)"]
    P1B --> P1C["Infer resolution from<br/>disconnection_reason"]
    P1C --> P1D["writeInteractionRecord<br/>idempotent on call_id"]
    P1D --> Lock{"pendingWrites<br/>+ DB check"}
    Lock -->|new record| Create["Create Interactions row<br/>(placeholder summary)"]
    Lock -->|exists / in flight| Skip["Skip duplicate"]
    Create --> Ack2["Return 200 immediately"]
    Skip --> Ack2

    CS -->|call_analyzed| P2["Phase 2: handleCallAnalyzed"]

    P2 --> Fetch["GET Retell API<br/>/v2/get-call/:call_id"]
    Fetch --> Parse["Parse call_analysis<br/>+ transcript_with_tool_calls"]
    Parse --> Patch["Build patch:<br/>summary · sentiment · resolution<br/>customer_id(s) · claims_checked<br/>caller_phone"]
    Patch --> Update["updateInteractionRecord"]
    Update --> Found{record exists?}
    Found -->|yes| Enrich["Patch Airtable row ✓"]
    Found -->|no| Wait["Wait 3 seconds<br/>(Phase 1 still writing)"]
    Wait --> Retry["Retry update"]
    Retry --> StillMissing{found?}
    StillMissing -->|yes| Enrich
    StillMissing -->|no| Fallback["Create fallback record<br/>from API data"]
    Enrich --> Ack3["Return 200 immediately"]
    Fallback --> Ack3

    style P1 fill:#eff6ff,stroke:#2563eb
    style P2 fill:#f0fdf4,stroke:#16a34a
    style Create fill:#fffbeb,stroke:#d97706
    style Enrich fill:#f0fdf4,stroke:#16a34a
```

---

## Diagram 5 — Tool Endpoints & Data Access

Security and read/write boundaries — good for *"what does each tool do?"*

```mermaid
flowchart TB
    subgraph RetellTools["Retell Tool Invocations"]
        direction TB
        LC["lookup_customer"]
        VI["verify_identity"]
        GCS["get_claim_status"]
        RC["request_callback"]
        NE["notify_escalation"]
        WIR["write_interaction_record<br/>(legacy)"]
    end

    subgraph BackendTools["POST /tools/*"]
        direction TB
        E1["/tools/lookup-customer"]
        E2["/tools/verify-identity"]
        E3["/tools/get-claim-status"]
        E4["/tools/request-callback"]
        E5["/tools/notify-escalation"]
        E6["/tools/write-interaction-record"]
    end

    subgraph AirtableTables["Airtable"]
        Customers[("Customers<br/>READ")]
        Claims[("Claims<br/>READ · scoped")]
        Interactions[("Interactions<br/>WRITE")]
        Callbacks[("Callbacks<br/>WRITE")]
    end

    SlackNode["Slack"]

    LC --> E1 --> Customers
    VI --> E2 --> Customers
    GCS --> E3 --> Claims
    RC --> E4 --> Callbacks
    NE --> E5 --> SlackNode
    WIR --> E6 --> Interactions

    subgraph Guards["Enforced in Backend"]
        G1["customer_id REQUIRED<br/>for all claim lookups"]
        G2["dob_last4 NEVER logged"]
        G3["8s timeout + fallback<br/>on every Airtable call"]
        G4["notify-escalation returns 202<br/>before Slack POST"]
    end
```

---

## Diagram 6 — Idempotency & Race Condition Guards

For *"how do you prevent duplicate records?"*

```mermaid
flowchart LR
    subgraph Events["Nearly simultaneous events"]
        CE["call_ended"]
        CA["call_analyzed"]
    end

    CE --> W1["writeInteractionRecord"]
    CA --> W2["updateInteractionRecord"]

    subgraph Guard1["Guard 1 — In-memory lock"]
        PW["pendingWrites Set<br/>blocks concurrent INSERT<br/>for same call_id"]
    end

    subgraph Guard2["Guard 2 — DB idempotency"]
        DB["Airtable query:<br/>call_id already exists?<br/>→ skip INSERT"]
    end

    subgraph Guard3["Guard 3 — Phase 2 retry"]
        RT["Record not found?<br/>wait 3s → retry PATCH<br/>→ fallback CREATE"]
    end

    W1 --> PW --> DB
    W2 --> RT

    Result(["Exactly-once INSERT<br/>At-least-once PATCH<br/>(idempotent)"])
    DB --> Result
    RT --> Result
```

---

## Diagram 7 — Graceful Degradation

For *"what happens when Airtable is down?"*

```mermaid
flowchart TD
    ToolCall(["Retell invokes tool"])

    ToolCall --> FailSwitch{Demo fail mode<br/>active?}
    FailSwitch -->|yes| Sim500["Return 500 + fallback message<br/>'Let me connect you with a representative'"]
    FailSwitch -->|no| AirtableCall["Call Airtable service<br/>(8 second timeout)"]

    AirtableCall --> OK{Success?}
    OK -->|yes| Happy["Return structured JSON<br/>to LLM"]
    OK -->|timeout / error| Fallback["Return found:false or verified:false<br/>+ fallback string"]

    Sim500 --> Agent["Agent reads fallback<br/>→ warm transfer"]
    Fallback --> Agent
    Happy --> Agent

    subgraph PostCall["Post-call (separate path)"]
        WH["Webhook write fails"] --> Log["Log error — caller unaffected"]
        Sync["GET /api/sync-call/:id"] --> Recover["Manual recovery<br/>from Retell API"]
    end
```

---

## Diagram 8 — Multi-Customer Call Handling

For *"what if one call checks two accounts?"*

```mermaid
flowchart TD
    Call(["Single call · one call_id"])

    Call --> Auth1["Auth account 1<br/>lookup_customer → CUST004<br/>get_claim_status → CLM-005"]
    Call --> Auth2["Auth account 2<br/>lookup_customer → CUST001<br/>get_claim_status → CLM-001, CLM-002"]
    Call --> CB["request_callback → CB-151073"]

    Auth1 --> Transcript["Retell stores all tool calls in<br/>transcript_with_tool_calls"]
    Auth2 --> Transcript
    CB --> CallbacksTable[("Callbacks table<br/>separate in-call write")]

    Transcript --> Phase2["Phase 2: parseCallActivity()"]
    Phase2 --> Record[("Interactions row<br/>call_id: call_xxx<br/>customer_id: CUST004, CUST001<br/>claims_checked: CLM-005, CLM-001, CLM-002<br/>caller_phone: from_number or spoken")]

    style Record fill:#f0fdf4,stroke:#16a34a
```

---

## How to Use in the Interview

| When they ask… | Show diagram |
|---|---|
| "Give me the big picture" | **Diagram 1** — System Context |
| "How is the code organized?" | **Diagram 2** — Backend Modules |
| "Walk me through a call" | **Diagram 3** — Sequence (step through numbered steps) |
| "How does post-call analysis work?" | **Diagram 4** — Two-Phase Pipeline |
| "What are your tools / integrations?" | **Diagram 5** — Tools & Data Access |
| "Duplicate records / race conditions?" | **Diagram 6** — Idempotency Guards |
| "What if the backend fails?" | **Diagram 7** — Graceful Degradation |
| "Edge cases?" | **Diagram 8** — Multi-Customer Call |

### Export for slides

1. Copy any diagram block (without the ` ```mermaid ` fences) into [mermaid.live](https://mermaid.live)
2. Export as PNG or SVG
3. Paste into Google Slides / Keynote

### Render in Cursor / VS Code

Open this file and use Markdown preview — Mermaid renders natively in most editors.

---

## Related Docs

- [`BACKEND_INTERVIEW_GUIDE.md`](./BACKEND_INTERVIEW_GUIDE.md) — Full narrative + Q&A
- [`README.md`](./README.md) — Platform specifications & API reference
