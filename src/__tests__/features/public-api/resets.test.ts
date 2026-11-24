/**
 * @vitest-environment node
 *
 * fork (A5): a restore or a bulk delete leaves one marker at `/deleted` (`restore` or `reset`, the reason as its
 * id); writing it never fails the change it describes; a restore announces `restore.complete`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn(), dispatch: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { deletedRecord: { create: mocks.create } } }))
vi.mock('@/features/webhooks/Lib/dispatcher', () => ({ dispatchWebhookEvent: mocks.dispatch }))

import { announceRestore, recordReset } from '@/features/public-api/Lib/resets.server'

beforeEach(() => {
  mocks.create.mockReset()
  mocks.dispatch.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('the markers', () => {
  it('records a restore as `restore` and a bulk delete as `reset`, the reason as the id', async () => {
    mocks.create.mockResolvedValue({})
    await recordReset('org-1', 'restore', 'user-1')
    await recordReset('org-1', 'import_undo')
    expect(mocks.create.mock.calls.map((c) => c[0].data)).toEqual([
      {
        organizationId: 'org-1',
        entityType: 'restore',
        entityId: 'restore',
        actorUserId: 'user-1',
      },
      { organizationId: 'org-1', entityType: 'reset', entityId: 'import_undo', actorUserId: null },
    ])
  })

  it('never fails the change it describes, and logs no message that could quote a record', async () => {
    mocks.create.mockRejectedValue(new Error('the customer "Jane Doe" …'))
    await expect(recordReset('org-1', 'delete_content', 'user-1')).resolves.toBeUndefined()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('Jane')
  })

  it('announces a finished restore as restore.complete, and survives a failed dispatch', async () => {
    mocks.dispatch.mockResolvedValue(undefined)
    await announceRestore('org-1', 'user-1')
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'restore.complete',
        organizationId: 'org-1',
        data: { restoredAt: expect.any(String) },
      })
    )
    mocks.dispatch.mockRejectedValue(new Error('down'))
    await expect(announceRestore('org-1')).resolves.toBeUndefined()
  })
})
