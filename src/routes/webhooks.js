/**
 * Retell post-call webhook — fallback interaction record writer.
 *
 * Two paths to writing the interaction record:
 *   Path A (primary):   Agent calls write_interaction_record tool at end of call
 *   Path B (this file): Retell fires POST /webhooks/call-end after every call
 *
 * Path B catches what Path A misses: dropped calls, abrupt hangups, agent errors.
 * Idempotency on call_id means Path A + Path B together = exactly-once semantics.
 *
 * Retell webhook payload (call_ended event):
 *   { event: "call_ended", call: { call_id, call_status, transcript, call_analysis, ... } }
 *
 * Configure this URL in Retell dashboard → Agent → Post-call webhook URL:
 *   https://your-service.onrender.com/webhooks/call-end
 */

const express = require('express');
const router = express.Router();
const airtable = require('../services/airtable');

router.post('/call-end', async (req, res) => {
  // Acknowledge immediately so Retell doesn't retry the webhook
  res.status(200).json({ received: true });

  const { call } = req.body;
  if (!call || !call.call_id) {
    console.error('[webhook/call-end] Payload missing call object or call_id');
    return;
  }

  const call_id = call.call_id;
  const analysis = call.call_analysis || {};
  const customData = analysis.custom_analysis_data || {};

  console.log('[webhook/call-end] Received for call_id:', call_id);

  try {
    const result = await airtable.writeInteractionRecord(
      {
        caller_name: customData.caller_name || '',
        customer_id: customData.customer_id || '',
        call_summary: analysis.call_summary || 'Call ended without summary.',
        sentiment: mapSentiment(analysis.user_sentiment),
        intent: customData.intent || 'other',
        // Webhook fires on any termination — mark incomplete unless custom data says otherwise
        resolution: customData.resolution || 'incomplete',
        escalated: customData.escalated === true || false,
      },
      call_id
    );

    if (result.reason === 'already_logged') {
      console.log('[webhook/call-end] Record already exists (in-call tool wrote it) — skipped');
    } else {
      console.log('[webhook/call-end] Fallback record written for call_id:', call_id);
    }
  } catch (err) {
    // Log but do not rethrow — we already sent 200. Operational alert / retry in production.
    console.error('[webhook/call-end] Write error for call_id:', call_id, '—', err.message);
  }
});

function mapSentiment(retellSentiment) {
  const map = { Positive: 'Positive', Negative: 'Negative', Neutral: 'Neutral' };
  return map[retellSentiment] || 'Neutral';
}

module.exports = router;
