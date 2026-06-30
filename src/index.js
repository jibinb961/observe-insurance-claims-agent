/**
 * Observe Insurance Claims Agent — Backend Service
 * Retell + Airtable + Slack
 *
 * Endpoints:
 *   GET  /health               → Render warm-up ping + demo status
 *   GET  /demo/fail?duration=  → Enable simulated failure (seconds)
 *   GET  /demo/recover         → Disable simulated failure immediately
 *   POST /webhook/inbound      → Retell inbound call hook — pre-populates DVs at call start
 *   POST /tools/*              → Retell tool webhooks (5 tools)
 *   POST /webhooks/call-end    → Retell post-call fallback writer
 *   GET  /dashboard            → Contact centre operations dashboard (served from public/)
 *   GET  /api/dashboard-data   → JSON data feed for the dashboard
 *   GET  /debug/test-slack     → Fire a test Slack escalation alert
 *   GET  /debug/inbound-log    → Ring buffer of last 20 inbound webhook calls
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const toolsRouter = require('./routes/tools');
const webhooksRouter = require('./routes/webhooks');
const failSwitch = require('./demo/failSwitch');
const airtable = require('./services/airtable');
const slack = require('./services/slack');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Startup validation ───────────────────────────────────────────────────────
// Fail fast if critical env vars are missing — better than silent tool failures
const REQUIRED_ENV = ['AIRTABLE_TOKEN', 'AIRTABLE_BASE_ID'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error('[startup] FATAL — missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// ─── Health check ─────────────────────────────────────────────────────────────
// Used by Render to confirm the service is alive.
// Also used in the pre-demo morning checklist — hit this before every demo session.
// env_check exposes masked variable status so misconfiguration is immediately visible.
app.get('/health', (req, res) => {
  const baseId = process.env.AIRTABLE_BASE_ID || '';
  const token = process.env.AIRTABLE_TOKEN || '';

  res.json({
    status: 'ok',
    service: 'observe-insurance-claims-agent',
    failMode: failSwitch.isFailMode(),
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    env_check: {
      // Show enough to diagnose without exposing secrets
      AIRTABLE_BASE_ID_prefix: baseId.slice(0, 12) || 'MISSING',
      AIRTABLE_BASE_ID_length: baseId.length,
      AIRTABLE_BASE_ID_has_slash: baseId.includes('/'),   // true = still has table suffix — BAD
      AIRTABLE_TOKEN_set: token.length > 0,
      AIRTABLE_TOKEN_length: token.length,
      SLACK_WEBHOOK_set: !!process.env.SLACK_WEBHOOK_URL,
      RETELL_API_KEY_set: !!process.env.RETELL_API_KEY,
    },
  });
});

// ─── Demo failure injection ───────────────────────────────────────────────────
// Hit GET /demo/fail?duration=30 mid-call to make all tool calls return 500 for 30s.
// Watch the agent warm-transfer rather than freeze. Auto-recovers after duration.
// Hit GET /demo/recover to reset early.
app.get('/demo/fail', (req, res) => {
  const duration = Math.max(1, parseInt(req.query.duration, 10) || 30);
  failSwitch.enable(duration * 1000);
  res.json({
    message: `Fail mode enabled for ${duration} seconds`,
    recoversAt: new Date(Date.now() + duration * 1000).toISOString(),
  });
});

app.get('/demo/recover', (req, res) => {
  failSwitch.disable();
  res.json({ message: 'Fail mode disabled', status: 'ok' });
});

// ─── Debug: inbound call log ──────────────────────────────────────────────────
// In-memory ring buffer of the last 20 inbound webhook calls.
// GET /debug/inbound-log to see whether Retell hit the endpoint and what we returned.
// Remove or gate behind auth before any public-facing production deployment.
const inboundLog = [];
const MAX_LOG = 20;

function logInbound(entry) {
  inboundLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (inboundLog.length > MAX_LOG) inboundLog.pop();
}

app.get('/debug/inbound-log', (req, res) => {
  res.json({ count: inboundLog.length, calls: inboundLog });
});

// ─── Inbound call webhook ─────────────────────────────────────────────────────
// Retell fires this at the very start of every inbound call (before the agent speaks).
// Returns dynamic variables injected into the agent at call start.
//
// IMPORTANT — must be configured on the PHONE NUMBER, not the agent:
//   Retell dashboard → Phone Numbers → +12183181089 → Inbound Webhook URL
//
// Retell requires this exact response envelope:
//   { "call_inbound": { "dynamic_variables": { ...string values only... } } }
// Flat JSON does not work. All DV values must be strings (Retell requirement).
app.post('/webhook/inbound', async (req, res) => {
  // Retell sends: { event: "call_inbound", call_inbound: { from_number, to_number, ... } }
  // from_number is nested inside call_inbound, not at the top level.
  console.log('[inbound] raw body keys:', Object.keys(req.body));
  const from_number = req.body?.call_inbound?.from_number || req.body?.from_number;
  console.log('[inbound] call from:', from_number ? `[REDACTED, length=${from_number.length}]` : 'unknown');

  // If RETELL_AGENT_ID is set, include override_agent_id so Retell uses the
  // right agent even when "Inbound Call Agent" is not configured on the number.
  // This also makes the webhook the single source of routing + DV injection.
  const agentOverride = process.env.RETELL_AGENT_ID
    ? { override_agent_id: process.env.RETELL_AGENT_ID }
    : {};

  // DVs must always be strings — Retell rejects booleans and numbers
  const notFound = {
    call_inbound: {
      ...agentOverride,
      dynamic_variables: {
        customer_found: 'false',
        customer_id: '',
        first_name: '',
      },
    },
  };

  if (!from_number) {
    logInbound({ from: 'missing', result: 'no_number', body_keys: Object.keys(req.body), dvs: null });
    return res.json(notFound);
  }

  try {
    const result = await airtable.lookupCustomer(from_number);

    if (result.found) {
      console.log('[inbound] caller identified:', result.customer_id);
      const dvs = {
        customer_found: 'true',
        customer_id: result.customer_id,
        first_name: result.first_name,
      };
      logInbound({ from: `+***${from_number.slice(-4)}`, result: 'found', dvs });
      return res.json({ call_inbound: { ...agentOverride, dynamic_variables: dvs } });
    }

    console.log('[inbound] caller not in system');
    logInbound({ from: `+***${from_number.slice(-4)}`, result: 'not_found', dvs: null });
    return res.json(notFound);
  } catch (err) {
    console.error('[inbound] lookup error:', err.message);
    logInbound({ from: `+***${from_number.slice(-4)}`, result: 'error', error: err.message, dvs: null });
    return res.json(notFound);
  }
});

// ─── Dashboard data API ───────────────────────────────────────────────────────
// Single endpoint that powers the /dashboard page.
// Returns health status + last 20 interactions + inbound call log.
app.get('/api/dashboard-data', async (req, res) => {
  const baseId = process.env.AIRTABLE_BASE_ID || '';
  const health = {
    status: 'ok',
    failMode: failSwitch.isFailMode(),
    uptime_seconds: Math.floor(process.uptime()),
    slack_configured: !!process.env.SLACK_WEBHOOK_URL,
    airtable_ok: baseId.length > 0 && !baseId.includes('/'),
  };

  let interactions = [];
  try {
    interactions = await airtable.getRecentInteractions(20);
  } catch (err) {
    console.error('[dashboard] failed to fetch interactions:', err.message);
  }

  // Compute today's stats from the interactions we already fetched
  const todayPrefix = new Date().toISOString().slice(0, 10); // "2026-06-29"
  const todayCalls = interactions.filter((i) => i.timestamp.startsWith(todayPrefix));
  const stats = {
    total_today: todayCalls.length,
    escalated_today: todayCalls.filter((i) => i.escalated).length,
    resolved_today: todayCalls.filter((i) => i.resolution === 'resolved').length,
  };

  res.json({ health, stats, interactions, inbound_log: inboundLog });
});

// ─── Callbacks API ────────────────────────────────────────────────────────────
app.get('/api/callbacks', async (req, res) => {
  try {
    const callbacks = await airtable.getRecentCallbacks(20);
    res.json({ callbacks });
  } catch (err) {
    console.error('[api/callbacks] error:', err.message);
    res.json({ callbacks: [], error: err.message });
  }
});

// ─── Slack test endpoint ───────────────────────────────────────────────────────
// GET /debug/test-slack — fires a test Slack alert to confirm the webhook is wired.
app.get('/debug/test-slack', async (req, res) => {
  if (!process.env.SLACK_WEBHOOK_URL) {
    return res.status(400).json({
      notified: false,
      error: 'SLACK_WEBHOOK_URL is not set. Add it to your .env and Render env vars.',
    });
  }
  try {
    await slack.notifyEscalation({
      caller_name: 'Test Caller',
      reason: 'Manual test from /debug/test-slack',
      summary: 'This is a test notification — backend Slack integration is working.',
    });
    res.json({ notified: true, message: 'Test Slack message sent successfully.' });
  } catch (err) {
    res.status(500).json({ notified: false, error: err.message });
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/tools', toolsRouter);
app.use('/webhooks', webhooksRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ─── Global error handler ────────────────────────────────────────────────────
// Last-resort catch — individual routes already handle their own errors,
// but this prevents unhandled exceptions from crashing the process mid-call.
app.use((err, req, res, _next) => {
  console.error('[global-error]', err.message);
  res.status(500).json({
    error: 'Internal server error',
    fallback: 'I am having trouble right now. Let me connect you with a representative.',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] Observe Insurance backend running on port ${PORT}`);
  console.log('[server] Slack webhook:', process.env.SLACK_WEBHOOK_URL ? 'configured' : 'NOT configured (Phase 4)');
  console.log('[server] Retell API key:', process.env.RETELL_API_KEY ? 'configured' : 'NOT configured');
});
