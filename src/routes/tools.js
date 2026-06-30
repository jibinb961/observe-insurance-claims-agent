/**
 * Tool webhook endpoints — called by Retell when the LLM invokes a tool.
 *
 * Request format: POST with JSON body containing the tool arguments directly.
 * Response format: JSON object — Retell passes the entire response body to the LLM.
 *
 * Every endpoint:
 *   1. Validates required parameters
 *   2. Checks the demo fail switch (returns 500 to simulate backend failure)
 *   3. Calls the Airtable service (already timeout-wrapped at 8s)
 *   4. Returns a graceful fallback response on any error — never a raw exception
 *
 * The `fallback` field in error responses gives the agent explicit instruction
 * on what to say/do, so it never freezes or hallucinates when the backend is down.
 */

const express = require('express');
const router = express.Router();
const airtable = require('../services/airtable');
const slack = require('../services/slack');
const cache = require('../services/cache');
const failSwitch = require('../demo/failSwitch');

// Middleware: inject simulated failure for the live demo
router.use((req, res, next) => {
  if (failSwitch.isFailMode()) {
    console.log('[demo-fail] Simulating backend failure →', req.path);
    return res.status(500).json({
      error: 'Service temporarily unavailable',
      fallback: 'I am having trouble accessing our system right now. Let me connect you with a representative who can help.',
      _demo: true,
    });
  }
  next();
});

/**
 * POST /tools/lookup-customer
 * Looks up a customer by phone number.
 * Caches the result in-memory for the session — no repeat Airtable hits.
 */
router.post('/lookup-customer', async (req, res) => {
  const { phone_number } = req.body;

  if (!phone_number) {
    return res.status(400).json({
      found: false,
      error: 'phone_number is required',
    });
  }

  try {
    const cacheKey = `customer:${phone_number}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('[lookup-customer] cache hit');
      return res.json(cached);
    }

    const result = await airtable.lookupCustomer(phone_number);

    if (result.found) {
      cache.set(cacheKey, result);
    }

    return res.json(result);
  } catch (err) {
    console.error('[lookup-customer] error:', err.message);
    return res.json({
      found: false,
      error: 'lookup_failed',
      fallback: 'I am having trouble looking up your account right now. Let me connect you with a representative who can help.',
    });
  }
});

/**
 * POST /tools/verify-identity
 * Verifies the caller's DOB last-4. dob_last4 is NEVER logged.
 * Brute-force protection lives in the agent prompt (max 2 attempts → escalate).
 */
router.post('/verify-identity', async (req, res) => {
  const { customer_id, dob_last4 } = req.body;

  if (!customer_id || !dob_last4) {
    return res.status(400).json({
      verified: false,
      error: 'customer_id and dob_last4 are required',
    });
  }

  // dob_last4 is intentionally excluded from logs — PII boundary
  console.log('[verify-identity] customer_id:', customer_id, 'dob:[REDACTED]');

  try {
    const result = await airtable.verifyIdentity(customer_id, dob_last4);
    return res.json(result);
  } catch (err) {
    console.error('[verify-identity] error:', err.message);
    return res.json({
      verified: false,
      error: 'verification_failed',
      fallback: 'I am unable to verify your identity right now. Let me connect you with a representative who can verify another way.',
    });
  }
});

/**
 * POST /tools/get-claim-status
 *
 * customer_id: REQUIRED — the authenticated caller's ID (set in triage, carried via handoff)
 * claim_id:    OPTIONAL — if the caller has multiple claims, the agent passes this after disambiguation
 *
 * Security: customer_id is always required. A caller-provided claim_id without a matching
 * customer_id returns found:false — cross-customer lookups are structurally impossible.
 */
router.post('/get-claim-status', async (req, res) => {
  console.log('RAW BODY:', JSON.stringify(req.body));
  const { customer_id, claim_id } = req.body;

  if (!customer_id) {
    return res.status(400).json({
      found: false,
      error: 'customer_id is required',
    });
  }

  console.log('[get-claim-status] customer_id:', customer_id, 'claim_id:', claim_id || 'all');

  try {
    const result = await airtable.getClaimStatus(customer_id, claim_id);
    return res.json(result);
  } catch (err) {
    console.error('[get-claim-status] error:', err.message);
    return res.json({
      found: false,
      error: 'claim_lookup_failed',
      fallback: 'I am having trouble retrieving your claim right now. Let me connect you with a representative who can pull up the full details.',
    });
  }
});

/**
 * POST /tools/write-interaction-record
 *
 * Writes the post-call record. Idempotent on call_id — safe to call twice.
 * On ANY write error, returns a graceful response so the agent still ends the call cleanly.
 * The caller's experience must never depend on the write succeeding.
 *
 * call_id: passed by the agent from its {{call_id}} dynamic variable (set in system prompt).
 */
router.post('/write-interaction-record', async (req, res) => {
  const {
    call_id,
    caller_name,
    customer_id,
    call_summary,
    sentiment,
    intent,
    resolution,
    escalated,
  } = req.body;

  // call_id is critical for idempotency — generate a fallback if missing
  const id = call_id || `fallback-${Date.now()}`;
  if (!call_id) {
    console.warn('[write-interaction] call_id missing — using fallback ID:', id);
  }

  try {
    const result = await airtable.writeInteractionRecord(
      { caller_name, customer_id, call_summary, sentiment, intent, resolution, escalated },
      id
    );
    return res.json(result);
  } catch (err) {
    console.error('[write-interaction] error:', err.message);
    // Graceful: agent ends the call regardless; failure is logged for operational retry
    return res.json({
      written: false,
      error: 'write_failed',
      graceful: true,
    });
  }
});

/**
 * POST /tools/notify-escalation
 *
 * Fires a Slack alert for escalations. ALWAYS responds immediately (202 Accepted)
 * then processes the Slack call async — the warm transfer never waits on Slack.
 *
 * If SLACK_WEBHOOK_URL is not yet configured (Phase 4), logs and returns safely.
 */
router.post('/notify-escalation', async (req, res) => {
  const { caller_name, reason, summary } = req.body;

  // Respond before Slack call so Retell's transfer doesn't wait
  res.status(202).json({ notified: true, async: true });

  // Fire and forget — failure is logged but never propagates to the caller
  slack
    .notifyEscalation({ caller_name, reason, summary })
    .catch((err) =>
      console.error('[notify-escalation] Slack error (non-blocking):', err.message)
    );
});

/**
 * POST /tools/request-callback
 *
 * In-call write demonstration: caller asks to be called back, agent captures
 * the details and writes a structured record to the Callbacks table.
 *
 * This replaces write-interaction-record as the in-call write tool.
 * Post-call writes are now owned entirely by the webhook pipeline (call_ended
 * + call_analyzed events) which is more robust — survives hangups and drops.
 *
 * Arguments from Retell (all strings — Retell passes DVs as strings):
 *   customer_id:    authenticated caller ID (from DV)
 *   caller_name:    caller's first name (from DV)
 *   phone:          {{user_number}} system variable
 *   preferred_time: free-form text from the caller ("tomorrow morning", "after 3pm")
 *   reason:         brief reason for the callback ("question about CLM-001 documents")
 */
router.post('/request-callback', async (req, res) => {
  const { customer_id, caller_name, phone, preferred_time, reason } = req.body;

  console.log('[request-callback] customer_id:', customer_id, 'preferred_time:', preferred_time);

  if (!customer_id) {
    return res.status(400).json({
      success: false,
      error: 'customer_id is required',
      fallback: 'I need to verify your account before I can schedule a callback.',
    });
  }

  try {
    const result = await airtable.createCallbackRequest({
      customer_id,
      caller_name,
      phone,
      preferred_time,
      reason,
    });

    return res.json({
      success: true,
      callback_id: result.callback_id,
      // Agent reads this message directly back to the caller
      message: `Your callback request has been logged. A representative will reach out ${preferred_time || 'as soon as possible'}. Your reference number is ${result.callback_id}.`,
    });
  } catch (err) {
    console.error('[request-callback] error:', err.message);
    return res.json({
      success: false,
      error: 'callback_failed',
      fallback: 'I was unable to log the callback request right now. Let me transfer you to a representative who can do that for you.',
    });
  }
});

module.exports = router;
