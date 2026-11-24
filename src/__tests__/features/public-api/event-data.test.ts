/**
 * @vitest-environment node
 *
 * fork (A5, docs/fork/API.md §5): the fork's webhook events go out under the API's names, with the resource as the API
 * serializes it, read scoped by workshop; a delete carries `{ id }`; every other event is left alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readOne: vi.fn(),
  job: vi.fn(),
  contact: vi.fn(),
}))

vi.mock('@/features/public-api/Lib/readResource', () => ({ readOne: mocks.readOne }))
vi.mock('@/lib/db', () => ({
  db: { workJob: { findFirst: mocks.job }, customerContact: { findFirst: mocks.contact } },
}))
vi.mock('@/features/public-api/Resources/schedule', () => ({
  appointmentsResource: { name: 'appointments' },
  shiftsResource: { name: 'shifts' },
  timeEntriesResource: { name: 'timeEntries' },
}))
vi.mock('@/features/public-api/Resources/staff', () => ({ techniciansResource: { name: 'technicians' } }))
vi.mock('@/features/public-api/Resources/workOrders', () => ({ workOrdersResource: { name: 'workOrders' } }))

import { forkEvent } from '@/features/public-api/Lib/eventData.server'

beforeEach(() => {
  mocks.readOne.mockReset()
  mocks.job.mockReset()
  mocks.contact.mockReset()
})

describe('forkEvent', () => {
  it('sends an appointment as the API reads it, scoped by the workshop', async () => {
    mocks.readOne.mockResolvedValue({ data: { id: 'apt-1', title: 'Service' }, etag: 'x' })
    expect(
      await forkEvent({
        event: 'appointment.create',
        organizationId: 'org-1',
        entityId: 'apt-1',
        data: { details: {} },
      })
    ).toEqual({ event: 'appointment.create', data: { id: 'apt-1', title: 'Service' } })
    expect(mocks.readOne).toHaveBeenCalledWith({ name: 'appointments' }, 'org-1', 'apt-1')
  })

  it('names the app’s time entry actions as the API does, a stop as a stop', async () => {
    mocks.readOne.mockResolvedValue({ data: { id: 'te-1' }, etag: 'x' })
    const name = async (action: string, key?: string) =>
      (
        await forkEvent({
          event: action,
          organizationId: 'org-1',
          entityId: 'te-1',
          data: key ? { details: { key } } : {},
        })
      )?.event
    expect(await name('timeEntry.create')).toBe('time_entry.create')
    expect(await name('timeEntry.update', 'timeEntry_stop')).toBe('time_entry.stop')
    expect(await name('timeEntry.update', 'timeEntry_update')).toBe('time_entry.update')
    expect(await name('timeEntry.delete')).toBe('time_entry.delete')
    expect(await name('time_entry.start')).toBe('time_entry.start')
  })

  it('sends a delete as its id alone, and reads nothing', async () => {
    expect(
      await forkEvent({ event: 'contact.delete', organizationId: 'org-1', entityId: 'con-1' })
    ).toEqual({ event: 'contact.delete', data: { id: 'con-1' } })
    expect(mocks.contact).not.toHaveBeenCalled()
  })

  it('reads a job and a contact scoped by the workshop, and sends { id } when they are gone', async () => {
    mocks.job.mockResolvedValue(null)
    expect(
      await forkEvent({ event: 'job.update', organizationId: 'org-1', entityId: 'job-1' })
    ).toEqual({ event: 'job.update', data: { id: 'job-1' } })
    expect(mocks.job).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'job-1', organizationId: 'org-1' } })
    )
    mocks.contact.mockResolvedValue(null)
    await forkEvent({ event: 'contact.update', organizationId: 'org-1', entityId: 'con-1' })
    expect(mocks.contact).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'con-1', organizationId: 'org-1' } })
    )
  })

  it('leaves every other event as it is', async () => {
    expect(
      await forkEvent({ event: 'customer.create', organizationId: 'org-1', entityId: 'c-1' })
    ).toBeNull()
    expect(
      await forkEvent({ event: 'shopmonkey.import', organizationId: 'org-1', entityId: 'conn-1' })
    ).toBeNull()
    expect(await forkEvent({ event: 'appointment.create', organizationId: 'org-1' })).toBeNull()
  })
})
