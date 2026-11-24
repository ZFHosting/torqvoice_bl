import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * fork (A6, SECURITY-REVIEW.md item 17): an API key's service user is a member of the workshop (its role is the key's
 * scope), but never a technician on the board and never signed in to the technician app: whoever held its app code
 * would act as the key. The team actions read that from the member they already look up (`user.apiKey`). Unit tests,
 * so CI guards them with every change to the team actions (the db test covers them on PostgreSQL).
 */

vi.mock('@/lib/cached-session', () => ({
  getCachedSession: vi.fn(),
  getCachedMembership: vi.fn(),
}))
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
  cookies: vi.fn().mockResolvedValue({ set: vi.fn(), get: vi.fn() }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notification-bus', () => ({ notificationBus: { emit: vi.fn(), publish: vi.fn() } }))
vi.mock('@/features/team/Lib/technicianStanding', () => ({
  setTechnicianStanding: vi.fn().mockResolvedValue('tech-1'),
}))
vi.mock('@/features/team/Lib/customRoleName', () => ({
  customRoleName: vi.fn().mockResolvedValue('Technician'),
}))
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: vi.fn() },
    organizationMember: { findFirst: vi.fn(), update: vi.fn() },
    role: { findFirst: vi.fn() },
    technician: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    technicianSetupCode: { deleteMany: vi.fn(), create: vi.fn() },
  },
}))

import { getCachedMembership, getCachedSession } from '@/lib/cached-session'
import { db } from '@/lib/db'
import { assignRole } from '@/features/team/Actions/assignRole'
import { createAppSetupCode } from '@/features/team/Actions/createAppSetupCode'
import { setMemberTechnician } from '@/features/team/Actions/setMemberTechnician'
import { setTechnicianStanding } from '@/features/team/Lib/technicianStanding'

const KEY_USER = {
  id: 'u-key',
  name: 'API: Bookkeeping',
  email: 'api+x@invalid.local',
  apiKey: { id: 'k1' },
}
const PERSON = { id: 'u-kari', name: 'Kari', email: 'kari@example.com', apiKey: null }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCachedSession).mockResolvedValue({ user: { id: 'owner-1' } } as never)
  vi.mocked(getCachedMembership).mockResolvedValue({
    organizationId: 'org-1',
    role: 'owner',
    roleId: null,
    customRole: null,
  } as never)
  vi.mocked(db.user.findUnique).mockResolvedValue({ isSuperAdmin: false } as never)
  vi.mocked(db.role.findFirst).mockResolvedValue({ id: 'role-tech' } as never)
  vi.mocked(db.organizationMember.update).mockResolvedValue({} as never)
  vi.mocked(db.technician.findFirst).mockResolvedValue({ id: 'tech-1', isActive: true } as never)
})

const memberOf = (user: typeof KEY_USER | typeof PERSON) =>
  ({
    id: `m-${user.id}`,
    userId: user.id,
    role: 'member',
    roleId: null,
    customRole: null,
    user,
  }) as never

describe('the Technician role', () => {
  it('gives a key its role, as the Team page sends it, but no place on the board', async () => {
    vi.mocked(db.organizationMember.findFirst).mockResolvedValue(memberOf(KEY_USER))
    const result = await assignRole({ memberId: 'm-u-key', role: 'member', roleId: 'role-tech' })
    expect(result.success).toBe(true)
    expect(result.data?.isTechnician).toBe(false)
    expect(db.organizationMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roleId: 'role-tech' }) })
    )
    expect(setTechnicianStanding).not.toHaveBeenCalled()
  })

  it('puts a person on the board, as before', async () => {
    vi.mocked(db.organizationMember.findFirst).mockResolvedValue(memberOf(PERSON))
    const result = await assignRole({ memberId: 'm-u-kari', role: 'member', roleId: 'role-tech' })
    expect(result.data?.isTechnician).toBe(true)
    expect(setTechnicianStanding).toHaveBeenCalledWith('org-1', 'u-kari', true, 'u-kari')
  })
})

describe('marking a key a technician, or giving it the app', () => {
  it('is refused, and nothing is written', async () => {
    vi.mocked(db.organizationMember.findFirst).mockResolvedValue({ user: KEY_USER } as never)
    const marked = await setMemberTechnician({ userId: 'u-key', enabled: true })
    expect(marked).toMatchObject({ success: false })
    expect(marked.error).toMatch(/API key/)
    expect(db.technician.create).not.toHaveBeenCalled()

    vi.mocked(db.organizationMember.findFirst).mockResolvedValue({
      role: 'member',
      customRole: null,
      user: KEY_USER,
    } as never)
    const code = await createAppSetupCode({ userId: 'u-key' })
    expect(code).toMatchObject({ success: false })
    expect(code.error).toMatch(/API key/)
    expect(db.technicianSetupCode.create).not.toHaveBeenCalled()
  })
})
