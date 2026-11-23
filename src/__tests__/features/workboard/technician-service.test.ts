/**
 * @vitest-environment node
 *
 * fork: the technician service does what the work board's technician actions did (A2): the same
 * rows, the same board notifications, the same audit events, whether the action or the API calls it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    technician: {
      findFirst: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    serviceRecord: { updateMany: vi.fn() },
  },
  emit: vi.fn(),
  revoke: vi.fn(async () => undefined),
}))
vi.mock('@/lib/db', () => ({ db: mocks.db }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/notification-bus', () => ({ notificationBus: { emit: mocks.emit } }))
vi.mock('@/features/team/Lib/revokeTechnicianCredentials', () => ({
  revokeTechnicianCredentials: mocks.revoke,
}))

const service = await import('@/features/workboard/Lib/technicianService.server')
const events = await import('@/features/workboard/Lib/technicianAuditEvents')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }
const { db } = mocks

beforeEach(() => vi.clearAllMocks())

describe('creating a technician', () => {
  it('adds them at the end of the board and tells the board', async () => {
    db.technician.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } })
    db.technician.create.mockImplementation(async ({ data }) => ({ id: 't-1', ...data }))
    const made = await service.createTechnicianService(ctx, { name: 'Kari' })
    expect(db.technician.create).toHaveBeenCalledWith({
      data: {
        name: 'Kari',
        color: '#3b82f6',
        skills: null,
        userId: null,
        sortOrder: 5,
        organizationId: 'org-a',
      },
    })
    expect(mocks.emit).toHaveBeenCalledWith('workboard', {
      type: 'technician_created',
      organizationId: 'org-a',
      technician: made,
    })
    expect(events.createTechnicianEvent(made)).toEqual({
      action: 'technician.create',
      entity: 'Technician',
      entityId: 't-1',
      details: { key: 'technician_create', params: { name: 'Kari' } },
      metadata: { technicianId: 't-1', technicianName: 'Kari' },
    })
  })

  it('returns the technician a member already is, instead of a second one', async () => {
    db.technician.findFirst.mockResolvedValue({ id: 't-9', name: 'Kari', userId: 'u-9' })
    expect(await service.createTechnicianService(ctx, { name: 'Kari', userId: 'u-9' })).toEqual({
      id: 't-9',
      name: 'Kari',
      userId: 'u-9',
    })
    expect(db.technician.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u-9', organizationId: 'org-a' },
    })
    expect(db.technician.create).not.toHaveBeenCalled()
  })
})

describe('updating a technician', () => {
  it('changes only this workshop’s technician and carries a new name onto their jobs', async () => {
    db.technician.updateMany.mockResolvedValue({ count: 1 })
    const result = await service.updateTechnicianService(ctx, { id: 't-1', name: 'Kari N.' })
    expect(db.technician.updateMany).toHaveBeenCalledWith({
      where: { id: 't-1', organizationId: 'org-a' },
      data: { name: 'Kari N.' },
    })
    expect(db.serviceRecord.updateMany).toHaveBeenCalledWith({
      where: { technicianId: 't-1' },
      data: { techName: 'Kari N.' },
    })
    expect(events.updateTechnicianEvent(result)).toMatchObject({
      action: 'technician.update',
      entityId: 't-1',
    })
  })

  it('refuses a member already linked to another technician', async () => {
    db.technician.findFirst.mockResolvedValue({ id: 't-2', name: 'Ola' })
    await expect(
      service.updateTechnicianService(ctx, { id: 't-1', userId: 'u-2' })
    ).rejects.toThrow('already linked to technician "Ola"')
    expect(db.technician.updateMany).not.toHaveBeenCalled()
  })
})

describe('removing a technician', () => {
  it('deactivates them (their hours stay), revokes their app access, and tells the board', async () => {
    db.technician.findFirst.mockResolvedValue({ id: 't-1', userId: 'u-1' })
    const result = await service.deleteTechnicianService(ctx, 't-1')
    expect(db.technician.update).toHaveBeenCalledWith({
      where: { id: 't-1' },
      data: { isActive: false },
    })
    expect(mocks.revoke).toHaveBeenCalledWith('org-a', 'u-1')
    expect(events.deleteTechnicianEvent(result)).toEqual({
      action: 'technician.delete',
      entity: 'Technician',
      entityId: 't-1',
      details: { key: 'technician_delete', params: { id: 't-1' } },
      metadata: { technicianId: 't-1' },
    })
  })

  it('refuses another workshop’s technician, changing nothing', async () => {
    db.technician.findFirst.mockResolvedValue(null)
    await expect(service.deleteTechnicianService(ctx, 'theirs')).rejects.toThrow(
      'not part of this workshop'
    )
    expect(db.technician.update).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
})
