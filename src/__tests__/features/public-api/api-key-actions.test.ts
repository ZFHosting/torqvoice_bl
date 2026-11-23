/**
 * @vitest-environment node
 *
 * fork: who may mint and revoke API keys, and what the audit log says about it
 * (src/features/public-api/Actions/apiKeyActions.ts; A1 acceptance 2 and 4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  membership: { organizationId: 'org-a', role: 'owner', roleId: null, customRole: null } as {
    organizationId: string
    role: string
    roleId: string | null
    customRole: { isAdmin: boolean } | null
  },
  createKey: vi.fn(),
  revokeKey: vi.fn(),
  requireFeature: vi.fn(async () => undefined),
  demoGuard: vi.fn(),
  logAudit: vi.fn(async (_ctx: unknown, _event: unknown) => undefined),
  findMany: vi.fn(async () => []),
}))

vi.mock('@/lib/cached-session', () => ({
  getCachedSession: vi.fn(async () => ({ user: { id: 'user-a', email: 'a@x.test' } })),
  getCachedMembership: vi.fn(async () => mocks.membership),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAudit: mocks.logAudit, auditDetails: vi.fn() }))
vi.mock('@/lib/demo', () => ({
  demoGuard: mocks.demoGuard,
  demoGuardSettingKey: vi.fn(),
  isDemoMode: false,
}))
vi.mock('@/lib/features', () => ({
  requireFeature: mocks.requireFeature,
  getFeatures: vi.fn(async () => ({ api: true })),
}))
// Any model, any method: withAuth reads the user too. The lists the page shows are counted.
vi.mock('@/lib/db', () => ({
  db: new Proxy(
    {},
    {
      get: (_, model: string) =>
        model === 'then'
          ? undefined
          : new Proxy(
              {},
              {
                get: (__, method: string) =>
                  method === 'findMany' ? mocks.findMany : async () => null,
              }
            ),
    }
  ),
}))
vi.mock('@/features/public-api/Lib/keys.server', () => ({
  ApiKeyRoleError: class ApiKeyRoleError extends Error {},
  createApiKey: mocks.createKey,
  revokeApiKey: mocks.revokeKey,
}))

const { createApiKey, getApiKeys, revokeApiKey } = await import(
  '@/features/public-api/Actions/apiKeyActions'
)
const { API_KEYS_OWNER_ONLY } = await import('@/features/public-api/Schema/apiKeys')

const PLAINTEXT = `tvk_abcd2345_${'S'.repeat(43)}`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.membership = { organizationId: 'org-a', role: 'owner', roleId: null, customRole: null }
  mocks.createKey.mockResolvedValue({
    id: 'key-1',
    name: 'Sync',
    prefix: 'abcd2345',
    createdAt: new Date(),
    key: PLAINTEXT,
  })
  mocks.revokeKey.mockResolvedValue({ id: 'key-1', name: 'Sync', prefix: 'abcd2345' })
})

describe('a member who is not an owner or admin', () => {
  beforeEach(() => {
    mocks.membership = {
      organizationId: 'org-a',
      role: 'member',
      roleId: 'role-1',
      customRole: { isAdmin: false },
    }
  })

  it('can neither list, create nor revoke keys', async () => {
    expect(await getApiKeys()).toMatchObject({ success: false, error: API_KEYS_OWNER_ONLY })
    expect(await createApiKey({ name: 'x', roleId: 'role-1' })).toMatchObject({
      success: false,
      error: API_KEYS_OWNER_ONLY,
    })
    expect(await revokeApiKey('key-1')).toMatchObject({
      success: false,
      error: API_KEYS_OWNER_ONLY,
    })
    expect(mocks.createKey).not.toHaveBeenCalled()
    expect(mocks.revokeKey).not.toHaveBeenCalled()
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it('can when their role is an admin role', async () => {
    mocks.membership.customRole = { isAdmin: true }
    expect((await getApiKeys()).success).toBe(true)
  })
})

describe('creating a key', () => {
  it('needs the api plan feature and is refused on the demo', async () => {
    const result = await createApiKey({ name: 'Sync', roleId: 'role-1' })
    expect(result.success).toBe(true)
    expect(mocks.requireFeature).toHaveBeenCalledWith('org-a', 'api')
    expect(mocks.demoGuard).toHaveBeenCalled()
    expect(mocks.createKey).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', createdById: 'user-a', roleId: 'role-1' })
    )
  })

  it('returns the key once, and audits it by name and prefix, never the key', async () => {
    const result = await createApiKey({ name: 'Sync', roleId: 'role-1' })
    expect(result.data?.key).toBe(PLAINTEXT)
    await vi.waitFor(() => expect(mocks.logAudit).toHaveBeenCalled())
    const [ctx, event] = mocks.logAudit.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ]
    expect(ctx).toMatchObject({ organizationId: 'org-a', userId: 'user-a' })
    expect(event).toMatchObject({
      action: 'api_key.create',
      entity: 'apiKey',
      entityId: 'key-1',
      details: { key: 'api_key_create', params: { name: 'Sync', ref: 'abcd2345' } },
    })
    expect(JSON.stringify(event)).not.toContain(PLAINTEXT.slice(13))
  })

  it('refuses an IP allowlist entry that is not an address', async () => {
    const result = await createApiKey({ name: 'Sync', roleId: 'role-1', ipAllowlist: ['nope'] })
    expect(result.success).toBe(false)
    expect(mocks.createKey).not.toHaveBeenCalled()
  })
})

describe('revoking a key', () => {
  it('asks for this workshop’s key and audits the revoke', async () => {
    expect((await revokeApiKey('key-1')).success).toBe(true)
    expect(mocks.revokeKey).toHaveBeenCalledWith('org-a', 'key-1')
    await vi.waitFor(() => expect(mocks.logAudit).toHaveBeenCalled())
    expect(mocks.logAudit.mock.calls[0]?.[1]).toMatchObject({
      action: 'api_key.revoke',
      entityId: 'key-1',
      details: { key: 'api_key_revoke', params: { name: 'Sync', ref: 'abcd2345' } },
    })
  })

  it('says not found for another workshop’s key', async () => {
    mocks.revokeKey.mockResolvedValue(null)
    expect(await revokeApiKey('theirs')).toMatchObject({
      success: false,
      error: 'API key not found',
    })
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })
})
