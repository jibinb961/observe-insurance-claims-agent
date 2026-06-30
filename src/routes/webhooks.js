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
  logEvent({ event: event || 'unknown', call_id, disconnection_reason: call.disconnection_reason || null });

  if (event === 'call_ended') {
    await handleCallEnded(call_id, call);
  } else if (event === 'call_analyzed') {
    await handleCallAnalyzed(call_id, call);
  } else {
    // call_started and other events — nothing to write
    console.log(`[webhook] ignoring event: ${event}`);
  }
});

// ─── Phase 1: call_ended ─────────────────────────────────────────────────────
async function handleCallEnded(call_id, call) {
  const dvs = call.retell_llm_dynamic_variables || {};
  const reason = call.disconnection_reason || 'unknown';

  const escalated = reason === 'call_transfer' || dvs.escalated === 'true';
  const resolution = inferResolution(reason, escalated);

  const data = {
    caller_name: dvs.first_name || '',
    customer_id: dvs.customer_id || '',
    // Summary is placeholder — Phase 2 will overwrite with Retell's real analysis
    call_summary: buildPlaceholderSummary(reason, dvs),
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
async function handleCallAnalyzed(call_id, call) {
  const analysis = call.call_analysis || {};
  const customData = analysis.custom_analysis_data || {};
  const dvs = call.retell_llm_dynamic_variables || {};

  // Build the enrichment patch — only include fields where we have real data
  const patch = {};

  if (analysis.call_summary) {
    patch.call_summary = analysis.call_summary;
  }

  const sentiment = mapSentiment(analysis.user_sentiment);
  if (sentiment !== 'Neutral' || analysis.user_sentiment) {
    // Only overwrite if Retell gave us a real sentiment signal
    patch.sentiment = sentiment;
  }

  // Retell's call_successful is a stronger resolution signal than disconnection_reason
  if (typeof analysis.call_successful === 'boolean') {
    patch.resolution = analysis.call_successful ? 'resolved' : 'incomplete';
  }

  // custom_analysis_data is populated if you configure a post-call analysis prompt in Retell
  if (customData.intent) patch.intent = customData.intent;
  if (customData.resolution) patch.resolution = customData.resolution;

  if (Object.keys(patch).length === 0) {
    console.log('[webhook/call_analyzed] no enrichment data available — skipping update');
    return;
  }

  try {
    const result = await airtable.updateInteractionRecord(call_id, patch);

    if (result.reason === 'not_found') {
      // Edge case: call_analyzed arrived but call_ended never created the record
      // (e.g. server restarted between the two events). Create the record now from full data.
      console.warn('[webhook/call_analyzed] no existing record — creating fallback record');
      const reason = call.disconnection_reason || 'unknown';
      const escalated = reason === 'call_transfer' || dvs.escalated === 'true';
      await airtable.writeInteractionRecord(
        {
          caller_name: dvs.first_name || customData.caller_name || '',
          customer_id: dvs.customer_id || customData.customer_id || '',
          call_summary: patch.call_summary || buildPlaceholderSummary(reason, dvs),
          sentiment: patch.sentiment || 'Neutral',
          intent: patch.intent || dvs.intent || 'other',
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
