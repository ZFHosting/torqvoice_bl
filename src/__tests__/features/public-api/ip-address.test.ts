/**
 * @vitest-environment node
 *
 * fork (A6, SECURITY-REVIEW.md): an API key's IP allowlist matches an address however either side is written.
 */
import { describe, expect, it } from 'vitest'
import { allowlisted, canonicalIp } from '@/features/public-api/Lib/ipAddress'

describe('canonicalIp', () => {
  it('reads an IPv4 address reached over IPv6 as the IPv4 address, in either spelling', () => {
    expect(canonicalIp('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(canonicalIp('::FFFF:CB00:7107')).toBe('203.0.113.7')
    expect(canonicalIp(' 203.0.113.7 ')).toBe('203.0.113.7')
  })

  it('writes an IPv6 address lower-case and compressed', () => {
    expect(canonicalIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1')
    expect(canonicalIp('2001:db8::1')).toBe('2001:db8::1')
  })

  it('keeps what isn’t an address as written, so it matches nothing', () => {
    expect(canonicalIp('not-an-ip')).toBe('not-an-ip')
  })
})

describe('allowlisted', () => {
  it('matches across spellings, and nothing else', () => {
    expect(allowlisted(['203.0.113.7'], '::ffff:203.0.113.7')).toBe(true)
    expect(allowlisted(['2001:DB8::1'], '2001:db8:0:0::1')).toBe(true)
    expect(allowlisted(['203.0.113.7'], '203.0.113.8')).toBe(false)
    expect(allowlisted(['2001:db8::1'], '2001:db8::2')).toBe(false)
  })
})
