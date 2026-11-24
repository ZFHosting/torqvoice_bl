/**
 * @vitest-environment node
 *
 * fork: what withPublicApi answers before and after the handler: the plan gate, a restore in
 * progress, and errors turned into the shared shape without leaking anything of ours. The key
 * checks themselves run on a real database (src/__tests__/db/public-api-keys.db.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
  getFeatures: vi.fn(),
  findFirst: vi.fn(),
  isRestoring: vi.fn(() => false),
}))

vi.mock('@/features/public-api/Lib/keys.server', () => ({ verifyApiKey: mocks.verifyApiKey }))
vi.mock('@/lib/features', () => ({ getFeatures: mocks.getFeatures, isCloudMode: () => false }))
vi.mock('@/lib/db', () => ({ db: { organizationMember: { findFirst: mocks.findFirst } } }))
vi.mock('@/lib/backup/freeze', () => ({
  isRestoring: mocks.isRestoring,
  RESTORE_IN_PROGRESS_MESSAGE: 'A restore is in progress.',
}))

const { withPublicApi } = await import('@/features/public-api/Lib/withPublicApi')
const { resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit')
const { DocumentLockedError } = await import('@/lib/document-lock')

const KEY = `tvk_abcdefgh_${'s'.repeat(43)}`
const req = (method = 'GET') =>
  new Request('http://localhost/api/v1/settings', {
    method,
    headers: { authorization: `Bearer ${KEY}` },
  })

beforeEach(() => {
  vi.clearAllMocks()
  resetKeyBudgets()
  mocks.verifyApiKey.mockResolvedValue({
    ok: true,
    apiKeyId: 'key-1',
    organizationId: 'org-1',
    serviceUserId: 'svc-1',
  })
  mocks.getFeatures.mockResolvedValue({ api: true })
  mocks.findFirst.mockResolvedValue({
    role: 'member',
    customRole: { isAdmin: false, permissions: [] },
  })
  mocks.isRestoring.mockReturnValue(false)
})

describe('withPublicApi', () => {
  it('hands the handler the key’s workshop and service user', async () => {
    const handler = vi.fn(async () => Response.json({ data: 1 }))
    expect((await withPublicApi(req(), handler)).status).toBe(200)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', userId: 'svc-1', apiKeyId: 'key-1' })
    )
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', userId: 'svc-1' } })
    )
  })

  it('ignores any bearer token that is not an API key (those are the technician app’s)', async () => {
    const request = new Request('http://localhost/api/v1/settings', {
      headers: { authorization: 'Bearer some-session-token' },
    })
    expect((await withPublicApi(request, async () => new Response())).status).toBe(401)
    expect(mocks.verifyApiKey).not.toHaveBeenCalled()
  })

  it('refuses with 403 when the workshop’s plan has no API', async () => {
    mocks.getFeatures.mockResolvedValue({ api: false })
    const response = await withPublicApi(req(), async () => new Response())
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'forbidden', details: { gate: 'api' } },
    })
  })

  it('lets an admin role past every permission check', async () => {
    mocks.findFirst.mockResolvedValue({
      role: 'member',
      customRole: { isAdmin: true, permissions: [] },
    })
    const response = await withPublicApi(req(), async () => new Response('ok'), {
      requiredPermissions: [{ action: 'delete', subject: 'customers' } as never],
    })
    expect(response.status).toBe(200)
  })

  it('holds writes, not reads, while the workshop is being restored', async () => {
    mocks.isRestoring.mockReturnValue(true)
    expect((await withPublicApi(req('GET'), async () => new Response('ok'))).status).toBe(200)
    expect((await withPublicApi(req('POST'), async () => new Response('ok'))).status).toBe(409)
  })

  it('answers the caller’s mistakes plainly and its own not at all', async () => {
    const zod = await withPublicApi(req(), async () => {
      z.object({ name: z.string() }).parse({})
      return new Response()
    })
    expect(zod.status).toBe(400)
    expect((await zod.json()).error.details[0].path).toBe('name')

    const locked = await withPublicApi(req('PATCH'), async () => {
      throw new DocumentLockedError('paid')
    })
    expect(locked.status).toBe(409)
    expect(await locked.json()).toMatchObject({
      error: { code: 'document_locked', details: { reason: 'paid' } },
    })

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ours = await withPublicApi(req(), async () => {
      throw new Error('connection string postgres://secret')
    })
    expect(ours.status).toBe(500)
    expect(JSON.stringify(await ours.json())).not.toContain('secret')
    spy.mockRestore()
  })

  it('reports the key’s remaining budget on every answer, refusals included', async () => {
    const ok = await withPublicApi(req(), async () => new Response('ok'))
    expect(ok.headers.get('X-RateLimit-Limit')).toBe('120')
    expect(ok.headers.get('X-RateLimit-Remaining')).toBe('119')

    const denied = await withPublicApi(req(), async () => new Response('ok'), {
      requiredPermissions: [{ action: 'delete', subject: 'customers' } as never],
    })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('X-RateLimit-Remaining')).toBe('118')

    mocks.getFeatures.mockResolvedValue({ api: false })
    const gated = await withPublicApi(req(), async () => new Response('ok'))
    expect(gated.status).toBe(403)
    expect(gated.headers.get('X-RateLimit-Remaining')).toBe('117')
  })

  it('gives a route with its own limit a bucket of its own', async () => {
    const tight = { rateLimit: { limit: 1, windowMs: 60_000 } }
    expect((await withPublicApi(req(), async () => new Response('ok'), tight)).status).toBe(200)
    expect((await withPublicApi(req(), async () => new Response('ok'), tight)).status).toBe(429)
    // The key's default budget is untouched by the tight route.
    const other = await withPublicApi(req(), async () => new Response('ok'))
    expect(other.status).toBe(200)
    expect(other.headers.get('X-RateLimit-Remaining')).toBe('119')
  })

  it('turns away an address that keeps failing, before looking any key up', async () => {
    mocks.verifyApiKey.mockResolvedValue({ ok: false, reason: 'unknown' })
    const { FAILED_AUTH_LIMIT } = await import('@/features/public-api/Lib/rateLimit')
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) {
      expect((await withPublicApi(req(), async () => new Response())).status).toBe(401)
    }
    const blocked = await withPublicApi(req(), async () => new Response())
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(mocks.verifyApiKey).toHaveBeenCalledTimes(FAILED_AUTH_LIMIT)
  })

  it('lets a key that authenticated from a blocked address keep working, but no new one (A6)', async () => {
    const other = `tvk_zzzzzzzz_${'x'.repeat(43)}`
    const fresh = `tvk_yyyyyyyy_${'y'.repeat(43)}`
    const withKey = (key: string) =>
      new Request('http://localhost/api/v1/settings', {
        headers: { authorization: `Bearer ${key}`, 'x-real-ip': '203.0.113.9' },
      })
    // The integration's key works from its address.
    expect((await withPublicApi(withKey(KEY), async () => new Response('ok'))).status).toBe(200)
    // Someone with that address (spoofed) presents bad keys until the address is blocked.
    mocks.verifyApiKey.mockResolvedValue({ ok: false, reason: 'unknown' })
    const { FAILED_AUTH_LIMIT } = await import('@/features/public-api/Lib/rateLimit')
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) {
      await withPublicApi(withKey(other), async () => new Response())
    }
    expect((await withPublicApi(withKey(other), async () => new Response())).status).toBe(429)
    expect((await withPublicApi(withKey(fresh), async () => new Response())).status).toBe(429)
    // The key that already worked is still looked up, and still works.
    mocks.verifyApiKey.mockResolvedValue({
      ok: true,
      apiKeyId: 'key-1',
      organizationId: 'org-1',
      serviceUserId: 'svc-1',
    })
    expect((await withPublicApi(withKey(KEY), async () => new Response('ok'))).status).toBe(200)
    // Written another way, the address is the same one: its block holds.
    const mapped = new Request('http://localhost/api/v1/settings', {
      headers: { authorization: `Bearer ${fresh}`, 'x-real-ip': '::ffff:203.0.113.9' },
    })
    expect((await withPublicApi(mapped, async () => new Response())).status).toBe(429)
  })

  it('knows a trusted key at its address however the address is written, and caps the address (A6)', async () => {
    const from = (ip: string, key = KEY) =>
      new Request('http://localhost/api/v1/settings', {
        headers: { authorization: `Bearer ${key}`, 'x-real-ip': ip },
      })
    expect((await withPublicApi(from('203.0.113.11'), async () => new Response('ok'))).status).toBe(
      200
    )
    mocks.verifyApiKey.mockResolvedValue({ ok: false, reason: 'unknown' })
    const { FAILED_AUTH_LIMIT } = await import('@/features/public-api/Lib/rateLimit')
    const other = `tvk_zzzzzzzz_${'x'.repeat(43)}`
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) {
      await withPublicApi(from('203.0.113.11', other), async () => new Response())
    }
    mocks.verifyApiKey.mockResolvedValue({
      ok: true,
      apiKeyId: 'key-1',
      organizationId: 'org-1',
      serviceUserId: 'svc-1',
    })
    // The same address over IPv6: the key is still the one that worked there.
    expect(
      (await withPublicApi(from('::ffff:203.0.113.11'), async () => new Response('ok'))).status
    ).toBe(200)
    // A header past any address's length counts as its first 64 characters, so it can't grow the maps.
    const long = 'a'.repeat(64)
    mocks.verifyApiKey.mockResolvedValue({ ok: false, reason: 'unknown' })
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) {
      await withPublicApi(from(`${long}${i}`, other), async () => new Response())
    }
    expect(
      (await withPublicApi(from(`${long}-new`, other), async () => new Response())).status
    ).toBe(429)
  })

  it('stops a known key’s prefix too once it fails as often itself', async () => {
    const at = (key: string) =>
      new Request('http://localhost/api/v1/settings', {
        headers: { authorization: `Bearer ${key}`, 'x-real-ip': '203.0.113.10' },
      })
    expect((await withPublicApi(at(KEY), async () => new Response('ok'))).status).toBe(200)
    mocks.verifyApiKey.mockResolvedValue({ ok: false, reason: 'unknown' })
    const { FAILED_AUTH_LIMIT } = await import('@/features/public-api/Lib/rateLimit')
    const guessed = `tvk_abcdefgh_${'g'.repeat(43)}`
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) {
      expect((await withPublicApi(at(guessed), async () => new Response())).status).toBe(401)
    }
    expect((await withPublicApi(at(guessed), async () => new Response())).status).toBe(429)
  })

  it('logs where a 500 came from without its message (A6)', async () => {
    mocks.verifyApiKey.mockRejectedValue(new Error('customer jane@example.com broke it'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await withPublicApi(req(), async () => new Response())
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toContain('jane@example.com')
    const [, fields] = spy.mock.calls[0] as [string, { at: string[] }]
    expect(fields.at.length).toBeGreaterThan(0)
    expect(fields.at.every((frame) => frame.startsWith('at '))).toBe(true)
    spy.mockRestore()
  })

  it('answers a database error before the handler in the same shape, saying nothing of it', async () => {
    mocks.verifyApiKey.mockRejectedValue(new Error('connect ECONNREFUSED db:5432'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await withPublicApi(req(), async () => new Response())
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toMatchObject({ error: { code: 'server_error' } })
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED')
    spy.mockRestore()
  })
})
