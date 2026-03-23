export const TOKEN_BUCKET_CAPACITY = 100;

export const TOKEN_BUCKET_REFILL_PER_SEC = 10;

/** Tokens consumed per HTTP request. */
export const TOKEN_BUCKET_COST = 1;

type BucketState = {
  tokens: number;
  lastMs: number;
};

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  /**
   * Attempt to consume one token for `ip`. Updates bucket state.
   * @returns ok, or retry hint in whole seconds for Retry-After.
   */
  tryConsume(
    ip: string,
    nowMs: number
  ): { ok: true } | { ok: false; retryAfterSec: number } {
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
  if (!addr) return "unknown";
  if (addr.startsWith("::ffff:")) return addr.slice("::ffff:".length);
  return addr;
}
