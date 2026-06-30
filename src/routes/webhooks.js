/**
 * Retell post-call webhook — two-phase interaction record pipeline.
 *
 * Retell fires two events to this endpoint after every call:
 *
 *   Phase 1 — call_ended (fires immediately on hangup or natural end)
 *     • Has: call_id, from_number, disconnection_reason, transcript, DVs
 *     • Does NOT yet have: Retell's AI analysis (summary, sentiment)
 *     → Writes an initial interaction record using DVs + disconnection_reason
 *     → If the agent already wrote the record (tool call during the call), skips (idempotent)
 *
 *   Phase 2 — call_analyzed (fires seconds after call_ended, after Retell runs its analysis)
 *     • Has: everything from call_ended PLUS call_analysis (summary, sentiment, custom_data)
 *     → Enriches the existing record with richer analysis data
 *     → If no record exists (rare edge case — Phase 1 failed), creates one now
 *
 * Result: every call — natural ending, mid-call hangup, agent error, transfer — gets a
 * complete Airtable record. No call is ever silently dropped.
 *
 * Configure in Retell: Agent → Post-call Webhook URL:
 *   https://your-service.onrender.com/webhooks/call-end
 */

const express = require('express');
const router = express.Router();
const airtable = require('../services/airtable');

// ─── Debug ring buffer ────────────────────────────────────────────────────────
// Stores the last 20 webhook events so we can verify Retell is hitting us
// without needing to open the Render log dashboard.
// GET /webhooks/event-log to inspect.
const eventLog = [];
const MAX_EVENTS = 20;

function logEvent(entry) {
  eventLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (eventLog.length > MAX_EVENTS) eventLog.pop();
}

router.get('/event-log', (req, res) => {
  res.json({ count: eventLog.length, events: eventLog });
});

router.post('/call-end', async (req, res) => {
  // Always acknowledge immediately — Retell retries on non-200 and we must not block
  res.status(200).json({ received: true });

  const { event, call } = req.body;

  if (!call?.call_id) {
    console.error('[webhook] missing call_id — payload:', JSON.stringify(req.body).slice(0, 200));
    logEvent({ event: event || 'unknown', call_id: null, error: 'missing_call_id', body_keys: Object.keys(req.body) });
    return;
  }

  const call_id = call.call_id;
  console.log(`[webhook/${event || 'unknown'}] call_id:`, call_id);
  logEvent({
    event: event || 'unknown',
    call_id,
    disconnection_reason: call.disconnection_reason || null,
    // Capture analysis summary if present (call_analyzed events only)
    sentiment: call.call_analysis?.user_sentiment || null,
    call_successful: call.call_analysis?.call_successful ?? null,
    custom_keys: call.call_analysis?.custom_analysis_data
      ? Object.keys(call.call_analysis.custom_analysis_data)
      : null,
  });

  if (event === 'call_ended') {
    await handleCallEnded(call_id, call);
  } else if (event === 'call_analyzed') {
    await handleCallAnalyzed(call_id);  // fetches from Retell API internally
  } else {
    // call_started and other events — nothing to write
    console.log(`[webhook] ignoring event: ${event}`);
  }
});

// ─── Phase 1: call_ended ─────────────────────────────────────────────────────
async function handleCallEnded(call_id, call) {
  const dvs = call.retell_llm_dynamic_variables || {};
  const reason = call.disconnection_reason || 'unknown';

  // Log exactly what DVs Retell sent
  console.log('[webhook/call_ended] retell_llm_dynamic_variables:', JSON.stringify(dvs));
  console.log('[webhook/call_ended] from_number present:', !!call.from_number);

  // Retell only stores DVs set via tool response_variables — NOT inbound webhook DVs.
  // If customer_id is missing (inbound webhook pre-identified caller, agent skipped
  // lookup_customer), fall back to a direct Airtable lookup using from_number.
  let customer_id = dvs.customer_id || '';
  let caller_name = dvs.first_name || '';

  if (!customer_id && call.from_number) {
    console.log('[webhook/call_ended] DVs empty — falling back to from_number lookup');
    try {
      const lookup = await airtable.lookupCustomer(call.from_number);
      if (lookup.found) {
        customer_id = lookup.customer_id;
        caller_name = lookup.first_name;
        console.log('[webhook/call_ended] fallback lookup found:', customer_id);
      }
    } catch (err) {
      console.warn('[webhook/call_ended] fallback lookup failed:', err.message);
    }
  }

  const escalated = reason === 'call_transfer' || dvs.escalated === 'true';
  const resolution = inferResolution(reason, escalated);

  const data = {
    caller_name,
    caller_phone: call.from_number || '',   // always store the physical caller number
    customer_id,
    claims_checked: '',                      // Phase 2 will fill this from transcript
    // Summary is placeholder — Phase 2 will overwrite with Retell's real analysis
    call_summary: buildPlaceholderSummary(reason, { first_name: caller_name, customer_id }),
    sentiment: 'Neutral',
    intent: dvs.intent || 'other',
    resolution,
    escalated,
  };

  try {
    const result = await airtable.writeInteractionRecord(data, call_id);
    if (result.reason === 'already_logged') {
      console.log('[webhook/call_ended] agent wrote record in-call — skipping duplicate');
    } else {
      console.log('[webhook/call_ended] initial record written — reason:', reason, '| resolution:', resolution);
    }
  } catch (err) {
    console.error('[webhook/call_ended] write error for call_id:', call_id, '—', err.message);
  }
}

// ─── Phase 2: call_analyzed ──────────────────────────────────────────────────
// call_analyzed is used purely as a trigger. We fetch the full call object
// from Retell's Get Call API to get authoritative analysis data, then patch
// the Airtable record. This eliminates reliance on webhook payload completeness.
async function handleCallAnalyzed(call_id) {
  const apiKey = process.env.RETELL_API_KEY;

  if (!apiKey) {
    console.error('[webhook/call_analyzed] RETELL_API_KEY not set — cannot auto-sync');
    return;
  }

  console.log('[webhook/call_analyzed] fetching full call from Retell API for call_id:', call_id);

  let callData;
  try {
    const res = await fetch(`https://api.retellai.com/v2/get-call/${call_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.error('[webhook/call_analyzed] Retell API returned', res.status, 'for call_id:', call_id);
      return;
    }
    callData = await res.json();
  } catch (err) {
    console.error('[webhook/call_analyzed] Retell API fetch error:', err.message);
    return;
  }

  const analysis = callData.call_analysis || {};
  const customData = analysis.custom_analysis_data || {};

  // Parse the structured tool-call transcript to learn exactly which customers
  // and claims were accessed during this call — works for multi-customer calls.
  const activity = parseCallActivity(callData.transcript_with_tool_calls);

  console.log('[webhook/call_analyzed] API response — sentiment:', analysis.user_sentiment,
    '| successful:', analysis.call_successful,
    '| summary length:', analysis.call_summary?.length || 0,
    '| custom keys:', Object.keys(customData),
    '| customers served:', activity.customers,
    '| claims checked:', activity.claims);

  // Build the enrichment patch from authoritative API data
  const patch = {};

  if (analysis.call_summary)   patch.call_summary = analysis.call_summary;
  if (analysis.user_sentiment) patch.sentiment    = mapSentiment(analysis.user_sentiment);

  if (typeof analysis.call_successful === 'boolean') {
    patch.resolution = analysis.call_successful ? 'resolved' : 'incomplete';
  }

  // Map custom post-call analysis variables → Airtable fields.
  // Keys must match the variable names in Retell → Agent → Post-Call Analysis.
  const CUSTOM_FIELD_MAP = {
    intent:          'intent',
    resolution:      'resolution',
    sentiment:       'sentiment',
    call_summary:    'call_summary',
    summary:         'call_summary',
    caller_name:     'caller_name',
    caller_intent:   'intent',
    claims_checked:  'claims_checked',  // Retell AI extraction — fallback if transcript parse misses
  };

  for (const [retellKey, airtableField] of Object.entries(CUSTOM_FIELD_MAP)) {
    if (customData[retellKey] !== undefined && customData[retellKey] !== '') {
      patch[airtableField] = customData[retellKey];
    }
  }

  // Enrich with caller phone and full activity derived from the transcript.
  // These overwrite Phase 1's partial data with the complete picture.
  if (callData.from_number) {
    patch.caller_phone = callData.from_number;
  }
  if (activity.customers.length > 0) {
    // Comma-separated when multiple customers were served in one call
    patch.customer_id = activity.customers.join(', ');
  }
  if (activity.claims.length > 0) {
    patch.claims_checked = activity.claims.join(', ');
  }

  if (Object.keys(patch).length === 0) {
    console.log('[webhook/call_analyzed] no enrichment data in API response — skipping update');
    return;
  }

  try {
    let result = await airtable.updateInteractionRecord(call_id, patch);

    if (result.reason === 'not_found') {
      // call_ended and call_analyzed fire within ~20ms — Phase 1 write may still
      // be in-flight. Wait 3s then retry once before falling back to a full create.
      console.log('[webhook/call_analyzed] record not found — retrying in 3s');
      await new Promise(resolve => setTimeout(resolve, 3000));
      result = await airtable.updateInteractionRecord(call_id, patch);
    }

    if (result.reason === 'not_found') {
      // Still not found after retry — Phase 1 must have failed entirely.
      // Create a minimal record from the API analysis data as a last resort.
      console.warn('[webhook/call_analyzed] record still missing after retry — creating fallback record');
      const reason = callData.disconnection_reason || 'unknown';
      const escalated = reason === 'call_transfer';
      await airtable.writeInteractionRecord(
        {
          caller_name: customData.caller_name || '',
          customer_id: customData.customer_id || '',
          call_summary: patch.call_summary || buildPlaceholderSummary(reason, {}),
          sentiment: patch.sentiment || 'Neutral',
          intent: patch.intent || 'other',
          resolution: patch.resolution || inferResolution(reason, escalated),
          escalated,
        },
        call_id
      );
      console.log('[webhook/call_analyzed] fallback record created for call_id:', call_id);
    } else {
      console.log('[webhook/call_analyzed] record enriched — fields updated:', Object.keys(patch).join(', '));
    }
  } catch (err) {
    console.error('[webhook/call_analyzed] error for call_id:', call_id, '—', err.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parses Retell's transcript_with_tool_calls array to extract every customer ID
 * authenticated and every claim ID accessed during the call.
 *
 * transcript_with_tool_calls entries with role="tool_call_result" contain the
 * raw JSON string that our backend returned to the agent. We parse each one and
 * look for known shapes from lookup_customer and get_claim_status responses.
 *
 * This is the authoritative source for multi-customer, multi-claim calls —
 * it works without any agent changes because the data is already in the transcript.
 */
function parseCallActivity(transcriptWithToolCalls) {
  const customers = new Set();
  const claims    = new Set();

  if (!Array.isArray(transcriptWithToolCalls)) return { customers: [], claims: [] };

  for (const entry of transcriptWithToolCalls) {
    if (entry.role !== 'tool_call_result') continue;

    let result;
    try {
      result = typeof entry.content === 'string'
        ? JSON.parse(entry.content)
        : entry.content;
    } catch {
      continue; // non-JSON content — skip
    }

    if (!result || !result.found) continue;

    // lookup_customer result: { found, customer_id, first_name, last_name }
    if (result.customer_id) {
      customers.add(result.customer_id);
    }

    // get_claim_status single result: { found, single, claim_id, ... }
    if (result.claim_id) {
      claims.add(result.claim_id);
    }

    // get_claim_status multi result: { found, multiple, claims: [{claim_id, ...}] }
    if (Array.isArray(result.claims)) {
      result.claims.forEach(c => { if (c.claim_id) claims.add(c.claim_id); });
    }
  }

  return {
    customers: [...customers],
    claims:    [...claims],
  };
}

/**
 * Maps Retell's disconnection_reason to our resolution values.
 * Reference: https://docs.retellai.com/api-references/get-call
 */
function inferResolution(reason, escalated) {
  if (escalated || reason === 'call_transfer') return 'escalated';
  if (reason === 'agent_hangup')             return 'resolved';
  if (reason === 'user_hangup')              return 'incomplete';
  if (reason === 'inactivity')               return 'incomplete';
  if (reason === 'dial_no_answer')           return 'incomplete';
  if (reason === 'voicemail_reached')        return 'incomplete';
  if (reason === 'dial_failed')              return 'incomplete';
  if (reason === 'concurrency_limit_reached') return 'incomplete';
  return 'incomplete';
}

/**
 * Builds a human-readable placeholder summary from what we know at call_ended time.
 * Phase 2 (call_analyzed) will overwrite this with Retell's real AI summary.
 */
function buildPlaceholderSummary(reason, dvs) {
  const name = dvs.first_name || 'Caller';
  const cid  = dvs.customer_id || '';

  const reasonMap = {
    agent_hangup:              'Call completed.',
    user_hangup:               'Caller disconnected.',
    call_transfer:             'Call escalated and transferred to a live agent.',
    inactivity:                'Call ended due to inactivity.',
    dial_no_answer:            'No answer.',
    voicemail_reached:         'Voicemail reached.',
    dial_failed:               'Call failed to connect.',
    concurrency_limit_reached: 'Call rejected — concurrency limit.',
  };

  const reasonText = reasonMap[reason] || `Call ended (${reason}).`;
  return cid
    ? `${name} (${cid}): ${reasonText} [Awaiting post-call analysis]`
    : `${name}: ${reasonText} [Awaiting post-call analysis]`;
}

/**
 * Maps Retell's sentiment labels to our Airtable Single Select options.
 */
function mapSentiment(retellSentiment) {
  const map = { Positive: 'Positive', Negative: 'Negative', Neutral: 'Neutral' };
  return map[retellSentiment] || 'Neutral';
}

module.exports = router;
