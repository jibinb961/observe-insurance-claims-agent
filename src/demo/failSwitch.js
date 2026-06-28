/**
 * Demo failure injection switch.
 * GET /demo/fail?duration=30  → all tool calls return 500 for N seconds
 * GET /demo/recover            → reset immediately
 *
 * Designed for the live demo: show graceful degradation by hitting /demo/fail
 * mid-call, then watch the agent warm-transfer rather than freeze.
 * Auto-recovers after `duration` seconds — no manual cleanup needed.
 */

let failMode = false;
let failUntil = null;

function isFailMode() {
  if (!failMode) return false;
  if (failUntil && Date.now() > failUntil) {
    failMode = false;
    failUntil = null;
    console.log('[demo] Fail mode auto-recovered');
    return false;
  }
  return true;
}

function enable(durationMs) {
  failMode = true;
  failUntil = durationMs ? Date.now() + durationMs : null;
  const sec = durationMs ? `${durationMs / 1000}s` : 'indefinitely';
  console.log(`[demo] Fail mode ENABLED — will auto-recover in ${sec}`);
}

function disable() {
  failMode = false;
  failUntil = null;
  console.log('[demo] Fail mode DISABLED');
}

module.exports = { isFailMode, enable, disable };
