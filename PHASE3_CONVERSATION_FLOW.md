# Phase 3 — Retell Conversational Flow (Rigid Mode)
## Node structure for all 3 agents

**Mode: RIGID (not Flex) — mandatory**
Flex Mode = single-prompt agent with a GUI. Rigid Mode = true deterministic flow.
If you see a toggle for "Flex / Rigid" in the dashboard, set it to Rigid.

---

## DYNAMIC VARIABLES (DVs) — Define before building nodes

Set these as agent-level variables with their defaults.
DVs persist through the call and pass between nodes.

### Triage Agent DVs
| Variable | Type | Default | Purpose |
|---|---|---|---|
| `customer_found` | Boolean | false | Set by lookup_customer result |
| `customer_id` | String | "" | Set by lookup_customer result |
| `first_name` | String | "" | Set by lookup_customer result |
| `last_name` | String | "" | Set by lookup_customer result |
| `phone_attempts` | Number | 0 | Tracks phone lookup retries (cap at 1) |
| `dob_attempts` | Number | 0 | Tracks DOB verification retries (cap at 1) |
| `is_verified` | Boolean | false | Set by verify_identity result |
| `caller_intent` | String | "" | Set at routing: "claim_status" / "faq" / "human" |
| `escalation_reason` | String | "" | Populated before any escalation transfer |
| `resolution` | String | "incomplete" | Tracks call outcome |
| `escalated` | Boolean | false | Set true before any human transfer |

### Claims Agent DVs
| Variable | Type | Default | Purpose |
|---|---|---|---|
| `customer_id` | String | "" | **Passed from Triage via transfer** |
| `first_name` | String | "" | **Passed from Triage via transfer** |
| `claim_count` | Number | 0 | Set from get_claim_status result |
| `claim_list` | String | "" | JSON list of claims for disambiguation |
| `selected_claim_id` | String | "" | Set after disambiguation |
| `selected_claim_type` | String | "" | Set after disambiguation |
| `claim_status` | String | "" | Set from get_claim_status result |
| `status_detail` | String | "" | Set from get_claim_status result |
| `docs_required` | Boolean | false | Set from get_claim_status result |
| `docs_list` | String | "" | Set from get_claim_status result |
| `resolution` | String | "incomplete" | resolved / escalated / incomplete |
| `escalated` | Boolean | false | |

### FAQ Agent DVs
| Variable | Type | Default | Purpose |
|---|---|---|---|
| `caller_name` | String | "" | Passed from Triage if known |
| `customer_id` | String | "" | Passed from Triage if authenticated |
| `resolution` | String | "incomplete" | |
| `escalated` | Boolean | false | |

---

## GLOBAL PROMPT (applies to all nodes in the agent)
Set this as the agent-level "Global Prompt" in Retell.
This gives every node context without bloating individual node instructions.

### All agents share this base:
```
You are the virtual claims assistant for Observe Insurance. You are calm, warm, and efficient. Speak like a helpful human representative — never robotic. Keep responses concise; this is a phone call.

SAFETY OVERRIDE — triggers before any other logic:
If the caller mentions an emergency, accident, injury, fire, or anyone in danger:
Immediately say: "If anyone is in danger, please hang up and call 911 right now. I'm here when everyone is safe." Then stop the current flow.

STYLE:
- Before every tool call or pause, say a brief bridge: "Let me look that up...", "One moment...", "Let me pull that up for you..."
- Never read field names, null, undefined, or raw data aloud.
- One question at a time. Never stack two questions.
- If the caller is angry: "I hear that this is frustrating — I want to help sort this out."
```

---

## AGENT 1: TRIAGE / AUTH AGENT

**Total nodes: 16 (within rigid mode's reliable range)**
**Phone number attached:** +12183181089

### GLOBAL NODES (reachable from any node)

#### G1: EMERGENCY_OVERRIDE [Global Conversation Node]
**Trigger condition:** Caller says anything containing: emergency, accident, fire, injured, hurt, danger, 911, help me
```
Say: "If anyone is in danger or needs medical help, please hang up and call 911 right now. I'm here to help with your claim once everyone is safe. Are you and everyone around you safe?"
```
Edges:
- [caller confirms safety] → GREETING (restart)
- [silence or continued distress] → TRANSFER_TO_HUMAN

---

#### G2: HUMAN_REQUESTED [Global Conversation Node]
**Trigger condition:** Caller says: "I want a human", "transfer me", "speak to someone", "representative", "real person", "agent"
```
Say: "Of course — let me connect you with a representative right now."
```
- Set DV: `escalated` = true, `escalation_reason` = "Caller requested representative", `resolution` = "escalated"
Edges:
- [always] → NOTIFY_ESCALATION_FN

---

#### G3: SILENCE_HANDLER [Global Conversation Node]
**Trigger condition:** Caller has been silent for 8+ seconds
```
Say: "Are you still there? Take your time — I'm here when you're ready."
```
Edges:
- [caller responds] → (return to previous node context)
- [silence again] → POLITE_CLOSE

---

### MAIN FLOW NODES

#### N1: GREETING [Conversation Node]
**This is the Start Node.**
```
Say: "Thank you for calling Observe Insurance, this is your virtual claims assistant. I can help you check on a claim or answer questions about the claims process. To get started and pull up your account securely, may I have the phone number associated with your account?"
```
Edges:
- [caller provides a phone number] → N2: COLLECT_AND_LOOKUP
- [caller says they don't have an account / asks a general question] → N11: TRANSFER_TO_FAQ

---

#### N2: COLLECT_AND_LOOKUP [Subagent Node]
**Attached tool:** `lookup_customer`
**Extract DVs from tool response:**
- `customer_found` ← response.found
- `customer_id` ← response.customer_id (empty string if not found)
- `first_name` ← response.first_name (empty string if not found)
- `last_name` ← response.last_name (empty string if not found)

```
Instruction:
The caller has just provided their phone number. Your only job in this node:
1. If they haven't given it clearly yet, ask: "And what's the phone number associated with your account?"
2. Once you have it, say "Let me pull that up for you..." then call lookup_customer with the phone number.
   - Normalize before calling: convert spoken words to digits (oh=0, zero=0), strip spaces and dashes, remove country code prefix if present.
3. Wait for the result. Do not say anything else until the tool responds.
4. Do NOT speak the result — just end the node. The next node handles the response.
```
Edges:
- [`customer_found` == true] → N4: VERIFY_DOB
- [`customer_found` == false AND `phone_attempts` < 1] → N3: PHONE_NOT_FOUND_RETRY
- [`customer_found` == false AND `phone_attempts` >= 1] → N5: NOT_FOUND_ESCALATE_CONFIRM
- [tool response contains "error" or "fallback"] → N13: SYSTEM_ERROR_ESCALATE

---

#### N3: PHONE_NOT_FOUND_RETRY [Conversation Node]
- Set DV: `phone_attempts` = 1
```
Say: "I'm not finding an account with that number. Sometimes that happens if you're calling from a different phone than the one on file. Could you give me the phone number that's associated with your account?"
```
Edges:
- [caller provides another number] → N2: COLLECT_AND_LOOKUP (loops back, second attempt)
- [caller says they don't know / doesn't have one] → N5: NOT_FOUND_ESCALATE_CONFIRM

---

#### N4: VERIFY_DOB [Subagent Node]
**Attached tool:** `verify_identity`
**Extract DVs from tool response:**
- `is_verified` ← response.verified

```
Instruction:
Say: "Thank you. For your security, can you confirm the last four digits of your date of birth?"
Once the caller responds, say "One moment..." then call verify_identity with:
  - customer_id: {{customer_id}} (from the lookup result)
  - dob_last4: the last 4 digits of what the caller said
    Normalization: if they say a year ("nineteen eighty"), extract the last 4 digits: "1980"
    If they say "forty-five twenty-one", interpret as digits: "4521"
    Strip all non-digits, take the last 4.
Do NOT speak the result — the next node handles it.
```
Edges:
- [`is_verified` == true] → N7: ROUTE_INTENT
- [`is_verified` == false AND `dob_attempts` < 1] → N5b: DOB_RETRY
- [`is_verified` == false AND `dob_attempts` >= 1] → N6: AUTH_FAIL_ESCALATE
- [tool response contains "error" or "fallback"] → N13: SYSTEM_ERROR_ESCALATE

---

#### N5: NOT_FOUND_ESCALATE_CONFIRM [Conversation Node]
- Set DV: `escalation_reason` = "Customer not found after two attempts", `resolution` = "escalated", `escalated` = true
```
Say: "I still can't locate an account with that number. I can connect you with a representative who can look you up another way — would that work?"
```
Edges:
- [caller agrees / yes] → N14: NOTIFY_ESCALATION_FN
- [caller declines / no] → N16: WRITE_RECORD_FN → N17: POLITE_CLOSE

---

#### N5b: DOB_RETRY [Conversation Node]
- Set DV: `dob_attempts` = 1
```
Say: "Hmm, that doesn't quite match what I have on file. Let's try once more — can you give me the last four digits of your date of birth?"
```
Edges:
- [caller provides digits again] → N4: VERIFY_DOB (loops back, second attempt)
- [caller says they can't remember / doesn't know] → N6: AUTH_FAIL_ESCALATE

---

#### N6: AUTH_FAIL_ESCALATE [Conversation Node]
- Set DV: `escalation_reason` = "DOB verification failed twice", `resolution` = "escalated", `escalated` = true
```
Say: "For your security, I'm not able to share account details when I can't verify your identity. Let me connect you with a representative who can verify you another way — they can use a different method to confirm who you are."
```
Edges:
- [always] → N14: NOTIFY_ESCALATION_FN

---

#### N7: ROUTE_INTENT [Conversation Node]
```
Say: "Perfect, {{first_name}} — you're verified. How can I help you today? Are you checking on a claim, or do you have a general question about the claims process?"
```
Edges:
- [caller says claim / status / check my claim / my insurance] → N8: SET_INTENT_CLAIMS
- [caller says general question / hours / address / how do I / process / FAQ-type] → N9: SET_INTENT_FAQ
- [caller asks for human / representative] → G2: HUMAN_REQUESTED (global)
- [unclear] → stay in N7 (ask again, max 2 turns)

---

#### N8: SET_INTENT_CLAIMS [Logic Split Node]
- Set DV: `caller_intent` = "claim_status"
- Condition: always true (this is just a DV setter before transfer)
Edges:
- [always] → N10: TRANSFER_TO_CLAIMS

---

#### N9: SET_INTENT_FAQ [Logic Split Node]
- Set DV: `caller_intent` = "faq"
Edges:
- [always] → N11: TRANSFER_TO_FAQ

---

#### N10: TRANSFER_TO_CLAIMS [Transfer Agent Node]
**Destination:** Claims Agent (use Claims Agent ID)
**Pass these DVs to receiving agent:**
- `customer_id` → Claims agent's `customer_id`
- `first_name` → Claims agent's `first_name`
- `is_verified` → Claims agent verifies this is true before proceeding
```
Handoff message: "Verified caller {{first_name}} — customer_id: {{customer_id}}. Authenticated via phone + DOB. Ready for claims lookup."
```
No edge (transfer ends this agent's involvement)

---

#### N11: TRANSFER_TO_FAQ [Transfer Agent Node]
**Destination:** FAQ Agent (use FAQ Agent ID)
**Pass these DVs:**
- `first_name` → FAQ agent's `caller_name`
- `customer_id` → FAQ agent's `customer_id`
No edge

---

#### N12: TRANSFER_TO_HUMAN [Call Transfer Node — Warm]
**Destination phone:** [YOUR PERSONAL DEMO PHONE NUMBER]
**Transfer message:** "Observe Insurance transfer. Caller: {{first_name}} {{last_name}}. Status: {{is_verified ? 'Verified' : 'Unverified'}}. Reason: {{escalation_reason}}"
No edge

---

#### N13: SYSTEM_ERROR_ESCALATE [Conversation Node]
- Set DV: `escalation_reason` = "Backend system error", `resolution` = "escalated", `escalated` = true
```
Say: "I'm having trouble accessing our system right now. Let me connect you with a representative who can help directly."
```
Edges:
- [always] → N14: NOTIFY_ESCALATION_FN

---

#### N14: NOTIFY_ESCALATION_FN [Function Node — fire and forget]
**URL:** POST `https://observe-insurance-claims-agent.onrender.com/tools/notify-escalation`
**Body:**
```json
{
  "caller_name": "{{first_name}} {{last_name}}",
  "reason": "{{escalation_reason}}",
  "summary": "Caller authenticated: {{is_verified}}. Intent: {{caller_intent}}. Escalation from Triage agent."
}
```
**Skip Response:** ON (don't wait for caller, proceed immediately)
Edges:
- [always] → N12: TRANSFER_TO_HUMAN

---

#### N15: WRITE_RECORD_FN [Function Node]
**URL:** POST `https://observe-insurance-claims-agent.onrender.com/tools/write-interaction-record`
**Body:**
```json
{
  "caller_name": "{{first_name}} {{last_name}}",
  "customer_id": "{{customer_id}}",
  "call_summary": "Caller authenticated: {{is_verified}}. Intent: {{caller_intent}}. Resolution: {{resolution}}.",
  "sentiment": "Neutral",
  "intent": "{{caller_intent}}",
  "resolution": "{{resolution}}",
  "escalated": "{{escalated}}"
}
```
**Skip Response:** ON
Edges:
- [always] → N17: POLITE_CLOSE

---

#### N16: WRITE_RECORD_NO_TRANSFER [Function Node]
Same as N15 but specifically for calls that end without transfer.
Edges:
- [always] → N17: POLITE_CLOSE

---

#### N17: POLITE_CLOSE [Conversation Node]
```
Say: "Thank you for calling Observe Insurance. Have a good day, and feel free to call back any time."
```
Edges:
- [agent finishes speaking] → N18: END (skip response)

---

#### N18: END [End Node]

---

## AGENT 2: CLAIMS AGENT

**No phone number attached — only reachable via transfer from Triage**
**DVs received from Triage:** `customer_id`, `first_name` (pre-populated via transfer)

### GLOBAL NODES

#### G1: EMERGENCY_OVERRIDE [Global — same as Triage]

#### G2: HUMAN_REQUESTED [Global Conversation Node]
```
Say: "Of course — let me get you to a representative."
```
- Set: `escalated` = true, `resolution` = "escalated"
Edges: → NOTIFY_ESCALATION_FN

---

### MAIN FLOW NODES

#### N1: CLAIMS_ENTRY [Conversation Node — Skip Response ON]
```
Say: "Let me pull up your claim now..." 
```
(No user response needed — just a bridge phrase while transitioning)
**Skip Response: ON** — immediately transitions without waiting for caller input
Edges:
- [skip response done] → N2: FETCH_ALL_CLAIMS

---

#### N2: FETCH_ALL_CLAIMS [Subagent Node]
**Attached tool:** `get_claim_status`
**Extract DVs:**
- `claim_count` ← response.claims.length (or 1 if single)
- `claim_list` ← JSON.stringify(response.claims) (for disambiguation)
- `selected_claim_id` ← response.claims[0].claim_id (pre-set if only one)
- `selected_claim_type` ← response.claims[0].type (pre-set if only one)

```
Instruction:
Call get_claim_status with ONLY customer_id: {{customer_id}} (no claim_id — this fetches all claims for the account).
Do NOT speak. Extract the result into DVs. Transition immediately.
```
**Skip Response: ON**
Edges:
- [response.found == false] → N3: NO_CLAIMS_ON_ACCOUNT
- [response.multiple == true] → N4: DISAMBIGUATE_CLAIMS
- [response.multiple == false OR response.single == true] → N5: FETCH_SPECIFIC_CLAIM
- [error / fallback] → N11: SYSTEM_ERROR_ESCALATE

---

#### N3: NO_CLAIMS_ON_ACCOUNT [Conversation Node]
```
Say: "I don't see any active claims on your account right now. Would you like information on how to start a new claim, or did you have a question about the process?"
```
- Set DV: `resolution` = "resolved"
Edges:
- [caller wants to start a claim / general question] → N10: WRITE_RECORD_FN → N12: GOODBYE
  (Give them the start-a-claim instructions from memory: call back and select "new claim", log into observeinsurance.com, or use the mobile app)
- [caller wants a human] → G2: HUMAN_REQUESTED

---

#### N4: DISAMBIGUATE_CLAIMS [Conversation Node]
**No tool call — pure conversation**
```
Instruction:
The caller has multiple claims. Say:
"I can see you have [claim_count] claims on your account — [list the types, e.g. 'an auto claim and a home claim']. Which one would you like to check on?"

Use the claim_list DV to know the types. Present them naturally: "an auto claim" not "CLM-001".

Wait for the caller to specify which one.
Once they indicate a preference, extract the matching claim_id and set selected_claim_id accordingly.
```
**Extract DV:**
- `selected_claim_id` ← the claim_id matching the caller's choice
- `selected_claim_type` ← the type matching the caller's choice
Edges:
- [caller specifies a claim type and selected_claim_id is set] → N5: FETCH_SPECIFIC_CLAIM
- [caller is unclear after 2 turns] → N5: FETCH_SPECIFIC_CLAIM (default to first claim)
- [caller wants human] → G2: HUMAN_REQUESTED

---

#### N5: FETCH_SPECIFIC_CLAIM [Subagent Node]
**Attached tool:** `get_claim_status`
**SCOPE GUARD:** Always passes BOTH customer_id AND claim_id
**Extract DVs:**
- `claim_status` ← response.status
- `status_detail` ← response.status_detail (may be null)
- `docs_required` ← response.docs_required
- `docs_list` ← response.docs_list

```
Instruction:
Call get_claim_status with:
  - customer_id: {{customer_id}}  ← REQUIRED, never omit
  - claim_id: {{selected_claim_id}}  ← REQUIRED for security scoping
Say "Let me get the details on that..." before calling.
Do NOT speak the result. Extract DVs and transition.
```
**Skip Response: ON**
Edges:
- [`status_detail` is null or empty string] → N8: NULL_STATUS_ESCALATE
- [response.found == false] → N8: NULL_STATUS_ESCALATE (claim didn't match customer — shouldn't happen, but safe fallback)
- [all good] → N6: PRESENT_STATUS

---

#### N6: PRESENT_STATUS [Conversation Node]
```
Instruction:
Deliver the claim status. Rules:
1. Lead with the headline BEFORE any detail:
   - "Approved" → "Good news — your {{selected_claim_type}} claim has been approved."
   - "Under Review" → "Your {{selected_claim_type}} claim is currently under review."
   - "Pending Documents" → "Your {{selected_claim_type}} claim needs a few things from you to move forward."
   - "Filed" → "Your {{selected_claim_type}} claim has been received and is being processed."
   - "Denied" → Do NOT read the denial here. Say: "I want to make sure you get the right support on this — let me connect you with a representative who can walk you through this properly." Then escalate.
2. After the headline, naturally incorporate {{status_detail}} as the explanation.
3. ANTI-HALLUCINATION: Use ONLY the exact status and status_detail from the DVs. Never add, guess, or embellish.
4. Keep it conversational — one or two sentences, not a formal letter.
```
Edges:
- [`docs_required` == true] → N7: DOCS_REQUIRED_INSTRUCTIONS
- [`claim_status` == "Denied"] → N11: SYSTEM_ERROR_ESCALATE (reuse for denied, different reason set)
- [all good, no docs] → N9: ANY_OTHER_QUESTIONS

---

#### N7: DOCS_REQUIRED_INSTRUCTIONS [Conversation Node]
```
Say: "There's one thing needed to move your claim forward — {{docs_list}}. You can submit these by logging into your account at observeinsurance.com, replying to the claim email we sent you, or using the mobile app. Digital submission is fastest — typically processed within one business day. Would you like me to repeat those submission options?"
```
Edges:
- [caller wants options repeated] → stay (repeat once)
- [caller understands, ready to move on] → N9: ANY_OTHER_QUESTIONS
- [caller wants human] → G2: HUMAN_REQUESTED

---

#### N8: NULL_STATUS_ESCALATE [Conversation Node]
- Set DV: `resolution` = "escalated", `escalated` = true
```
Say: "I can see your {{selected_claim_type}} claim but the detailed status isn't showing in our system right now. Let me connect you with a representative who can give you the full picture — I'll pass along your account details so you won't have to repeat yourself."
```
Edges:
- [always] → NOTIFY_ESCALATION_FN

---

#### N9: ANY_OTHER_QUESTIONS [Conversation Node]
```
Say: "Is there anything else I can help you with today?"
```
Edges:
- [yes, another claim question] → N2: FETCH_ALL_CLAIMS (loop)
- [general question about hours / address / process] → (answer briefly from memory, or transfer to FAQ)
- [no, they're done] → N10: WRITE_RECORD_FN
- [human request] → G2: HUMAN_REQUESTED

---

#### N10: WRITE_RECORD_FN [Function Node]
**URL:** POST `https://observe-insurance-claims-agent.onrender.com/tools/write-interaction-record`
**Body:**
```json
{
  "caller_name": "{{first_name}}",
  "customer_id": "{{customer_id}}",
  "call_summary": "Caller inquired about {{selected_claim_type}} claim ({{selected_claim_id}}). Status: {{claim_status}}. Docs required: {{docs_required}}. Resolution: {{resolution}}.",
  "sentiment": "Positive",
  "intent": "claim_status",
  "resolution": "{{resolution}}",
  "escalated": "{{escalated}}"
}
```
**Skip Response: ON**
Edges:
- [always] → N12: GOODBYE

---

#### N11: SYSTEM_ERROR_ESCALATE [Conversation Node]
- Set DV: `resolution` = "escalated", `escalated` = true
```
Say: "I'm having trouble accessing the details on that. Let me connect you with a representative who can help directly."
```
Edges:
- [always] → NOTIFY_ESCALATION_FN

---

#### NOTIFY_ESCALATION_FN [Function Node — fire and forget]
**URL:** POST `https://observe-insurance-claims-agent.onrender.com/tools/notify-escalation`
**Body:**
```json
{
  "caller_name": "{{first_name}}",
  "reason": "Escalated from Claims agent",
  "summary": "Claim: {{selected_claim_id}}, status: {{claim_status}}, docs_required: {{docs_required}}. Escalation reason: {{resolution}}."
}
```
**Skip Response: ON**
Edges:
- [always] → TRANSFER_TO_HUMAN

---

#### TRANSFER_TO_HUMAN [Call Transfer Node — Warm]
**Destination:** [YOUR PERSONAL DEMO PHONE NUMBER]
**Transfer message:** "Claims escalation. Caller: {{first_name}}, Claim: {{selected_claim_id}} ({{selected_claim_type}}), Status: {{claim_status}}."

---

#### N12: GOODBYE [Conversation Node]
```
Say: "Thank you for calling Observe Insurance, {{first_name}}. I hope that helped — have a great day, and feel free to call back any time."
```
Edges:
- [agent finishes speaking, skip response] → END

---

#### END [End Node]

---

## AGENT 3: FAQ AGENT

**No phone number — reachable via transfer from Triage**
**Knowledge Base:** Attach "Observe Insurance FAQ" KB

### GLOBAL NODES

#### G1: EMERGENCY_OVERRIDE [same as others]

#### G2: HUMAN_REQUESTED [Global]
```
Say: "Of course, let me get you connected."
```
- Set: `escalated` = true, `resolution` = "escalated"
Edges: → NOTIFY_ESCALATION_FN

---

### MAIN FLOW NODES

#### N1: FAQ_WELCOME [Conversation Node]
```
Say: "Happy to help with your question{{caller_name != "" ? ", " + caller_name : ""}}. What would you like to know?"
```
Edges:
- [caller asks a question] → N2: FAQ_ANSWER

---

#### N2: FAQ_ANSWER [Subagent Node]
**Knowledge Base:** Observe Insurance FAQ (attached)
**No custom tools** — KB-only answers

```
Instruction:
Answer the caller's question using ONLY your connected knowledge base.
Topics available: office hours, mailing address, how to start a new claim, general claims process, document submission.

Rules:
- If the KB contains the answer: give it clearly and concisely. Phone-friendly — no reading long lists.
- If the KB does NOT have the answer: say "That's a good question, and I want to make sure I give you accurate information — let me connect you with a representative who can help with that." Then set escalation.
- NEVER fabricate hours, addresses, phone numbers, or process details. Grounded answers only.
- After answering, ask: "Does that answer your question, or is there anything else?"
```
Edges:
- [caller's question is answered, no more questions] → N3: WRITE_RECORD_FN
- [caller has another question] → stay in N2 (multi-turn within node)
- [KB cannot answer] → N4: KB_NOT_FOUND_ESCALATE
- [caller wants to check their claim status] → (if customer_id exists) transfer to Claims, else note they need to call back authenticated
- [human request] → G2: HUMAN_REQUESTED

---

#### N3: WRITE_RECORD_FN [Function Node]
**URL:** POST `https://observe-insurance-claims-agent.onrender.com/tools/write-interaction-record`
**Body:**
```json
{
  "caller_name": "{{caller_name}}",
  "customer_id": "{{customer_id}}",
  "call_summary": "Caller asked FAQ questions. Resolution: {{resolution}}. Escalated: {{escalated}}.",
  "sentiment": "Positive",
  "intent": "faq",
  "resolution": "{{resolution}}",
  "escalated": "{{escalated}}"
}
```
**Skip Response: ON**
Edges:
- [always] → N5: GOODBYE

---

#### N4: KB_NOT_FOUND_ESCALATE [Conversation Node]
- Set DV: `escalated` = true, `resolution` = "escalated"
```
Say: "That's a good question, and I want to make sure I give you accurate information. Let me connect you with a representative who can give you the right answer."
```
Edges:
- [always] → NOTIFY_ESCALATION_FN

---

#### NOTIFY_ESCALATION_FN [Function Node]
Same pattern as other agents.
Edges: → TRANSFER_TO_HUMAN

---

#### TRANSFER_TO_HUMAN [Call Transfer Node]
**Destination:** [YOUR PERSONAL DEMO PHONE NUMBER]

---

#### N5: GOODBYE [Conversation Node]
```
Say: "Thank you for calling Observe Insurance. Have a great day!"
```
Edges:
- [skip response] → END

---

#### END [End Node]

---

## STATE PASSING BETWEEN AGENTS (the key technical detail)

When Triage transfers to Claims via **Transfer Agent Node**, configure the DV mapping:

| Triage DV | → | Claims Agent DV |
|---|---|---|
| `customer_id` | → | `customer_id` |
| `first_name` | → | `first_name` |

When Triage transfers to FAQ via **Transfer Agent Node**:

| Triage DV | → | FAQ Agent DV |
|---|---|---|
| `first_name` | → | `caller_name` |
| `customer_id` | → | `customer_id` |

This is the definitive solution to the state-passing problem. In Rigid Mode, DVs map cleanly between agents at transfer. The Claims agent STARTS with `customer_id` already populated — it never needs to re-derive or trust the conversation history. Auth is enforced structurally at the graph level.

---

## NODE COUNT SUMMARY

| Agent | Nodes | Global Nodes | Within safe range? |
|---|---|---|---|
| Triage/Auth | 18 | 3 | ✓ Yes (< 20 for rigid) |
| Claims | 14 | 2 | ✓ Yes |
| FAQ | 7 | 2 | ✓ Yes |

All three are well within Rigid Mode's reliable operating range. Flex Mode starts degrading at ~20 nodes because it compiles everything into one prompt — Rigid Mode doesn't have this ceiling.

---

## WHY THIS WORKS (say this to Shreyas)

> "I used Conversational Flow in Rigid Mode because the authentication sequence is fundamentally a state machine problem. Each node has a single responsibility and one set of possible exits. The Logic Split node evaluates `is_verified === true` as a deterministic boolean — the LLM cannot decide to skip it. Auth is enforced by the graph structure, not by a prompt instruction the model could ignore. For a compliance-relevant context like insurance, that's the right architecture. It also makes debugging straightforward — the call transcript shows exactly which node was active for each utterance, so if auth breaks I know immediately whether the failure was in the lookup, the verification, or the routing."

---

*Phase 3 Conversational Flow · Observe Insurance Claims Agent · Jibin Baby*
