/**
 * Airtable data layer — all database interactions in one place.
 * Every public function is wrapped in an 8-second timeout.
 * On timeout or error, the caller (tool route) catches and returns a graceful fallback.
 *
 * Phone normalization: any input format → E.164 (+1XXXXXXXXXX) before Airtable query.
 * This handles: "555 123 4567", "15551234567", "(555) 123-4567", "+15551234567", etc.
 *
 * Scope guard: getClaimStatus always requires customer_id.
 * claim_id alone is NEVER sufficient — prevents cross-customer data leaks.
 */

require('dotenv').config();
const Airtable = require('airtable');

const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN })
  .base(process.env.AIRTABLE_BASE_ID);

const TIMEOUT_MS = 8000;

// Races a promise against a timeout. Throws on timeout so callers can catch + fallback.
function withTimeout(promise, ms = TIMEOUT_MS) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Airtable timeout after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Normalizes any phone input to digits-only, US 11-digit format (e.g. 12125550101).
 * Stored format in Airtable is digits-only (no +), so we match that.
 * Production standard would be E.164 with + throughout — this is the demo shortcut.
 * "oh" vs "0" normalization happens in the agent prompt before calling this.
 */
function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `1${digits}`;         // 2125550101 → 12125550101
  if (digits.length === 11 && digits.startsWith('1')) return digits; // already 12125550101
  return digits; // unexpected length — best-effort, lookup returns not-found gracefully
}

/**
 * Look up a customer by phone number.
 * Returns customer_id, first_name, last_name — never dob_last4 (that stays server-side).
 */
async function lookupCustomer(phone) {
  const normalized = normalizePhone(phone);
  console.log('[airtable] lookupCustomer phone:[REDACTED] normalized_length:', normalized.length);

  let records;
  try {
    records = await withTimeout(
      base('Customers')
        .select({
          filterByFormula: `{phone} = "${normalized}"`,
          maxRecords: 1,
          fields: ['customer_id', 'first_name', 'last_name'],
        })
        .firstPage()
    );
  } catch (airtableErr) {
    // Log full Airtable error so Render logs show the root cause
    console.error('[airtable] lookupCustomer Airtable error:', airtableErr?.message, airtableErr?.statusCode, JSON.stringify(airtableErr?.error));
    throw airtableErr;
  }

  if (!records || records.length === 0) return { found: false };

  const c = records[0].fields;
  return {
    found: true,
    customer_id: c.customer_id,
    first_name: c.first_name,
    last_name: c.last_name,
  };
}

/**
 * Verify identity using last-4 digits of DOB.
 * dob_last4 is NEVER logged. The comparison happens server-side only.
 * Normalizes the provided value: strips non-digits, takes last 4.
 * Handles "nineteen seventy" → already ASR-normalized by agent prompt to digits before calling.
 */
async function verifyIdentity(customer_id, dob_last4) {
  console.log('[airtable] verifyIdentity customer_id:', customer_id, 'dob:[REDACTED]');

  const records = await withTimeout(
    base('Customers')
      .select({
        filterByFormula: `{customer_id} = "${customer_id}"`,
        maxRecords: 1,
        fields: ['dob_last4'],
      })
      .firstPage()
  );

  if (!records || records.length === 0) return { verified: false };

  const onFile = String(records[0].fields.dob_last4 || '').trim();
  // Caller may say "forty-five twenty-one" → agent normalizes to digits → we take last 4
  const provided = String(dob_last4).replace(/\D/g, '').slice(-4).trim();

  return { verified: onFile === provided };
}

/**
 * Retrieve claim status.
 *
 * customer_id: REQUIRED — always scopes the query (security boundary).
 * claim_id:    OPTIONAL — if omitted, returns all claims for disambiguation.
 *
 * Scope guard: the AND({customer_id}, {claim_id}) filter means a caller-provided
 * claim_id that belongs to a different customer returns found:false — data stays scoped.
 *
 * Returns shape:
 *   Single claim: { found, single:true, claim_id, type, status, status_detail, docs_required, docs_list, last_updated }
 *   Multi claim:  { found, multiple:true, claims: [{claim_id, type, status, status_detail}] }
 *   Not found:    { found: false }
 */
async function getClaimStatus(customer_id, claim_id) {
  if (!customer_id) throw new Error('customer_id is required for getClaimStatus');

  const formula = claim_id
    ? `AND({customer_id} = "${customer_id}", {claim_id} = "${claim_id}")`
    : `{customer_id} = "${customer_id}"`;

  console.log('[airtable] getClaimStatus customer_id:', customer_id, 'claim_id:', claim_id || 'all');

  let records;
  try {
    records = await withTimeout(
      base('Claims')
        .select({
          filterByFormula: formula,
          fields: ['claim_id', 'type', 'status', 'status_detail', 'docs_required', 'docs_list', 'last_updated'],
        })
        .firstPage()
    );
  } catch (airtableErr) {
    console.error('[airtable] getClaimStatus Airtable error:', airtableErr?.message, airtableErr?.statusCode, JSON.stringify(airtableErr?.error));
    throw airtableErr;
  }

  if (!records || records.length === 0) return { found: false };

  // Single specific claim requested and found
  if (claim_id) {
    const c = records[0].fields;
    return {
      found: true,
      single: true,
      claim_id: c.claim_id,
      type: c.type,
      status: c.status,
      // Explicitly null when empty — agent prompt handles null gracefully (never reads "null" aloud)
      status_detail: c.status_detail || null,
      docs_required: c.docs_required === true,
      // docs_list is a multi-select in Airtable — returns array, normalize to comma string
      docs_list: Array.isArray(c.docs_list) ? c.docs_list.join(', ') : (c.docs_list || ''),
      last_updated: c.last_updated || '',
    };
  }

  // No claim_id provided — return full list for disambiguation (no second call needed)
  return {
    found: true,
    multiple: records.length > 1,
    claims: records.map((r) => ({
      claim_id: r.fields.claim_id,
      type: r.fields.type,
      status: r.fields.status,
      status_detail: r.fields.status_detail || null,
    })),
  };
}

/**
 * Write a post-call interaction record.
 * Idempotent: keyed on call_id. If a record already exists for this call_id
 * (e.g., the in-call tool already wrote it), returns early without double-writing.
 *
 * In-memory pendingWrites guard prevents the race condition where call_ended
 * and call_analyzed fire within milliseconds of each other, both pass the
 * DB idempotency check before either write completes, and both insert.
 *
 * The write succeeding or failing must never affect the caller's experience —
 * the tool route handles errors gracefully and the call ends cleanly regardless.
 */

// Guards against concurrent writes for the same call_id (race condition fix)
const pendingWrites = new Set();

async function writeInteractionRecord(data, call_id) {
  console.log('[airtable] writeInteractionRecord call_id:', call_id);

  // In-process guard: if a write for this call_id is already in flight, skip
  if (pendingWrites.has(call_id)) {
    console.log('[airtable] write already in progress for call_id:', call_id, '— skipping');
    return { written: false, reason: 'write_in_progress' };
  }
  pendingWrites.add(call_id);

  try {
    // DB-level idempotency check (catches retries across process restarts)
    const existing = await withTimeout(
      base('Interactions')
        .select({
          filterByFormula: `{call_id} = "${call_id}"`,
          maxRecords: 1,
          fields: ['call_id'],
        })
        .firstPage()
    );

    if (existing && existing.length > 0) {
      console.log('[airtable] idempotency: record already exists for call_id:', call_id);
      return { written: false, reason: 'already_logged' };
    }

    // escalated is a Single Select field in Airtable ("Yes" / omitted).
    // Retell DV interpolation can produce boolean true/false OR the strings
    // "true"/"false" — normalize both before writing.
    const escalatedBool = data.escalated === true || data.escalated === 'true';

    const fields = {
      call_id,
      timestamp: new Date().toISOString(),
      caller_name:    data.caller_name    || '',
      caller_phone:   data.caller_phone   || '',
      customer_id:    data.customer_id    || '',
      claims_checked: data.claims_checked || '',
      call_summary:   data.call_summary   || '',
      sentiment:      data.sentiment      || 'Neutral',
      intent:         data.intent         || 'other',
      resolution:     data.resolution     || 'incomplete',
      ...(escalatedBool ? { escalated: 'Yes' } : {}),
    };

    await withTimeout(base('Interactions').create([{ fields }]));

    console.log('[airtable] interaction record written for call_id:', call_id);
    return { written: true };
  } finally {
    // Always release the lock — even if Airtable throws
    pendingWrites.delete(call_id);
  }
}

/**
 * Write a callback request record to the Callbacks table.
 *
 * This is the in-call write demonstration — the agent calls this when a
 * caller asks to be called back. Unlike post-call writes, this is a
 * deliberate mid-call action with immediate confirmation to the caller.
 *
 * Airtable table required: "Callbacks"
 * Fields: callback_id, customer_id, caller_name, phone, preferred_time, reason, status, created_at
 */
async function createCallbackRequest({ customer_id, caller_name, phone, preferred_time, reason }) {
  // Generate a human-readable ID: CB-<timestamp-last-6>
  const callback_id = `CB-${Date.now().toString().slice(-6)}`;

  console.log('[airtable] createCallbackRequest callback_id:', callback_id, 'customer_id:', customer_id);

  const fields = {
    callback_id,
    customer_id: customer_id || '',
    caller_name: caller_name || '',
    phone: phone || '',
    preferred_time: preferred_time || 'Not specified',
    reason: reason || '',
    status: 'Pending',
    created_at: new Date().toISOString(),
  };

  await withTimeout(base('Callbacks').create([{ fields }]));

  console.log('[airtable] callback request created:', callback_id);
  return { created: true, callback_id };
}

/**
 * Enrich an existing interaction record with post-call analysis data.
 * Called by the call_analyzed webhook handler — fires after call_ended.
 *
 * Finds the record by call_id, then patches only the provided fields.
 * Safe to call multiple times — Airtable update is idempotent.
 *
 * Returns { updated: true } or { updated: false, reason } if not found.
 */
async function updateInteractionRecord(call_id, fields) {
  if (!call_id) throw new Error('call_id required for updateInteractionRecord');

  console.log('[airtable] updateInteractionRecord call_id:', call_id, 'fields:', Object.keys(fields));

  // Locate the existing record
  const records = await withTimeout(
    base('Interactions')
      .select({
        filterByFormula: `{call_id} = "${call_id}"`,
        maxRecords: 1,
        fields: ['call_id'],
      })
      .firstPage()
  );

  if (!records || records.length === 0) {
    console.log('[airtable] updateInteractionRecord: no record found for call_id:', call_id);
    return { updated: false, reason: 'not_found' };
  }

  const airtableRecordId = records[0].id;

  // Patch only the supplied fields — leave everything else untouched
  await withTimeout(base('Interactions').update(airtableRecordId, fields));

  console.log('[airtable] updateInteractionRecord: enriched record for call_id:', call_id);
  return { updated: true };
}

/**
 * Fetch recent callback requests for the dashboard.
 */
async function getRecentCallbacks(limit = 20) {
  try {
    const records = await withTimeout(
      base('Callbacks')
        .select({
          sort: [{ field: 'created_at', direction: 'desc' }],
          maxRecords: limit,
          fields: ['callback_id', 'customer_id', 'caller_name', 'phone', 'preferred_time', 'reason', 'status', 'created_at'],
        })
        .firstPage()
    );

    return (records || []).map((r) => ({
      callback_id:    r.fields.callback_id || '',
      customer_id:    r.fields.customer_id || '',
      caller_name:    r.fields.caller_name || 'Unknown',
      phone:          r.fields.phone || '',
      preferred_time: r.fields.preferred_time || '',
      reason:         r.fields.reason || '',
      status:         r.fields.status || 'Pending',
      created_at:     r.fields.created_at || '',
    }));
  } catch (err) {
    // Callbacks table may not exist yet — return empty rather than crashing dashboard
    console.warn('[airtable] getRecentCallbacks failed (table may not exist yet):', err.message);
    return [];
  }
}

/**
 * Fetch recent interaction records for the dashboard.
 * Returns the most recent `limit` records sorted newest-first.
 */
async function getRecentInteractions(limit = 20) {
  const records = await withTimeout(
    base('Interactions')
      .select({
        sort: [{ field: 'timestamp', direction: 'desc' }],
        maxRecords: limit,
        fields: ['call_id', 'timestamp', 'caller_name', 'customer_id', 'sentiment', 'intent', 'resolution', 'escalated'],
      })
      .firstPage()
  );

  return (records || []).map((r) => ({
    call_id: r.fields.call_id || '',
    timestamp: r.fields.timestamp || '',
    caller_name: r.fields.caller_name || 'Unknown',
    customer_id: r.fields.customer_id || '',
    sentiment: r.fields.sentiment || 'Neutral',
    intent: r.fields.intent || 'other',
    resolution: r.fields.resolution || 'incomplete',
    escalated: r.fields.escalated === 'Yes',
  }));
}

module.exports = {
  lookupCustomer,
  verifyIdentity,
  getClaimStatus,
  createCallbackRequest,
  writeInteractionRecord,
  updateInteractionRecord,
  getRecentInteractions,
  getRecentCallbacks,
};
