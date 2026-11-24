/**
 * fork (A6, docs/fork/milestones/A6-hardening.md task 7) on a real PostgreSQL (`npm run test:db`): an API key's service
 * user is a member of the workshop (its role is how the key's scope is managed), shown on the Team page as the key it
 * is, and not counted as a seat. SYNTHETIC data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { guardTestDatabase, newKey, newShop, removeCreated, type Shop } from './publicApiHarness'

const url = guardTestDatabase()
let shop: Shop

const session = vi.hoisted(() => ({ organizationId: '', userId: '' }))
vi.mock('@/lib/cached-session', () => ({
  getCachedSession: async () => ({ user: { id: session.userId, name: 'Owner', email: null } }),
  getCachedMembership: async () => ({
    organizationId: session.organizationId,
    role: 'owner',
    customRole: null,
  }),
  getCachedSessionScope: async () => null,
  resolveMembership: async () => ({
    organizationId: session.organizationId,
    role: 'owner',
    customRole: null,
  }),
  assertAccountSession: async () => undefined,
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}))

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  shop = await newShop('A6team')
  session.organizationId = shop.org
  session.userId = shop.owner
  // A second key, with a narrow role.
  await newKey(shop.org, shop.owner, [{ action: 'read', subject: 'customers' }])
}, 120_000)

afterAll(async () => {
  await removeCreated()
})

describe('API keys on the Team page', () => {
  it('count no seat: the owner is the only person here', async () => {
    const { db } = await import('@/lib/db')
    expect(await db.organizationMember.count({ where: { organizationId: shop.org } })).toBe(3)
    const { memberSeats } = await import('@/features/team/Lib/memberSeats')
    expect((await memberSeats(shop.org)).used).toBe(1)
  })

  it('are listed as the keys they are, with their roles', async () => {
    const { getOrganization } = await import('@/features/team/Actions/teamActions')
    const result = await getOrganization()
    expect(result.success).toBe(true)
    const members = result.data?.organization.members ?? []
    expect(members).toHaveLength(3)
    const keys = members.filter((m) => m.apiKey)
    expect(keys).toHaveLength(2)
    for (const key of keys) {
      expect(key.apiKey).toEqual({ id: expect.any(String), name: expect.stringMatching(/^key /) })
      expect(key.customRoleName).toEqual(expect.any(String))
    }
    expect(members.find((m) => m.user.id === shop.owner)?.apiKey).toBeNull()
  })

  it('are refused removal and the technician app on the server too (a tab from before the change)', async () => {
    const { db } = await import('@/lib/db')
    const key = await db.apiKey.findFirstOrThrow({
      where: { organizationId: shop.org },
      select: { id: true, serviceUserId: true },
    })
    const member = await db.organizationMember.findFirstOrThrow({
      where: { organizationId: shop.org, userId: key.serviceUserId },
      select: { id: true },
    })
    const { removeMember } = await import('@/features/team/Actions/teamActions')
    const removed = await removeMember(member.id)
    expect(removed.success).toBe(false)
    expect(removed.error).toMatch(/API key/)
    expect(await db.organizationMember.count({ where: { id: member.id } })).toBe(1)

    const { setMemberTechnician } = await import('@/features/team/Actions/setMemberTechnician')
    const app = await setMemberTechnician({ userId: key.serviceUserId, enabled: true })
    expect(app.success).toBe(false)
    expect(app.error).toMatch(/API key/)
    expect(
      await db.technician.count({ where: { organizationId: shop.org, userId: key.serviceUserId } })
    ).toBe(0)
    expect(
      await db.apiKey.count({ where: { id: key.id, revokedAt: null } }),
      'the key still works'
    ).toBe(1)
  })
})
