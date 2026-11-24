/**
 * Request budgets for the public API (docs/fork/API.md §3, "Rate limit"). In-process, like upstream's
 * limiter (src/lib/rate-limit.ts): fine for the single container the app runs in.
 *
 * - Per key: upstream counts per token **per path**, but an integration spreads its calls over many
 *   paths, so the API counts per key across all of them. A route that sets its own limit or window
 *   counts in a bucket for that setting (routes with the same setting share it), so it neither eats
 *   the key's default budget nor changes its window.
 * - Per address, for failed authentication: a caller presenting bad keys is turned away before the
 *   key lookup and the HMAC, the cheap refusal first, as upstream's withApiAuth does. A key that has
 *   authenticated from that address in the last ten minutes still gets through, up to its own count of
 *   failures (A6, SECURITY-REVIEW.md item 9): someone who can spoof an integration's address can't lock its
 *   working key out, only keys that address hasn't used yet.
 */
import { canonicalIp } from './ipAddress'

const DEFAULT_LIMIT = 120
const DEFAULT_WINDOW_MS = 60_000
/** Failed authentications an address may make in a minute before it is refused outright. */
export const FAILED_AUTH_LIMIT = 30
const FAILED_AUTH_WINDOW_MS = 60_000
/** How long a key that authenticated from an address keeps getting past that address's block. */
const TRUSTED_MS = 10 * 60_000
/** No address is longer (an IPv6 address with a zone is under 64): a header can't grow the maps' keys. */
const MAX_ADDRESS_LENGTH = 64

interface Window {
  count: number
  resetAt: number
}

const buckets = new Map<string, Window>()
const failures = new Map<string, Window>()
/** A key's own failures from an address, apart from the address's: no address header can name one. */
const pairFailures = new Map<string, Window>()
/** `<address>|<key prefix>` → until when that key gets past the address's block. */
const trusted = new Map<string, number>()

/** One entry per address however it is written. */
const addressKey = (address: string) => canonicalIp(address).slice(0, MAX_ADDRESS_LENGTH)
const pairKey = (address: string, prefix: string) => `${addressKey(address)}|${prefix}`

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

const blockedBy = (window: Window | undefined, now: number) =>
  window !== undefined && now < window.resetAt && window.count >= FAILED_AUTH_LIMIT

/**
 * Seconds until a request from this address, presenting a key with this prefix, may try again; null when it isn't
 * being refused. A key that authenticated from the address lately gets past the address's block, until it fails as
 * often itself.
 */
export function failedAuthRetryAfter(
  address: string,
  prefix: string | null = null,
  now = Date.now()
): number | null {
  if (prefix && (trusted.get(pairKey(address, prefix)) ?? 0) > now) {
    const own = pairFailures.get(pairKey(address, prefix))
    return blockedBy(own, now) && own ? retryAfter(own, now) : null
  }
  const window = failures.get(addressKey(address))
  return blockedBy(window, now) && window ? retryAfter(window, now) : null
}

export function recordFailedAuth(
  address: string,
  prefix: string | null = null,
  now = Date.now()
): void {
  tick(failures, addressKey(address), FAILED_AUTH_WINDOW_MS, now).count++
  if (prefix) tick(pairFailures, pairKey(address, prefix), FAILED_AUTH_WINDOW_MS, now).count++
}

/** A key authenticated from this address: it gets past the address's block for a while. */
export function recordGoodAuth(address: string, prefix: string, now = Date.now()): void {
  trusted.set(pairKey(address, prefix), now + TRUSTED_MS)
}

/** For tests. */
export function resetKeyBudgets() {
  buckets.clear()
  failures.clear()
  pairFailures.clear()
  trusted.clear()
}

// Drop finished windows now and then, so revoked keys and passing addresses don't linger.
const sweep = setInterval(() => {
  const now = Date.now()
  for (const store of [buckets, failures, pairFailures]) {
    for (const [key, window] of store) if (now >= window.resetAt) store.delete(key)
  }
  for (const [key, until] of trusted) if (now >= until) trusted.delete(key)
}, 5 * 60_000)
sweep.unref?.()
