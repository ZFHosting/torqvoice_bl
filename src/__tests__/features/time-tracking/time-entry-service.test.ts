/**
 * @vitest-environment node
 *
 * fork: the time entry and technician services do what their actions did (A2), with the same
 * audit events, plus a tombstone when a time entry is deleted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteEntry: vi.fn(),
  tombstone: vi.fn(),
}))
vi.mock('@/features/time-tracking/Lib/timeEntries', async (original) => ({
  ...(await original<typeof import('@/features/time-tracking/Lib/timeEntries')>()),
  deleteEntry: mocks.deleteEntry,
}))
vi.mock('@/lib/db', () => ({ db: { deletedRecord: { create: mocks.tombstone } } }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const timeEntries = await import('@/features/time-tracking/Lib/timeEntryService.server')
const timeEvents = await import('@/features/time-tracking/Lib/timeEntryAuditEvents')
const techEvents = await import('@/features/workboard/Lib/technicianAuditEvents')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }

beforeEach(() => vi.clearAllMocks())

describe('deleting a time entry', () => {
  it('deletes through the shared helper, scoped to the workshop, then leaves a tombstone', async () => {
    mocks.deleteEntry.mockResolvedValue({ id: 'te-1' })
    expect(await timeEntries.deleteTimeEntryService(ctx, 'te-1')).toEqual({ id: 'te-1' })
    expect(mocks.deleteEntry).toHaveBeenCalledWith('org-a', 'te-1')
    expect(mocks.tombstone).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-a',
        entityType: 'time_entry',
        entityId: 'te-1',
        actorUserId: 'user-1',
      },
    })
  })

  it('leaves no tombstone when the entry is not this workshop’s', async () => {
    mocks.deleteEntry.mockRejectedValue(new Error('Time entry not found'))
    await expect(timeEntries.deleteTimeEntryService(ctx, 'theirs')).rejects.toThrow()
    expect(mocks.tombstone).not.toHaveBeenCalled()
  })
})

describe('the audit events', () => {
  it('are the ones the actions always logged', () => {
    expect(techEvents.createTechnicianEvent({ id: 't-1', name: 'Kari' } as never)).toEqual({
      action: 'technician.create',
      entity: 'Technician',
      entityId: 't-1',
      details: { key: 'technician_create', params: { name: 'Kari' } },
      metadata: { technicianId: 't-1', technicianName: 'Kari' },
    })
    expect(timeEvents.deleteTimeEntryEvent({ id: 'te-1' })).toEqual({
      action: 'timeEntry.delete',
      entity: 'timeEntry',
      entityId: 'te-1',
      details: { key: 'timeEntry_delete', params: { id: 'te-1' } },
    })
  })
})
