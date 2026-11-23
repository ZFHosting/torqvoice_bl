/**
 * Request budgets for the public API (docs/fork/API.md §3, "Rate limit"). In-process, like upstream's
 * limiter (src/lib/rate-limit.ts): fine for the single container the app runs in.
 *
 * - Per key: upstream counts per token **per path**, but an integration spreads its calls over many
 *   paths, so the API counts per key across all of them. A route that sets its own limit or window
 *   counts in a bucket for that setting (routes with the same setting share it), so it neither eats
 *   the key's default budget nor changes its window.
 * - Per address, for failed authentication: a caller presenting bad keys is turned away before the
 *   key lookup and the HMAC, the cheap refusal first, as upstream's withApiAuth does.
 */
const DEFAULT_LIMIT = 120
const DEFAULT_WINDOW_MS = 60_000
/** Failed authentications an address may make in a minute before it is refused outright. */
export const FAILED_AUTH_LIMIT = 30
const FAILED_AUTH_WINDOW_MS = 60_000

interface Window {
  count: number
  resetAt: number
}

const buckets = new Map<string, Window>()
const failures = new Map<string, Window>()

export interface Budget {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
}

function tick(store: Map<string, Window>, key: string, windowMs: number, now: number): Window {
  let window = store.get(key)
  if (!window || now >= window.resetAt) {
    window = { count: 0, resetAt: now + windowMs }
    store.set(key, window)
  }
  return window
}

const retryAfter = (window: Window, now: number) =>
  Math.max(1, Math.ceil((window.resetAt - now) / 1000))

export function consumeKeyBudget(
  apiKeyId: string,
  options: { limit?: number; windowMs?: number } = {},
  now = Date.now()
): Budget {
  const limit = options.limit ?? DEFAULT_LIMIT
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const own = options.limit !== undefined || options.windowMs !== undefined
  const window = tick(buckets, own ? `${apiKeyId}|${limit}|${windowMs}` : apiKeyId, windowMs, now)
  window.count++
  const allowed = window.count <= limit
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - window.count),
    retryAfterSeconds: allowed ? 0 : retryAfter(window, now),
  }
}

/** Seconds until this address may try again, or null when it isn't being refused. */
export function failedAuthRetryAfter(address: string, now = Date.now()): number | null {
  const window = failures.get(address)
  if (!window || now >= window.resetAt || window.count < FAILED_AUTH_LIMIT) return null
  return retryAfter(window, now)
}

export function recordFailedAuth(address: string, now = Date.now()): void {
  tick(failures, address, FAILED_AUTH_WINDOW_MS, now).count++
}

/** For tests. */
export function resetKeyBudgets() {
  buckets.clear()
  failures.clear()
}

// Drop finished windows now and then, so revoked keys and passing addresses don't linger.
const sweep = setInterval(() => {
  const now = Date.now()
  for (const store of [buckets, failures]) {
    for (const [key, window] of store) if (now >= window.resetAt) store.delete(key)
  }
}, 5 * 60_000)
sweep.unref?.()
