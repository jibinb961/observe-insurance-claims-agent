/**
 * Call activity parsing and caller-phone resolution.
 * Used by post-call webhooks and the manual sync endpoint — no Retell agent changes.
 */

// call_id → from_number, populated on call_started when Retell sends from_number
const callPhoneCache = new Map();
const MAX_CACHE_SIZE = 200;

function cacheCallPhone(call_id, from_number) {
  if (!call_id || !from_number) return;
  callPhoneCache.set(call_id, String(from_number).trim());
  if (callPhoneCache.size > MAX_CACHE_SIZE) {
    const oldest = callPhoneCache.keys().next().value;
    callPhoneCache.delete(oldest);
  }
}

function getCachedCallPhone(call_id) {
  return call_id ? (callPhoneCache.get(call_id) || '') : '';
}

/** Normalize spoken or partial numbers to a display-friendly E.164-ish string. */
function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 0) return phone.startsWith('+') ? phone : `+${digits}`;
  return '';
}

/**
 * Parse Retell transcript_with_tool_calls for customers, claims, and spoken phones.
 */
function parseCallActivity(transcriptWithToolCalls) {
  const customers = new Set();
  const claims = new Set();
  const spokenPhones = [];

  if (!Array.isArray(transcriptWithToolCalls)) {
    return { customers: [], claims: [], spokenPhones: [] };
  }

  for (const entry of transcriptWithToolCalls) {
    const role = entry.role || '';

    // Tool invocations — phone_number from lookup_customer (even if lookup failed)
    if (role === 'tool_call_invocation' || role === 'tool_call') {
      const toolName = entry.name || entry.tool_name || '';
      if (toolName.includes('lookup_customer')) {
        let args = entry.arguments ?? entry.args;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = null; }
        }
        if (args?.phone_number) {
          const normalized = normalizePhone(args.phone_number);
          if (normalized) spokenPhones.push(normalized);
        }
      }
      continue;
    }

    if (role !== 'tool_call_result') continue;

    let result;
    try {
      result = typeof entry.content === 'string'
        ? JSON.parse(entry.content)
        : entry.content;
    } catch {
      continue;
    }

    if (!result) continue;

    if (result.customer_id) {
      customers.add(result.customer_id);
    }

    if (result.claim_id) {
      claims.add(result.claim_id);
    }

    if (Array.isArray(result.claims)) {
      result.claims.forEach((c) => { if (c.claim_id) claims.add(c.claim_id); });
    }
  }

  return {
    customers: [...customers],
    claims: [...claims],
    spokenPhones: [...new Set(spokenPhones)],
  };
}

/**
 * Resolve the best available caller phone from Retell payloads and transcript.
 * Priority: webhook/API from_number → call_started cache → spoken lookup number.
 */
function resolveCallerPhone({ call_id, webhookCall, apiCall, activity }) {
  const candidates = [
    webhookCall?.from_number,
    apiCall?.from_number,
    getCachedCallPhone(call_id),
    ...(activity?.spokenPhones || []),
  ];

  for (const raw of candidates) {
    const trimmed = String(raw || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

module.exports = {
  cacheCallPhone,
  getCachedCallPhone,
  normalizePhone,
  parseCallActivity,
  resolveCallerPhone,
};
