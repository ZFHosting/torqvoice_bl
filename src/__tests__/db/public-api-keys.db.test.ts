/**
 * fork: the public API's keys and request wrapper on a real PostgreSQL (`npm run test:db`), through
 * the real `GET /api/v1/settings` route (docs/fork/milestones/A1-api-foundation.md, Acceptance).
 *
 * Two workshops of its own, each with a role that may read settings and one that may not; it
 * removes them again and empties nothing.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const url = process.env.E2E_DATABASE_URL ?? ''
const databaseName = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
if (url && !/test|e2e/.test(databaseName)) {
  throw new Error(
    `Refusing to use database "${databaseName}": its name must say test or e2e, like the rest of this suite.`
  )
}
process.env.DATABASE_URL = url
process.env.API_KEY_PEPPER = 'db-test-pepper-that-is-long-enough'

const stamp = randomUUID().slice(0, 8)

let db: typeof import('@/lib/db')['db']
let keys: typeof import('@/features/public-api/Lib/keys.server')
let withPublicApi: typeof import('@/features/public-api/Lib/withPublicApi')['withPublicApi']
let resetKeyBudgets: typeof import('@/features/public-api/Lib/rateLimit')['resetKeyBudgets']
let GET: typeof import('@/app/api/v1/settings/route')['GET']

const ids = { orgs: [] as string[], users: [] as string[] }
const A = { org: '', owner: '', readRole: '', noRole: '' }
const B = { org: '', owner: '', readRole: '', noRole: '' }

async function workshop(into: typeof A, name: string, currency: string) {
  into.org = (await db.organization.create({ data: { name: `${name} ${stamp}` } })).id
  into.owner = (
    await db.user.create({
      data: { email: `owner-${name}-${stamp}@example.com`, name: `Owner ${name}` },
    })
  ).id
  ids.orgs.push(into.org)
  ids.users.push(into.owner)
  await db.organizationMember.create({
    data: { organizationId: into.org, userId: into.owner, role: 'owner' },
  })
  into.readRole = (
    await db.role.create({
      data: {
        organizationId: into.org,
        name: 'Reads settings',
        permissions: { create: [{ action: 'read', subject: 'settings' }] },
      },
    })
  ).id
  into.noRole = (
    await db.role.create({ data: { organizationId: into.org, name: 'Reads customers only' } })
  ).id
  await db.appSetting.create({
    data: {
      organizationId: into.org,
      userId: into.owner,
      key: 'workshop.currencyCode',
      value: currency,
    },
  })
}

function settingsRequest(key: string, ip = '203.0.113.5') {
  return new Request('http://localhost/api/v1/settings', {
    headers: { authorization: `Bearer ${key}`, 'x-real-ip': ip },
  })
}

async function newKey(
  into: typeof A,
  extra: Partial<Parameters<typeof keys.createApiKey>[0]> = {}
) {
  const created = await keys.createApiKey({
    organizationId: into.org,
    name: `key ${randomUUID().slice(0, 6)}`,
    roleId: into.readRole,
    createdById: into.owner,
    ...extra,
  })
  const row = await db.apiKey.findUniqueOrThrow({ where: { id: created.id } })
  ids.users.push(row.serviceUserId)
  return created
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  keys = await import('@/features/public-api/Lib/keys.server')
  ;({ withPublicApi } = await import('@/features/public-api/Lib/withPublicApi'))
  ;({ resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit'))
  ;({ GET } = await import('@/app/api/v1/settings/route'))
  await workshop(A, 'Alpha', 'NOK')
  await workshop(B, 'Bravo', 'EUR')
})

beforeEach(() => resetKeyBudgets())

afterAll(async () => {
  if (!db) return
  if (ids.orgs.length) await db.organization.deleteMany({ where: { id: { in: ids.orgs } } })
  if (ids.users.length) await db.user.deleteMany({ where: { id: { in: ids.users } } })
})

describe('an API key', () => {
  it('reads its own workshop’s settings', async () => {
    const { key } = await newKey(A)
    const response = await GET(settingsRequest(key))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.currency).toBe('NOK')
    expect(response.headers.get('X-RateLimit-Limit')).toBe('120')
  })

  it('never sees another workshop’s: the same route answers with its own', async () => {
    const { key } = await newKey(B)
    const body = await (await GET(settingsRequest(key))).json()
    expect(body.data.currency).toBe('EUR')
  })

  it('is refused with 401 once revoked, on the very next request', async () => {
    const created = await newKey(A)
    expect((await GET(settingsRequest(created.key))).status).toBe(200)
    expect(await keys.revokeApiKey(A.org, created.id)).toMatchObject({ id: created.id })
    const response = await GET(settingsRequest(created.key))
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('unauthorized')
    // Refused by the key itself, not only because its service user left the workshop.
    expect(await keys.verifyApiKey(created.key, null)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('can only be revoked by its own workshop', async () => {
    const created = await newKey(A)
    expect(await keys.revokeApiKey(B.org, created.id)).toBeNull()
    expect((await GET(settingsRequest(created.key))).status).toBe(200)
  })

  it('is refused with 401 once expired', async () => {
    const { key } = await newKey(A, { expiresAt: new Date(Date.now() - 1000) })
    expect((await GET(settingsRequest(key))).status).toBe(401)
  })

  it('is refused with 403 from an address off its allowlist, and served from one on it', async () => {
    const { key } = await newKey(A, { ipAllowlist: ['198.51.100.7'] })
    expect((await GET(settingsRequest(key, '203.0.113.5'))).status).toBe(403)
    expect((await GET(settingsRequest(key, '198.51.100.7'))).status).toBe(200)
  })

  it('is refused with 403 when its role lacks the permission', async () => {
    const { key } = await newKey(A, { roleId: A.noRole })
    const response = await GET(settingsRequest(key))
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('forbidden')
  })

  it('is refused with 429 and Retry-After past its rate limit', async () => {
    const { key } = await newKey(A)
    const request = () =>
      withPublicApi(settingsRequest(key), async () => Response.json({ data: 'ok' }), {
        rateLimit: { limit: 2, windowMs: 60_000 },
      })
    expect((await request()).status).toBe(200)
    expect((await request()).status).toBe(200)
    const limited = await request()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await limited.json()).error.code).toBe('rate_limited')
  })

  it('is refused when it is not a key at all, or a key made up', async () => {
    expect((await GET(settingsRequest('not-a-key'))).status).toBe(401)
    expect((await GET(settingsRequest(`tvk_abcdefgh_${'x'.repeat(43)}`))).status).toBe(401)
    const { key } = await newKey(A)
    // The right prefix with a different secret.
    expect((await GET(settingsRequest(`${key.slice(0, 13)}${'A'.repeat(43)}`))).status).toBe(401)
  })

  it('records when and from where it was last used, at most once a minute', async () => {
    const created = await newKey(A)
    await GET(settingsRequest(created.key, '198.51.100.9'))
    const first = await db.apiKey.findUniqueOrThrow({ where: { id: created.id } })
    expect(first.lastUsedAt).not.toBeNull()
    expect(first.lastUsedIp).toBe('198.51.100.9')
    await GET(settingsRequest(created.key, '198.51.100.10'))
    const second = await db.apiKey.findUniqueOrThrow({ where: { id: created.id } })
    expect(second.lastUsedAt?.getTime()).toBe(first.lastUsedAt?.getTime())
  })
})

describe('the key itself', () => {
  it('is stored only as a hash, and never logged', async () => {
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    const info = vi.spyOn(console, 'info')
    const created = await newKey(A)
    await GET(settingsRequest(created.key))
    await keys.revokeApiKey(A.org, created.id)
    await GET(settingsRequest(created.key))

    expect(created.key).toMatch(/^tvk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/)
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: created.id } })
    expect(JSON.stringify(row)).not.toContain(created.key.slice(13))
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/)
    const secret = created.key.slice(13)
    for (const spy of [log, warn, error, info]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret)
      spy.mockRestore()
    }
  })

  it('acts as a service user that cannot sign in, a member with the chosen role', async () => {
    const created = await newKey(A)
    const row = await db.apiKey.findUniqueOrThrow({
      where: { id: created.id },
      include: { serviceUser: { include: { accounts: true, organizationMembers: true } } },
    })
    expect(row.serviceUser.accounts).toEqual([])
    expect(row.serviceUser.email).toMatch(/^api\+[0-9a-f]+@invalid\.local$/)
    expect(row.serviceUser.organizationMembers).toMatchObject([
      { organizationId: A.org, roleId: A.readRole, role: 'member' },
    ])
  })

  it('cannot be given another workshop’s role', async () => {
    await expect(
      keys.createApiKey({
        organizationId: A.org,
        name: 'borrowed role',
        roleId: B.readRole,
        createdById: A.owner,
      })
    ).rejects.toThrow(/role/)
  })
})
