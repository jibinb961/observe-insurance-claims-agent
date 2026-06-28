/**
 * In-memory session cache for customer lookups.
 * Prevents repeat Airtable hits for the same caller within a call window.
 * TTL-based — entries expire automatically; no manual eviction needed.
 *
 * Production replacement: Redis with the same get/set/del interface.
 * Swap the store implementation without touching callers.
 */

const store = new Map();
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes — longer than any realistic call

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function del(key) {
  store.delete(key);
}

function size() {
  return store.size;
}

module.exports = { get, set, del, size };
