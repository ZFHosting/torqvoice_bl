/**
 * @vitest-environment node
 *
 * fork (A5): the webhook dispatcher's hook for the public API's events. The name and kind come first, from the audit
 * event alone (nothing is read for an event nobody subscribes to); the record is read after, and one that can't be
 * read goes out as its id and the ids that find it rather than as no delivery at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ data: vi.fn() }))
vi.mock('@/features/public-api/Lib/eventData.server', () => ({ forkEventData: mocks.data }))

import { forkData, forkRename } from '@/features/public-api/Lib/eventHook'

beforeEach(() => {
  mocks.data.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const audit = (event: string, data: Record<string, unknown> | null = null, entityId = 'rec-1') => ({
  event,
  organizationId: 'org-1',
  entity: 'Whatever',
  entityId,
  data,
})

describe('forkRename', () => {
  it('gives a fork event the API’s name and kind, and leaves every other event alone', () => {
    expect(
      forkRename(audit('timeEntry.update', { details: { key: 'timeEntry_stop' } }))
    ).toMatchObject({ event: 'time_entry.stop', entity: 'time_entry' })
    expect(forkRename(audit('job.create'))).toMatchObject({ event: 'job.create', entity: 'job' })
    expect(forkRename(audit('customer.create'))).toBeNull()
    // Nothing to read without the record's id.
    expect(forkRename({ ...audit('job.create'), entityId: null })).toBeNull()
    expect(mocks.data).not.toHaveBeenCalled()
  })
})

describe('forkData', () => {
  it('reads the record for a subscriber, with the audit event’s metadata', async () => {
    mocks.data.mockResolvedValue({ id: 'con-1', customerId: 'cus-1', kind: 'phone' })
    const original = audit('contact.update', { customerId: 'cus-1' }, 'con-1')
    const renamed = forkRename(original)
    expect(renamed).not.toBeNull()
    expect(await forkData(renamed as NonNullable<typeof renamed>, original)).toEqual({
      id: 'con-1',
      customerId: 'cus-1',
      kind: 'phone',
    })
    expect(mocks.data).toHaveBeenCalledWith({
      event: 'contact.update',
      organizationId: 'org-1',
      entityId: 'con-1',
      metadata: { customerId: 'cus-1' },
    })
  })

  it('sends the id and the ids that find it when the record can’t be read, and logs no message', async () => {
    mocks.data.mockRejectedValue(new Error('the contact "+15555550100" …'))
    const original = audit('contact.update', { customerId: 'cus-1' }, 'con-1')
    const renamed = forkRename(original) as NonNullable<ReturnType<typeof forkRename>>
    expect(await forkData(renamed, original)).toEqual({ id: 'con-1', customerId: 'cus-1' })
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('5555550100')
  })
})
