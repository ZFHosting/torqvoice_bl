/**
 * fork: Shopmonkey's webhooks (docs/fork/milestones/M7-delta-and-cutover.md, MAPPING §1). Deliveries are signed per
 * the Standard Webhooks spec: `webhook-id`, `webhook-timestamp` (seconds) and `webhook-signature` (one or more
 * `v1,<base64>`, space-separated, so a rotated secret can sign beside the old one), an HMAC-SHA256 of
 * `id.timestamp.body` keyed with the secret (`whsec_<base64>`). PROVISIONAL(M0:S1): from the docs; re-check with a
 * recorded delivery.
 *
 * The payload is never trusted: a verified delivery only says which record to fetch again (`refetch`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** How far a delivery's timestamp may be from now, either way: older is a replay, newer a wrong clock. */
export const TOLERANCE_SECONDS = 5 * 60

export type SignatureCheck =
  | { ok: true }
  | {
      ok: false
      reason: 'missing_headers' | 'bad_timestamp' | 'stale' | 'bad_secret' | 'no_match'
    }

/** The key bytes of a Standard Webhooks secret: base64 after the `whsec_` prefix (or the whole value without one). */
export function secretKey(secret: string): Buffer | null {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null
  const key = Buffer.from(raw, 'base64')
  return key.length ? key : null
}

export function sign(key: Buffer, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')
}

/** Whether a delivery is signed with this secret and recent: one `v1` signature of the list matching is enough. */
export function verifySignature(input: {
  id: string | null
  timestamp: string | null
  signature: string | null
  body: string
  secret: string
  now?: Date
}): SignatureCheck {
  const { id, timestamp, signature, body } = input
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' }
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale' }
  }
  const key = secretKey(input.secret)
  if (!key) return { ok: false, reason: 'bad_secret' }
  const expected = Buffer.from(sign(key, id, timestamp, body), 'base64')
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',')
    if (version !== 'v1' || !value) continue
    const given = Buffer.from(value, 'base64')
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true }
  }
  return { ok: false, reason: 'no_match' }
}
