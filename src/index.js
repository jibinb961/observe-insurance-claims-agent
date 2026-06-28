/**
 * Observe Insurance Claims Agent — Backend Service
 * Retell + Airtable + Slack
 *
 * Endpoints:
 *   GET  /health              → Render warm-up ping + demo status
 *   GET  /demo/fail?duration= → Enable simulated failure (seconds)
 *   GET  /demo/recover        → Disable simulated failure immediately
 *   POST /tools/*             → Retell tool webhooks (5 tools)
 *   POST /webhooks/call-end   → Retell post-call fallback writer
 */

require('dotenv').config();

const express = require('express');
const toolsRouter = require('./routes/tools');
const webhooksRouter = require('./routes/webhooks');
const failSwitch = require('./demo/failSwitch');

const app = express();
app.use(express.json());

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
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'observe-insurance-claims-agent',
    failMode: failSwitch.isFailMode(),
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
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
