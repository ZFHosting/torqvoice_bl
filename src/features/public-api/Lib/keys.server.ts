/**
 * Public API keys (docs/fork/API.md §2): create, verify, revoke.
 *
 * A key is `tvk_<prefix>_<secret>`: an 8-character prefix that finds the row and is safe to show,
 * and 32 random bytes in base64url. Only an HMAC-SHA256 of the whole key is stored, peppered with
 * API_KEY_PEPPER, and it is compared in constant time. The plaintext is returned once, by
 * `createApiKey`, and never stored or logged.
 *
 * Each key acts as its own service user: a User with no password and no way to sign in, a member of
 * the workshop with the role the owner picked. Its permissions come from the same roles screen as
 * staff, and every record the API writes has a real user behind it.
 */
import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { allowlisted } from './ipAddress'
import { db } from '@/lib/db'

/** Lower-case letters and digits without the look-alikes (l, 0, 1), for a prefix read off a screen. */
const PREFIX_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'
const KEY_RE = /^tvk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/
/** `lastUsedAt` is written at most this often, so a busy key isn't a write per request. */
export const LAST_USED_THROTTLE_MS = 60_000

/**
 * The HMAC key. API_KEY_PEPPER when set (16+ characters); otherwise one derived from
 * BETTER_AUTH_SECRET, which every install already has, under its own label so the two secrets
 * never produce the same hash. Changing either invalidates every key.
 */
function pepper(): string {
  const value = process.env.API_KEY_PEPPER
  if (value) {
    // Set but too short is a mistake, not a choice: falling back silently would make every key
    // stop working the day it is fixed.
    if (value.length < 16) throw new Error('API_KEY_PEPPER must be at least 16 characters.')
    return value
  }
  const fallback = process.env.BETTER_AUTH_SECRET
  if (!fallback) throw new Error('Set API_KEY_PEPPER (openssl rand -hex 32) to use API keys.')
  return `torqvoice-api-key-pepper:${fallback}`
}

export function hashApiKey(key: string): string {
  return createHmac('sha256', pepper()).update(key).digest('hex')
}

function newPrefix(): string {
  return [...randomBytes(8)].map((b) => PREFIX_ALPHABET[b % PREFIX_ALPHABET.length]).join('')
}

export class ApiKeyRoleError extends Error {
  constructor() {
    super('That role does not belong to this workshop.')
    this.name = 'ApiKeyRoleError'
  }
}

export interface CreateApiKeyInput {
  organizationId: string
  name: string
  roleId: string
  createdById: string
  expiresAt?: Date | null
  ipAllowlist?: string[]
}

export async function createApiKey(input: CreateApiKeyInput) {
  const prefix = newPrefix()
  const key = `tvk_${prefix}_${randomBytes(32).toString('base64url')}`
  const keyHash = hashApiKey(key)
  const row = await db.$transaction(async (tx) => {
    const role = await tx.role.findFirst({
      where: { id: input.roleId, organizationId: input.organizationId },
      select: { id: true },
    })
    if (!role) throw new ApiKeyRoleError()
    // No Account row: no password, no provider, nothing to sign in with. The address can't
    // receive mail, so no reset or magic link reaches anyone.
    const user = await tx.user.create({
      data: {
        name: `API: ${input.name}`,
        email: `api+${randomBytes(12).toString('hex')}@invalid.local`,
        emailVerified: false,
      },
      select: { id: true },
    })
    await tx.organizationMember.create({
      data: {
        organizationId: input.organizationId,
        userId: user.id,
        role: 'member',
        roleId: role.id,
      },
    })
    return tx.apiKey.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        prefix,
        keyHash,
        serviceUserId: user.id,
        createdById: input.createdById,
        expiresAt: input.expiresAt ?? null,
        ipAllowlist: input.ipAllowlist ?? [],
      },
      select: { id: true, prefix: true, name: true, createdAt: true },
    })
  })
  return { ...row, key }
}

export type VerifyFailure = 'malformed' | 'unknown' | 'revoked' | 'expired' | 'ip_not_allowed'

export type VerifyResult =
  | { ok: true; apiKeyId: string; organizationId: string; serviceUserId: string }
  | { ok: false; reason: VerifyFailure }

export async function verifyApiKey(
  token: string,
  ip: string | null,
  now = new Date()
): Promise<VerifyResult> {
  const match = KEY_RE.exec(token)
  if (!match) return { ok: false, reason: 'malformed' }
  const row = await db.apiKey.findUnique({
    where: { prefix: match[1] },
    select: {
      id: true,
      organizationId: true,
      serviceUserId: true,
      keyHash: true,
      revokedAt: true,
      expiresAt: true,
      ipAllowlist: true,
      lastUsedAt: true,
    },
  })
  // Hashed and compared either way, so an unknown prefix takes as long as a wrong secret.
  const presented = Buffer.from(hashApiKey(token), 'hex')
  const stored = Buffer.from(row?.keyHash ?? '0'.repeat(64), 'hex')
  const equal = presented.length === stored.length && timingSafeEqual(presented, stored)
  if (!row || !equal) return { ok: false, reason: 'unknown' }
  if (row.revokedAt) return { ok: false, reason: 'revoked' }
  if (row.expiresAt && row.expiresAt <= now) return { ok: false, reason: 'expired' }
  // A6: compared in one spelling per address (`::ffff:1.2.3.4` is `1.2.3.4`; IPv6 case and zeros), ipAddress.ts.
  if (row.ipAllowlist.length > 0 && (!ip || !allowlisted(row.ipAllowlist, ip))) {
    return { ok: false, reason: 'ip_not_allowed' }
  }
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    await db.apiKey
      .updateMany({
        where: { id: row.id, organizationId: row.organizationId },
        data: { lastUsedAt: now, lastUsedIp: ip },
      })
      .catch(() => {
        // A missed lastUsedAt write must not refuse a valid key.
      })
  }
  return {
    ok: true,
    apiKeyId: row.id,
    organizationId: row.organizationId,
    serviceUserId: row.serviceUserId,
  }
}

/**
 * Revokes at once: the next request with the key is refused, and its service user leaves the
 * workshop. Null when the key isn't this workshop's.
 */
export async function revokeApiKey(organizationId: string, id: string) {
  return db.$transaction(async (tx) => {
    const key = await tx.apiKey.findFirst({
      where: { id, organizationId },
      select: { id: true, name: true, prefix: true, serviceUserId: true, revokedAt: true },
    })
    if (!key) return null
    if (!key.revokedAt) {
      await tx.apiKey.updateMany({ where: { id, organizationId }, data: { revokedAt: new Date() } })
    }
    await tx.organizationMember.deleteMany({ where: { organizationId, userId: key.serviceUserId } })
    return { id: key.id, name: key.name, prefix: key.prefix }
  })
}
