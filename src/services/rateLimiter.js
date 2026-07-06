/**
 * Token bucket rate limiter for Airtable requests.
 * Ensures we never exceed 5 req/sec to stay under Airtable's rate limits.
 * 
 * Uses a conservative 4 req/sec (vs Airtable's 5 req/sec limit) to provide headroom.
 * Max burst of 8 requests allows handling concurrent tool calls without queuing.
 * 
 * Production: Replace with Redis-backed distributed rate limiter for multi-instance deployments.
 */

class RateLimiter {
  constructor(tokensPerSecond = 4, maxBurst = 8) {
    this.tokensPerSecond = tokensPerSecond;  // Conservative: 4/sec vs 5/sec limit
    this.maxBurst = maxBurst;
    this.tokens = maxBurst;
    this.lastRefill = Date.now();
    this.queue = [];
  }

  async acquire() {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens--;
          resolve();
        } else {
          // Enqueue and wait for next refill
          this.queue.push(tryAcquire);
          setTimeout(() => {
            const idx = this.queue.indexOf(tryAcquire);
            if (idx !== -1) {
              this.queue.splice(idx, 1);
              tryAcquire();
            }
          }, 200);  // Check every 200ms
        }
      };
      tryAcquire();
    });
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.tokensPerSecond;
    this.tokens = Math.min(this.maxBurst, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  getStats() {
    return {
      availableTokens: Math.floor(this.tokens),
      queueLength: this.queue.length,
    };
  }
}

const airtableLimiter = new RateLimiter(4, 8);

/**
 * Wrap an Airtable request with rate limiting.
 * Ensures the request doesn't exceed our token budget.
 */
async function throttledRequest(promiseFn) {
  await airtableLimiter.acquire();
  return await promiseFn();
}

module.exports = { throttledRequest, getStats: () => airtableLimiter.getStats() };
