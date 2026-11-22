/**
 * A per-key request budget for the public API (docs/fork/API.md §3, "Rate limit"). Upstream's limiter
 * (src/lib/rate-limit.ts) counts per address or token per path; an integration spreads its calls over
 * many paths, so the API counts per key across all of them. In-process, like upstream's: fine for the
 * single container the app runs in.
 */
const DEFAULT_LIMIT = 120
const DEFAULT_WINDOW_MS = 60_000

const buckets = new Map<string, { count: number; resetAt: number }>()

export interface Budget {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
}

export function consumeKeyBudget(
  apiKeyId: string,
  options: { limit?: number; windowMs?: number } = {},
  now = Date.now()
): Budget {
  const limit = options.limit ?? DEFAULT_LIMIT
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  let bucket = buckets.get(apiKeyId)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(apiKeyId, bucket)
  }
  bucket.count++
  const allowed = bucket.count <= limit
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  }
}

/** For tests. */
export function resetKeyBudgets() {
  buckets.clear()
}

// Drop finished windows now and then, so revoked keys don't linger.
const sweep = setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key)
}, 5 * 60_000)
sweep.unref?.()
