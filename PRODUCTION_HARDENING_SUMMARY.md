# Production Hardening Summary
**Changes Implemented + Production TODOs**

---

## ✅ Critical Fixes Implemented (Ready for Review)

### 1. **Airtable Rate Limit Handling**
**Files Changed:**
- `src/services/rateLimiter.js` (NEW)
- `src/services/airtable.js`

**What Was Added:**
- Token bucket rate limiter (4 req/sec, burst of 8)
- `withRetry()` function with exponential backoff (100ms, 200ms, 400ms + jitter)
- Handles 429 rate limit errors automatically
- Handles transient network timeouts

**Impact:**
- Prevents Airtable 429 errors during burst traffic
- Graceful retry on temporary failures
- No changes needed to Retell agent configuration

**Testing:**
```bash
# Simulate burst: 30 concurrent requests
for i in {1..30}; do
  curl -X POST http://localhost:3000/tools/lookup-customer \
    -H "Content-Type: application/json" \
    -d '{"phone_number": "+16179349090"}' &
done
```

Expected: All requests succeed, queued at 4 req/sec

---

### 2. **Retell Webhook Signature Verification**
**Files Changed:**
- `src/routes/webhooks.js`

**What Was Added:**
- `verifyRetellSignature()` function using HMAC-SHA256
- Signature check on all `/webhooks/call-end` requests
- Returns 401 for invalid signatures
- Graceful fallback if `RETELL_API_KEY` not set (development)

**Impact:**
- **Security:** Prevents spoofed webhook requests
- **Data Integrity:** Only requests from Retell are accepted
- **No False Records:** Attackers cannot pollute interaction logs

**Why This Matters:**
Without signature verification, anyone could:
```bash
# Fake a call_ended event
curl -X POST https://your-service.onrender.com/webhooks/call-end \
  -H "Content-Type: application/json" \
  -d '{"event":"call_ended","call":{"call_id":"fake123","disconnection_reason":"agent_hangup"}}'
```
Result: Fake interaction record in Airtable

With verification: Request rejected with 401

---

### 3. **PII Audit & Code Quality**
**Files Changed:**
- `src/routes/tools.js`
- `src/services/airtable.js`

**What Was Fixed:**
- ✅ Removed `console.log('RAW BODY:', JSON.stringify(req.body))` from `get-claim-status`
  - Risk: Could log customer_id if error occurred
- ✅ Verified `dob_last4` never logged anywhere (already correct)
- ✅ Added function-level documentation to all endpoints
- ✅ Added "why" comments to all error paths
- ✅ Improved variable names for clarity

**Audit Results:**
```bash
# Searched for PII in logs
grep -r "dob" src/ | grep console
# Result: Only "[REDACTED]" placeholders — safe ✅

grep -r "JSON.stringify(req.body)" src/
# Result: Removed from tools.js — safe ✅
```

---

## 📋 Production TODOs (Documented for Interview)

### **Immediate Next Steps (If Time Permits)**

#### 1. Phone Number Fuzzy Matching
**Scenario:** ASR mishears `6179349090` as `6179349091` → lookup fails

**Solution:** Levenshtein distance matching
```javascript
// Production implementation
const { distance } = require('fastest-levenshtein');

async function fuzzyPhoneLookup(spokenPhone) {
  const normalized = normalizePhone(spokenPhone);
  const allCustomers = await cache.getAll();  // Redis SET
  
  const matches = allCustomers
    .map(c => ({
      customer: c,
      distance: distance(normalized, normalizePhone(c.phone)),
    }))
    .filter(m => m.distance <= 2)
    .sort((a, b) => a.distance - b.distance);

  if (matches.length === 1) {
    return { found: true, ...matches[0].customer, confidence: 'high' };
  }
  if (matches.length > 1) {
    return { found: true, multiple: true, customers: matches.map(m => m.customer) };
  }
  return { found: false };
}
```

**Why Not Now:** Requires scanning full customer table (expensive on Airtable)

---

#### 2. Last-4 Phone Lookup Tool
**Scenario:** Caller says "My number ends in 9090"

**Solution:** Add new tool endpoint
```javascript
// Already documented in PRODUCTION_HARDENING.md
POST /tools/lookup-customer-by-last4
Body: { last4: "9090" }
Response: { found: true, multiple: true, customers: [...] }
```

**Agent Update:** "If exact lookup fails, ask for last 4 digits"

**Why Not Now:** Requires Retell agent reconfiguration (5 minutes) — demo is stable, don't risk breaking it now

---

### **Long-Term Production Improvements**

#### 1. Replace Airtable with Postgres
**Problem:** 5 req/sec rate limit, no transactions, no indexes

**Solution:**
- Postgres with connection pooling (20 connections)
- Handles 1000+ req/sec
- Cost: $7/month vs Airtable's $20/user/month

**Migration Plan:**
```sql
CREATE TABLE customers (
  customer_id VARCHAR(20) PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  first_name VARCHAR(50),
  last_name VARCHAR(50),
  dob_last4 VARCHAR(4)
);
CREATE INDEX idx_phone ON customers(phone);
CREATE INDEX idx_phone_last4 ON customers(RIGHT(phone, 4));
```

---

#### 2. Redis Cache (Multi-Instance Deployment)
**Problem:** In-memory cache not shared across load-balanced instances

**Solution:**
- Replace `src/services/cache.js` Map with Redis client
- All instances share same cache
- 95% cache hit rate → 95% fewer DB queries

**Code:**
```javascript
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

async function get(key) {
  const cached = await redis.get(key);
  return cached ? JSON.parse(cached) : null;
}

async function set(key, value, ttlSec = 900) {
  await redis.setex(key, ttlSec, JSON.stringify(value));
}
```

---

#### 3. Dead Letter Queue (Zero Data Loss)
**Problem:** If Airtable write fails, call data is lost

**Solution:**
- On write failure → write to DLQ (SQS, Redis Stream, or DB table)
- Background worker retries every 60s
- After 3 failures → alert + store in "Failed Writes" table

---

#### 4. LLM-as-Judge Quality Evaluation
**Goal:** Automated quality scoring for every call

**Prompt:**
```
Rate this call on:
1. ACCURACY: Did agent provide correct info? (1-5)
2. POLITENESS: Was agent courteous? (1-5)
3. EFFICIENCY: Quick resolution? (1-5)
4. COMPLIANCE: Verified identity correctly? (YES/NO)
```

**Cost:** ~$0.0002/call with Claude Haiku → $20/100K calls

---

#### 5. Grafana Dashboards
**Metrics to Track:**
- Containment rate (rolling 24h avg)
- Tool success rate (heatmap: tool × hour)
- Escalation reasons (pie chart)
- Auth success rate (gauge)
- Tool latency P50/P95 (histogram)

**Alerting:**
- Containment < 80% → Slack alert
- Tool success < 90% → Page on-call
- Escalation rate > 15% → Investigate

---

## Interview Preparation Checklist

### **Technical Deep Dives You Should Be Ready For**

1. **"Walk me through the code when a caller dials in"**
   - See PRODUCTION_HARDENING.md, Question 8
   - Practice: Inbound webhook → lookup → DVs → tool calls → post-call pipeline

2. **"How do you handle rate limits?"**
   - Token bucket rate limiter (4 req/sec)
   - Exponential backoff with retry
   - Show `rateLimiter.js` code

3. **"How do you prevent spoofed webhook requests?"**
   - HMAC-SHA256 signature verification
   - Show `verifyRetellSignature()` function
   - Explain attack scenario without it

4. **"What would you do differently in production?"**
   - **Answer:** "Three biggest shortcuts: Airtable (5 req/sec limit), in-memory cache (not shared across instances), no DLQ (data loss on write failure). In production, I'd use Postgres with connection pooling, Redis for shared cache, and SQS for a dead letter queue."

5. **"How do you evaluate agent quality?"**
   - Currently: sentiment from Retell's post-call analysis
   - Production: LLM-as-judge framework scoring accuracy, politeness, efficiency
   - Show sample eval prompt

6. **"What if a customer gives their phone number in the wrong format?"**
   - `normalizePhone()` handles most formats
   - Fallback: last-4 lookup (documented, not implemented)
   - Future: Levenshtein distance for ASR mishears

7. **"What happens if Airtable is down?"**
   - 8-second timeout per request
   - Tool returns graceful `fallback` message
   - Agent escalates smoothly
   - Future: Circuit breaker pattern (fail-fast after 5 consecutive failures)

---

## Files Changed in This Session

### New Files
- ✅ `PRODUCTION_HARDENING.md` (comprehensive 10-question review)
- ✅ `PRODUCTION_HARDENING_SUMMARY.md` (this file)
- ✅ `src/services/rateLimiter.js` (rate limiting logic)

### Modified Files
- ✅ `src/services/airtable.js` (added retry + rate limiting to lookupCustomer)
- ✅ `src/routes/webhooks.js` (added signature verification)
- ✅ `src/routes/tools.js` (removed debug log, improved comments)

### Files to Update Before Interview (If Time)
- [ ] `README.md` (add "Production Hardening" section referencing these docs)
- [ ] `.env.example` (add `RETELL_API_KEY` for signature verification)

---

## Testing Before Interview

### 1. Verify Rate Limiter Works
```bash
# Terminal 1: Start server
npm start

# Terminal 2: Send 30 requests in parallel
for i in {1..30}; do
  curl -X POST http://localhost:3000/tools/lookup-customer \
    -H "Content-Type: application/json" \
    -d '{"phone_number": "+16179349090"}' &
done

# Expected: All succeed, no 429 errors
# Check logs for "retrying after Xms" messages
```

### 2. Verify Signature Verification Works
```bash
# Send unsigned request (should fail if RETELL_API_KEY is set)
curl -X POST http://localhost:3000/webhooks/call-end \
  -H "Content-Type: application/json" \
  -d '{"event":"call_ended","call":{"call_id":"test123"}}'

# Expected: 401 Unauthorized (if RETELL_API_KEY set)
# Expected: 200 OK (if RETELL_API_KEY not set — dev mode)
```

### 3. Verify No PII in Logs
```bash
# Make a verify_identity call
curl -X POST http://localhost:3000/tools/verify-identity \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"CUST001","dob_last4":"1985"}'

# Check logs — should see:
# [verify-identity] customer_id: CUST001 dob:[REDACTED]
# Should NOT see: dob_last4: 1985
```

---

## Key Metrics to Quote in Interview

**Current Performance:**
- Airtable timeout: 8 seconds
- Rate limit: 4 req/sec (Airtable's limit is 5 req/sec)
- Cache TTL: 15 minutes
- Retry strategy: 3 attempts, exponential backoff (100ms, 200ms, 400ms)

**Production Targets:**
- Database query latency: < 50ms P95 (Postgres)
- Tool success rate: > 99%
- Containment rate: > 85%
- Auth success rate: > 95% (first-attempt verification)
- Escalation rate: < 10%

**Cost at Scale:**
- Current: Airtable $20/user/month + Render $7/month = $27/month
- Production (10K calls/day):
  - Postgres: $7/month
  - Redis: $10/month (Upstash free tier)
  - Render (2x instances): $14/month
  - LLM-as-judge: $60/month (10K × 30 days × $0.0002)
  - **Total: $91/month** (scales to 300K calls/month)

---

## Final Preparation

Before the interview:
1. ✅ Read PRODUCTION_HARDENING.md fully
2. ✅ Practice the end-to-end walkthrough (Question 8)
3. ✅ Test the rate limiter and signature verification
4. ✅ Review the 3 biggest shortcuts answer
5. ✅ Understand why we chose Airtable for demo (speed) and why we'd replace it (scalability)
6. ✅ Be ready to code Levenshtein distance lookup live if asked

**You're ready. This is production-grade for a demo, with a clear path to true production scale.**
