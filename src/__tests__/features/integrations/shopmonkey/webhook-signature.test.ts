/**
 * @vitest-environment node
 *
 * fork: Shopmonkey webhook signatures (M7 acceptance: valid, tampered body, wrong secret, old timestamp, rotated
 * secret with two signatures), per the Standard Webhooks spec. SYNTHETIC secrets and bodies.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { secretKey, sign, verifySignature } from '@/integrations/shopmonkey/webhook'

const NOW = new Date('2026-01-01T12:00:00.000Z')
const SECONDS = String(Math.floor(NOW.getTime() / 1000))
const secretOf = () => `whsec_${randomBytes(24).toString('base64')}`
const SECRET = secretOf()
const BODY = JSON.stringify({ operation: 'UPDATE', table: 'order', data: { id: 'syn_ord_1002' } })
const ID = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W'

const signed = (secret: string, body = BODY, timestamp = SECONDS) =>
  `v1,${sign(secretKey(secret) as Buffer, ID, timestamp, body)}`

const check = (signature: string, over: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  verifySignature({
    id: ID,
    timestamp: SECONDS,
    signature,
    body: BODY,
    secret: SECRET,
    now: NOW,
    ...over,
  })

describe('a Shopmonkey webhook signature', () => {
  it('is valid when signed with the secret, over id, timestamp and body', () => {
    expect(check(signed(SECRET))).toEqual({ ok: true })
  })

  it('is refused for a tampered body', () => {
    expect(check(signed(SECRET), { body: BODY.replace('1002', '1003') })).toEqual({
      ok: false,
      reason: 'no_match',
    })
  })

  it('is refused when signed with another secret', () => {
    expect(check(signed(secretOf()))).toEqual({ ok: false, reason: 'no_match' })
  })

  it('is refused when its timestamp is more than five minutes from now, either way', () => {
    const old = String(Number(SECONDS) - 301)
    expect(check(signed(SECRET, BODY, old), { timestamp: old })).toEqual({
      ok: false,
      reason: 'stale',
    })
    const ahead = String(Number(SECONDS) + 301)
    expect(check(signed(SECRET, BODY, ahead), { timestamp: ahead })).toEqual({
      ok: false,
      reason: 'stale',
    })
    // Just inside the window.
    const recent = String(Number(SECONDS) - 299)
    expect(check(signed(SECRET, BODY, recent), { timestamp: recent })).toEqual({ ok: true })
  })

  it('is valid while a secret is rotated: one of two signatures matching is enough', () => {
    const rotated = secretOf()
    const both = `${signed(rotated)} ${signed(SECRET)}`
    expect(check(both)).toEqual({ ok: true })
    expect(check(both, { secret: rotated })).toEqual({ ok: true })
    expect(check(both, { secret: secretOf() })).toEqual({ ok: false, reason: 'no_match' })
  })

  it('is refused without its headers, with a timestamp that isn’t seconds, or a secret that isn’t one', () => {
    expect(check(signed(SECRET), { id: null })).toEqual({ ok: false, reason: 'missing_headers' })
    expect(check(signed(SECRET), { timestamp: '2026-01-01' })).toEqual({
      ok: false,
      reason: 'bad_timestamp',
    })
    expect(check(signed(SECRET), { secret: 'whsec_' })).toEqual({ ok: false, reason: 'bad_secret' })
    // Another version's signature is not a v1 one.
    expect(check(signed(SECRET).replace('v1,', 'v2,'))).toEqual({ ok: false, reason: 'no_match' })
  })
})
