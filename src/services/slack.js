/**
 * Slack escalation notification.
 * ALWAYS call this fire-and-forget — never await it from the tool route.
 * The warm transfer must never block waiting on a third-party notification service.
 *
 * If SLACK_WEBHOOK_URL is absent (Phase 4 setup pending), logs and returns gracefully.
 */

async function notifyEscalation({ caller_name, reason, summary }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log('[slack] SLACK_WEBHOOK_URL not configured — skipping (set in Phase 4)');
    return { notified: false, reason: 'no_webhook_configured' };
  }

  const payload = {
    text:
      `:rotating_light: *Call Escalated — Observe Insurance*\n` +
      `*Caller:* ${caller_name || 'Unverified caller'}\n` +
      `*Reason:* ${reason}\n` +
      `*Summary:* ${summary}`,
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack responded with ${response.status}`);
  }

  return { notified: true };
}

module.exports = { notifyEscalation };
