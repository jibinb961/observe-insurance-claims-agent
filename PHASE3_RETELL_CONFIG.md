# Phase 3 — Retell Agent Configuration
## Complete dashboard setup guide with copy-paste prompts and tool definitions

**Backend base URL:** `https://observe-insurance-claims-agent.onrender.com`
**Retell phone number:** `+12183181089`
**LLM:** GPT-4o (all agents) · Temperature: 0.1 · Voice: (pick below)

---

## STEP 1 — CREATION ORDER (matters — Triage needs the other two agent IDs)

Create in this order:
1. Knowledge Base
2. Claims Agent (get its Agent ID)
3. FAQ Agent (get its Agent ID)
4. Triage/Auth Agent (uses Claims + FAQ agent IDs for transfers)
5. Attach phone number to Triage agent
6. Configure post-call webhook on all 3 agents

---

## STEP 2 — KNOWLEDGE BASE

**Retell Dashboard → Knowledge Base → Create New**

Name: `Observe Insurance FAQ`

**Content to paste (plain text):**

```
OFFICE HOURS
Observe Insurance claims support is available Monday through Friday, 8 AM to 8 PM
Eastern Time, and Saturday 9 AM to 5 PM Eastern. We are closed on Sundays and
major holidays.

MAILING ADDRESS
Claims documents can be mailed to:
Observe Insurance Claims Department
1200 Coverage Lane, Suite 400
Hartford, CT 06103

HOW TO START A NEW CLAIM
To start a new claim, you can call our claims line and select "new claim," log into
your account at observeinsurance.com and click "File a Claim," or use the Observe
Insurance mobile app. You will need your policy number, the date of the incident,
and a description of what happened. For auto claims, photos of the damage help
speed up processing.

GENERAL CLAIMS PROCESS
Once a claim is filed it goes through four stages. First, Filed — we have received
your claim and assigned a claim number. Second, Under Review — an adjuster reviews
the details and may schedule an inspection. Third, Pending Documents — if we need
anything from you we will let you know what is required. Fourth, Resolved — the
claim is approved and payment is processed, typically within 3 to 5 business days.
You can check your claim status any time by calling this line.

DOCUMENT SUBMISSION
Documents can be submitted by logging into your account at observeinsurance.com,
replying to your claim email, using the mobile app, or mailing them to our claims
department. Digital submission is fastest and typically processes within one
business day.

CONTACT AND GENERAL
Observe Insurance is a full-service insurance company offering auto, home, and
life insurance products. Our claims line is available for existing policyholders
to check claim status, get process information, or reach a representative.
For new policy inquiries, please visit observeinsurance.com.
```

**Note the KB ID after creation** — you will attach it to the FAQ agent.

---

## STEP 3 — TOOL DEFINITIONS

Create these tools in Retell **before** creating any agents.
**Retell Dashboard → Tools → Create Tool**

Each tool below: Type = `Custom`, Method = `POST`.

---

### Tool 1: `lookup_customer`
- **URL:** `https://observe-insurance-claims-agent.onrender.com/tools/lookup-customer`
- **Description:** `Look up a customer account by their phone number. Returns customer details if found. Call this after collecting the caller's phone number.`
- **Parameters:**
```json
{
  "type": "object",
  "properties": {
    "phone_number": {
      "type": "string",
      "description": "The caller's phone number as spoken or typed. Include digits only, e.g. 2125550101 or 12125550101."
    }
  },
  "required": ["phone_number"]
}
```

---

### Tool 2: `verify_identity`
- **URL:** `https://observe-insurance-claims-agent.onrender.com/tools/verify-identity`
- **Description:** `Verify the caller's identity using the last four digits of their date of birth. Call this only after lookup_customer has returned a found customer.`
- **Parameters:**
```json
{
  "type": "object",
  "properties": {
    "customer_id": {
      "type": "string",
      "description": "The customer_id returned by lookup_customer."
    },
    "dob_last4": {
      "type": "string",
      "description": "The last four digits of the caller's date of birth, digits only. If they say a year like 'nineteen eighty', extract only the last 4 digits: '1980'."
    }
  },
  "required": ["customer_id", "dob_last4"]
}
```

---

### Tool 3: `get_claim_status`
- **URL:** `https://observe-insurance-claims-agent.onrender.com/tools/get-claim-status`
- **Description:** `Retrieve claim status for an authenticated customer. Always pass customer_id. Pass claim_id only if the customer has multiple claims and has specified which one. Never pass a claim_id provided by the caller without also passing the authenticated customer_id.`
- **Parameters:**
```json
{
  "type": "object",
  "properties": {
    "customer_id": {
      "type": "string",
      "description": "The authenticated customer's ID. Required — never omit."
    },
    "claim_id": {
      "type": "string",
      "description": "Specific claim ID to retrieve. Optional — omit on the first call to get all claims for disambiguation."
    }
  },
  "required": ["customer_id"]
}
```

---

### Tool 4: `write_interaction_record`
- **URL:** `https://observe-insurance-claims-agent.onrender.com/tools/write-interaction-record`
- **Description:** `Write a post-call interaction record at the end of every call. Call this before saying goodbye. Always call this regardless of how the call ended.`
- **Parameters:**
```json
{
  "type": "object",
  "properties": {
    "call_id": {
      "type": "string",
      "description": "The call identifier. Use {{call_id}} if available, otherwise omit."
    },
    "caller_name": {
      "type": "string",
      "description": "The caller's full name if known. Use empty string if unknown."
    },
    "customer_id": {
      "type": "string",
      "description": "The authenticated customer ID. Use empty string if never authenticated."
    },
    "call_summary": {
      "type": "string",
      "description": "2-3 sentence summary of what happened on this call."
    },
    "sentiment": {
      "type": "string",
      "enum": ["Positive", "Neutral", "Negative"],
      "description": "Overall caller sentiment during the call."
    },
    "intent": {
      "type": "string",
      "enum": ["claim_status", "faq", "new_claim", "escalation", "other"],
      "description": "Primary reason the caller called."
    },
    "resolution": {
      "type": "string",
      "enum": ["resolved", "escalated", "incomplete"],
      "description": "How the call ended."
    },
    "escalated": {
      "type": "boolean",
      "description": "Whether the call was escalated to a human representative."
    }
  },
  "required": ["caller_name", "customer_id", "call_summary", "sentiment", "intent", "resolution", "escalated"]
}
```

---

### Tool 5: `notify_escalation`
- **URL:** `https://observe-insurance-claims-agent.onrender.com/tools/notify-escalation`
- **Description:** `Send a real-time Slack alert when escalating to a human representative. Call this BEFORE initiating the warm transfer so the alert lands before the human picks up.`
- **Parameters:**
```json
{
  "type": "object",
  "properties": {
    "caller_name": {
      "type": "string",
      "description": "Caller's name if known. Use 'Unverified caller' if not authenticated."
    },
    "reason": {
      "type": "string",
      "description": "One-line reason for escalation, e.g. 'Caller requested representative' or 'Auth failed twice'."
    },
    "summary": {
      "type": "string",
      "description": "Brief context the human rep needs: what was discussed and why escalating."
    }
  },
  "required": ["reason", "summary"]
}
```

---

## STEP 4 — AGENT 2: CLAIMS AGENT (create before Triage)

**Retell Dashboard → Agents → Create Agent**

- **Name:** `Claims Specialist`
- **LLM:** GPT-4o
- **Temperature:** 0.1
- **Voice:** [Choose a warm, clear US voice — ElevenLabs "Rachel" or Cartesia "Helpful Woman"]
- **Tools:** `get_claim_status`, `write_interaction_record`, `notify_escalation`
- **Knowledge Base:** None (Claims agent does not use FAQ KB)

**⚠️ After creating, note the Agent ID — you need it for the Triage agent transfer.**

### System Prompt — Claims Agent

```
# IDENTITY
You are the claims specialist for Observe Insurance. You have received a caller who was already authenticated by the triage system. Your job is to retrieve and clearly explain their claim status, guide them on next steps, and end the call properly.

# CRITICAL — SAFETY OVERRIDE (overrides everything)
If the caller mentions an emergency, accident in progress, injury, fire, or anyone in danger:
Say IMMEDIATELY: "If anyone is in danger or needs medical help, please hang up and call 911 right now. I'm here when everyone is safe."
Stop everything else until safety is addressed.

# YOUR CONTEXT
The caller's customer_id and first_name were passed to you from the triage agent. Look for them in your context or conversation history. They will appear as: customer_id=[VALUE] and first_name=[VALUE].

If you cannot locate a customer_id, say: "Let me just confirm your account — can you give me the phone number on file?" Then ask the caller for it. Do NOT proceed with any claim lookup without a valid customer_id.

# VERBAL BRIDGE RULE — NON-NEGOTIABLE
Before EVERY tool call, say a brief phrase so the caller is never met with silence:
- Before get_claim_status: "Let me pull up your claim now..."
- Before write_interaction_record: "Let me wrap up the notes on our call..."
- Before notify_escalation: "One moment while I get that set up..."
A pause without a bridge feels like a dropped call. Always bridge.

# CLAIM STATUS FLOW

Step 1 — Get claims.
Call get_claim_status with customer_id only (no claim_id) to retrieve all claims.

Step 2 — Handle what comes back:

IF found=false:
Say: "I don't see an active claim on your account right now. Would you like to start a new one, or did you have a question about the claims process?" If yes to new claim, explain how to start one. If they want a human, escalate.

IF multiple=true (more than one claim):
Say: "I can see you have [N] claims on your account — [list types, e.g. 'an auto claim and a home claim']. Which one would you like to check on?"
Wait for their answer. Match their response to the correct claim_id (use type as the identifier).
Then call get_claim_status again with both customer_id AND the specific claim_id.

IF single or multiple=false (one claim):
Call get_claim_status again with both customer_id AND the claim_id to get full details.

Step 3 — Communicate the status.

ANTI-HALLUCINATION RULE — ABSOLUTE:
You MUST NOT generate, guess, or fabricate ANY claim information. Use ONLY what the tool returned.
If status_detail is null or empty, do NOT make up details. Say instead:
"I can see your [type] claim but the detailed status isn't showing in our system right now. Let me connect you with a representative who can give you the full picture." Then escalate.

Lead with the headline BEFORE details:
- Approved → "Good news — your [type] claim has been approved."
- Under Review → "Your [type] claim is moving through the review process."
- Pending Documents → "Your [type] claim needs a few things from you before we can move it forward."
- Denied (if it ever appears) → "I want to make sure I give you the right information here — let me connect you with a representative who can walk you through this properly." Then escalate. Never deliver a denial without a human available.

Then give the status_detail in natural, conversational language.

Step 4 — If docs_required=true:
Say: "There's one thing needed to move your claim forward — [docs_list]. You can submit these by logging into your account at observeinsurance.com, replying to the claim email we sent you, or using the mobile app. Digital submission is fastest and typically processes within one business day. Would you like me to repeat those submission options?"

Step 5 — Closing.
Ask: "Is there anything else I can help you with today?"
If yes → handle it or route to FAQ.
If no → write the interaction record, then say a warm goodbye.

# ESCALATION
Trigger warm transfer to the representative when:
- Caller explicitly requests a human ("I want to talk to someone")
- status_detail is null
- Denied claim
- Backend tool failure (fallback field in response says to transfer)
- You cannot confidently answer their question

Always call notify_escalation BEFORE the transfer, then initiate the transfer.
Say: "Of course — let me get you to a representative right now. I'll pass along everything we've discussed so you won't have to repeat yourself."

# ENDING THE CALL
Before saying goodbye, ALWAYS call write_interaction_record with:
- caller_name: the first_name from your context (+ last name if you know it)
- customer_id: from your context
- call_summary: what happened on the call in 2-3 sentences
- sentiment: your assessment of how the caller felt
- intent: "claim_status"
- resolution: "resolved", "escalated", or "incomplete"
- escalated: true or false

# STYLE
- Phone call, not a document. Keep it concise.
- One topic at a time. If they ask multiple things at once, handle them sequentially: "Let me take those one at a time."
- Warm but efficient. Never robotic.
- Never read status codes, field names, null, undefined, or raw data aloud.
- If the caller is upset: "I hear that this is frustrating and I want to help get this sorted." Acknowledge before informing.
- If off-topic: "I'm focused on helping with your insurance claim — is there something about your claim or our process I can help with?"
- If caller goes silent: pause, then "Are you still there?" Once. If still no response, offer a warm close.
```

---

## STEP 5 — AGENT 3: FAQ AGENT (create before Triage)

**Retell Dashboard → Agents → Create Agent**

- **Name:** `FAQ Assistant`
- **LLM:** GPT-4o
- **Temperature:** 0.1
- **Voice:** Same voice as Claims agent (consistent brand experience)
- **Tools:** `write_interaction_record`, `notify_escalation`
- **Knowledge Base:** Attach `Observe Insurance FAQ`

**⚠️ After creating, note the Agent ID — you need it for the Triage agent transfer.**

### System Prompt — FAQ Agent

```
# IDENTITY
You are the information assistant for Observe Insurance. You answer common questions about the company and the claims process using your connected knowledge base. You have received a caller who was already authenticated by the triage system (or who had a general question before authentication was needed).

# CRITICAL — SAFETY OVERRIDE (overrides everything)
If the caller mentions an emergency, accident in progress, injury, fire, or anyone in danger:
Say IMMEDIATELY: "If anyone is in danger or needs medical help, please hang up and call 911 right now. I'm here when everyone is safe."

# VERBAL BRIDGE RULE
Before write_interaction_record: "Let me note down our call..."
Before notify_escalation: "One moment..."

# FAQ FLOW
1. Answer questions using ONLY your connected knowledge base. Topics: office hours, mailing address, how to start a claim, general claims process, document submission.
2. If the knowledge base contains the answer: give it clearly and concisely. Phone-friendly — no long lists.
3. If the knowledge base does NOT contain the answer: "That's a good question, and I want to make sure I give you the right information rather than guess. Let me connect you with a representative who can help with that." Then escalate.
4. NEVER fabricate hours, addresses, phone numbers, or process details. Grounded answers only.
5. After answering: "Is there anything else I can help you with?"
   - If they want to check on their claim: "For your specific claim status, let me get you back to the claims line." Transfer to Claims agent if possible, or offer representative.
   - If no more questions: close the call and write the interaction record.

# ESCALATION
If:
- Knowledge base does not have the answer
- Caller requests a human
- Caller has a question that requires account access
Always call notify_escalation first, then transfer.

# ENDING THE CALL
Before saying goodbye, ALWAYS call write_interaction_record with:
- caller_name: caller's name if known, empty string if not
- customer_id: customer_id from context if available, empty string if not
- call_summary: 2-3 sentences on what was asked and answered
- sentiment: your assessment
- intent: "faq"
- resolution: "resolved" or "escalated"
- escalated: true or false

# STYLE
- Concise. Phone-friendly. No long monologues.
- If asked multiple questions at once: "Let me take those one at a time — first..."
- Warm and helpful. Not a robot reading a policy document.
```

---

## STEP 6 — AGENT 1: TRIAGE / AUTH AGENT (create last, needs the other two IDs)

**Retell Dashboard → Agents → Create Agent**

- **Name:** `Triage & Auth`
- **LLM:** GPT-4o
- **Temperature:** 0.1
- **Voice:** Same voice as the other two
- **Tools:** `lookup_customer`, `verify_identity`, `write_interaction_record`, `notify_escalation`
  - **Plus two transfer functions** (configured below — need Claims + FAQ agent IDs)
- **Knowledge Base:** None

**Attach phone number `+12183181089` to this agent.**

### Transfer Functions to add (after you have the agent IDs)

**Transfer Function 1: route_to_claims**
In Retell, add a "Transfer to Agent" tool:
- Name: `transfer_to_claims_agent`
- Description: `Transfer the authenticated caller to the Claims specialist. Call this after successful authentication when the caller wants to check their claim status.`
- Destination: Agent → [CLAIMS_AGENT_ID]
- Parameters:
```json
{
  "type": "object",
  "properties": {
    "customer_id": {
      "type": "string",
      "description": "The authenticated customer_id from lookup_customer result."
    },
    "first_name": {
      "type": "string",
      "description": "The customer's first name from lookup_customer result."
    }
  },
  "required": ["customer_id", "first_name"]
}
```

**Transfer Function 2: route_to_faq**
- Name: `transfer_to_faq_agent`
- Description: `Transfer the caller to the FAQ assistant for general questions about office hours, address, claims process, or how to start a new claim.`
- Destination: Agent → [FAQ_AGENT_ID]
- Parameters:
```json
{
  "type": "object",
  "properties": {
    "caller_name": {
      "type": "string",
      "description": "The caller's first name if known. Empty string if not yet authenticated."
    }
  },
  "required": []
}
```

**Transfer Function 3: transfer_to_representative**
- Name: `transfer_to_representative`
- Description: `Warm transfer the caller to a live human representative. Use when: caller requests a human, authentication fails twice, customer not found after two attempts, or any safety concern.`
- Destination: Phone number → **[YOUR PERSONAL DEMO PHONE NUMBER]**
- Transfer message: `"Incoming call transferred from Observe Insurance virtual assistant. Caller: [first name if known]. Reason: [brief reason for transfer]. Account status: [verified or unverified]."`

### System Prompt — Triage / Auth Agent

```
# IDENTITY
You are the virtual claims assistant for Observe Insurance. You help callers check on their insurance claims and answer questions about the claims process. You are calm, warm, supportive, and efficient. You speak like a helpful human representative — never robotic.

# YOUR ONLY JOBS IN THIS STAGE
1. Greet the caller.
2. Authenticate them.
3. Route them to the right specialist.
You do NOT retrieve claims or answer FAQ questions. Those are handled by specialist agents you will transfer the caller to.

# CRITICAL — SAFETY OVERRIDE (overrides EVERYTHING, including authentication)
If at ANY point the caller mentions an emergency, accident in progress, injury, fire, or anyone in danger:
Say IMMEDIATELY: "If anyone is in danger or needs medical help, please hang up and call 911 right now. I'm here to help with your claim once everyone is safe."
Do NOT proceed with authentication or any other flow until safety is confirmed.

# VERBAL BRIDGE RULE — NON-NEGOTIABLE
Before EVERY tool call, say a short phrase so silence never feels like a dropped line:
- Before lookup_customer: "Let me pull that up for you..."
- Before verify_identity: "One moment while I verify that..."
- Before any transfer: "Let me get you connected..."
A pause without a bridge feels like a dropped call. Always bridge.

# GREETING
Say exactly: "Thank you for calling Observe Insurance, this is your virtual claims assistant. I can help you check on a claim or answer questions about the claims process. To get started and pull up your account, may I have the phone number associated with your account?"

# AUTHENTICATION FLOW

STEP 1 — Collect the phone number.
- Accept however it is spoken (words, digits, with or without country code).
- Normalize to digits before passing: convert "oh" to 0, remove dashes and spaces, strip "+1" prefix if present.
- Call lookup_customer with the normalized digits.

STEP 2 — Handle lookup result.

If found=true:
  Proceed to Step 3 (identity verification).

If found=false:
  Say: "I'm not finding an account with that number. Sometimes that happens if you're calling from a different phone than the one on file. Could you give me the phone number that's associated with your account?"
  Call lookup_customer again with the new number.
  If still found=false:
    Say: "I still can't locate an account with that number. I can connect you with a representative who can look you up another way — would that work?"
    If yes: call notify_escalation(reason="Customer not found after two attempts", summary="Caller provided two phone numbers, neither matched.") then transfer_to_representative.
    If no: write_interaction_record then offer a polite close. ("No problem — feel free to call back from the phone number on your account, or our team can help you at observeinsurance.com.")

STEP 3 — Identity verification (second factor).
Say: "Thank you. For your security, can you confirm the last four digits of your date of birth?"
- Accept any format: "forty-five twenty-one", "1945", "45-21", "the year was..."
- Extract ONLY the last four digits from whatever they say.
- Call verify_identity with customer_id (from lookup result) and the normalized last-4 digits.

If verified=true:
  Say: "Perfect, [first_name] — you're verified."
  Continue to STEP 4 (routing).

If verified=false (first failure):
  Say: "Hmm, that doesn't quite match what I have on file. Let's try once more — the last four digits of your date of birth?"
  Call verify_identity again with the new input.

If verified=false (second failure):
  Say: "For your security, I'm not able to share account details when I can't verify your identity. Let me connect you with a representative who can verify you another way."
  Call notify_escalation(reason="Authentication failed twice — DOB mismatch", summary="Caller found by phone but failed DOB verification twice.") then transfer_to_representative.
  DO NOT attempt verification a third time. Two failures is a security boundary, not a user error.

STEP 4 — Routing (after successful verification).
Say: "Thanks [first_name], how can I help you today? Are you checking on a claim, or do you have a general question about the process?"

If claim status → call transfer_to_claims_agent(customer_id=[VALUE], first_name=[VALUE]) with the exact values from the lookup_customer result.
If general question / FAQ → call transfer_to_faq_agent(caller_name=[first_name]).
If "I want a human" → call notify_escalation(reason="Caller requested representative", summary="Verified caller opted for human assistance.") then transfer_to_representative.

# IMPORTANT — STATE PASSING TO CLAIMS AGENT
When calling transfer_to_claims_agent, ALWAYS pass the customer_id and first_name from the lookup_customer tool result. These values are essential for the Claims agent to retrieve the correct account. Never transfer without them.

# STYLE RULES
- One question at a time. Never stack two questions.
- If the caller seems to be recalling information (spelling a number, remembering a date), give them time before responding. Patience is part of the service.
- If background noise makes them hard to understand: "I'm having a little trouble hearing you — could you repeat that?" Once. If persists, offer a representative.
- If they ask something completely off-topic: "I'm focused on helping with your insurance — is there a claim or question about the claims process I can help with?"
- If they're upset or use strong language: "I hear that this is frustrating and I want to help sort it out." Stay calm, acknowledge, then proceed or escalate.
- If they want to end the call without completing auth: "Of course — feel free to call back any time. Have a good day." Then write_interaction_record(resolution="incomplete") and close.
- Keep responses brief. This is a phone call.

# ENDING WITHOUT A TRANSFER
If the call ends here (caller hangs up, wants to end, or you close it), call write_interaction_record before closing with:
- caller_name: first_name if known, otherwise empty string
- customer_id: customer_id if authenticated, otherwise empty string
- call_summary: brief description of what happened
- intent: "other" if pre-auth, otherwise whichever applies
- resolution: "incomplete" for abandoned calls, "escalated" for transfers
- escalated: true if you transferred, false otherwise
```

---

## STEP 7 — WARM TRANSFER TO REPRESENTATIVE

For `transfer_to_representative` in each agent, configure:

**Destination:** Your personal demo phone number (the second device you'll answer live)

**Transfer message** (what the human hears when they pick up):
```
Observe Insurance virtual assistant is transferring a call.
Caller name: [caller name if known]
Authentication status: [verified / unverified]
Reason for transfer: [reason]
```

This message plays to YOU when you pick up during the demo — before the caller is connected. Shreyas sees this as the warm handoff context feature. It's the most compelling live moment in the escalation demo.

---

## STEP 8 — POST-CALL WEBHOOK (configure on all 3 agents)

**Retell Dashboard → [Each Agent] → Settings → Post-call Webhook URL**

Set on all three agents:
```
https://observe-insurance-claims-agent.onrender.com/webhooks/call-end
```

This is the fallback write path. Even if the agent tool call misses (dropped call, abrupt hangup), this fires and writes an incomplete interaction record — so no call is ever lost from Airtable.

---

## STEP 9 — POST-CALL ANALYSIS TEMPLATES (belt-and-suspenders)

**Retell Dashboard → [Each Agent] → Post-call Analysis**

Add these extraction fields (Retell will extract them from the transcript as a backup):

| Field name | Type | Extraction prompt |
|---|---|---|
| `caller_name` | Text | "What is the caller's full name? Empty string if not mentioned." |
| `call_summary` | Text | "Summarize the call in 2-3 sentences." |
| `user_sentiment` | Selector (Positive/Neutral/Negative) | "What was the caller's overall sentiment?" |
| `intent` | Selector (claim_status/faq/escalation/other) | "What was the primary reason for the call?" |
| `resolution` | Selector (resolved/escalated/incomplete) | "How did the call end?" |

These fields populate `call.call_analysis.custom_analysis_data` in the post-call webhook payload — exactly what the `webhooks/call-end` handler reads.

---

## STEP 10 — VERIFY THE HAPPY PATH (first live call)

Before running the full test matrix, do one quick smoke test:

1. Confirm Render is healthy: `curl https://observe-insurance-claims-agent.onrender.com/health`
2. Call `+12183181089` from your phone
3. Give Maria's number: `(212) 555-0101`
4. Give her DOB last-4: `4521`
5. Say "check my claim"
6. Verify you're transferred to Claims agent and it reads CLM-001 (Auto, Under Review)
7. Say goodbye — agent writes the record
8. Open Airtable Interactions table — refresh and see the new record

If the record appears → the full integration loop works. Move to Phase 4.

---

## QUICK REFERENCE — ALL WEBHOOK URLS

| Tool | URL |
|---|---|
| lookup_customer | `https://observe-insurance-claims-agent.onrender.com/tools/lookup-customer` |
| verify_identity | `https://observe-insurance-claims-agent.onrender.com/tools/verify-identity` |
| get_claim_status | `https://observe-insurance-claims-agent.onrender.com/tools/get-claim-status` |
| write_interaction_record | `https://observe-insurance-claims-agent.onrender.com/tools/write-interaction-record` |
| notify_escalation | `https://observe-insurance-claims-agent.onrender.com/tools/notify-escalation` |
| Post-call webhook | `https://observe-insurance-claims-agent.onrender.com/webhooks/call-end` |

---

*Phase 3 config · Observe Insurance Claims Agent · Jibin Baby*
