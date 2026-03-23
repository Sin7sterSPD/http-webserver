export const TOKEN_BUCKET_CAPACITY = 100;

export const TOKEN_BUCKET_REFILL_PER_SEC = 10;

/** Tokens consumed per HTTP request. */
export const TOKEN_BUCKET_COST = 1;

/**
 * Idle time after which a bucket is at CAPACITY in the mathematical model (empty → full
 * takes CAPACITY/REFILL seconds). Evicting then only drops redundant state; active clients
 * touch lastMs often and are never removed. Under high traffic, eviction is rare O(n) work
 * amortized over EVICT_EVERY tryConsume calls; the hot path stays Map get + arithmetic.
 */
export const STALE_IDLE_MS =
  (TOKEN_BUCKET_CAPACITY / TOKEN_BUCKET_REFILL_PER_SEC) * 1000;

/** How often tryConsume triggers a lazy sweep (power of two for cheap bitmask). */
const EVICT_EVERY = 256;

type BucketState = {
  tokens: number;
  lastMs: number;
};

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private tryConsumeCount = 0;

  /**
   * Remove buckets whose last use was long enough ago that they would already be full
   * if simulated forward — safe to drop and recreate on next hit as a fresh bucket.
   */
  evictStale(nowMs: number): void {
    const cutoff = nowMs - STALE_IDLE_MS;
    for (const [ip, state] of this.buckets) {
      if (state.lastMs < cutoff) {
        this.buckets.delete(ip);
      }
    }
  }

  /**
   * Attempt to consume one token for `ip`. Updates bucket state.
   * @returns ok, or retry hint in whole seconds for Retry-After.
   */
  tryConsume(
    ip: string,
    nowMs: number
  ): { ok: true } | { ok: false; retryAfterSec: number } {
    if ((++this.tryConsumeCount & (EVICT_EVERY - 1)) === 0) {
      this.evictStale(nowMs);
    }

    let b = this.buckets.get(ip);
    if (!b) {
      b = { tokens: TOKEN_BUCKET_CAPACITY, lastMs: nowMs };
      this.buckets.set(ip, b);
    }

    const elapsedSec = (nowMs - b.lastMs) / 1000;
    let tokens = Math.min(
      TOKEN_BUCKET_CAPACITY,
      b.tokens + elapsedSec * TOKEN_BUCKET_REFILL_PER_SEC
    );
    b.lastMs = nowMs;

    if (tokens >= TOKEN_BUCKET_COST) {
      b.tokens = tokens - TOKEN_BUCKET_COST;
      return { ok: true };
    }

    b.tokens = tokens;
    const needed = TOKEN_BUCKET_COST - tokens;
    const retryAfterSec = Math.max(
      1,
      Math.ceil(needed / TOKEN_BUCKET_REFILL_PER_SEC)
    );
    return { ok: false, retryAfterSec };
  }
}

/** Collapse IPv4-mapped IPv6 so one client maps to one bucket key. */
export function normalizeClientIp(addr: string | undefined): string {
  if (!addr) {
    console.warn(
      "remoteAddress is undefined; rate-limiting will not work correctly"
    );
    return "unknown";
  }
  if (addr.startsWith("::ffff:")) return addr.slice("::ffff:".length);
  return addr;
}
