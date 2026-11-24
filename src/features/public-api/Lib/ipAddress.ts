/**
 * fork (A6, SECURITY-REVIEW.md): one spelling per address, so an API key's IP allowlist matches the address a request
 * comes from however either is written. An IPv4 address reached over IPv6 (`::ffff:203.0.113.7`) is the IPv4 address;
 * an IPv6 address is lower-case and compressed (`2001:DB8:0:0::1` is `2001:db8::1`). Anything else is kept as written,
 * trimmed, so a typo in the allowlist matches nothing rather than everything.
 */
import { isIP } from 'node:net'

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/

export function canonicalIp(raw: string): string {
  const ip = raw.trim()
  const mapped = MAPPED_V4.exec(ip)
  if (mapped && isIP(mapped[1]) === 4) return mapped[1]
  if (isIP(ip) === 6) {
    try {
      const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
      // The parser writes a mapped IPv4 address in hex (`::ffff:cb00:7107`): back to the IPv4 address.
      const hex = MAPPED_HEX.exec(canonical)
      if (hex) {
        const [hi, lo] = [Number.parseInt(hex[1], 16), Number.parseInt(hex[2], 16)]
        return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
      }
      return canonical
    } catch {
      return ip.toLowerCase()
    }
  }
  return ip
}

/** Whether a request's address is on a key's allowlist. */
export function allowlisted(allowlist: string[], address: string): boolean {
  const ip = canonicalIp(address)
  return allowlist.some((entry) => canonicalIp(entry) === ip)
}
