/**
 * @vitest-environment node
 *
 * fork (M8): what the import screen shows of an extract and the loads: per table how far it read, the rate and the
 * time the lists still need, whether it was stopped, and each load with whether it was undone. SYNTHETIC state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { auditLog: { findMany: mocks.findMany } } }))

import {
  emptyChildCounts,
  emptyCounts,
  newCheckpoint,
  startState,
} from '@/integrations/shopmonkey/extract/plan'
import { tableSpec } from '@/integrations/shopmonkey/extract/tables'
import { importView } from '@/features/shopmonkey-import/Lib/importView.server'

const NOW = new Date('2026-01-01T12:10:00.000Z')

function extract() {
  const state = startState(null, {
    runId: 'run-1',
    only: ['customer', 'order'],
    now: new Date('2026-01-01T12:00:00.000Z'),
  })
  // Customers read whole (step 0 done), orders half way.
  state.step = 1
  state.steps.customer = {
    ...newCheckpoint('backfill', tableSpec('customer'), true),
    stage: 'done',
    skip: 400,
    total: 400,
    counts: { ...emptyCounts(), created: 400 },
  }
  state.steps.order = {
    ...newCheckpoint('backfill', tableSpec('order'), true),
    skip: 600,
    total: 1800,
    counts: { ...emptyCounts(), created: 590, unchanged: 10 },
    children: { ...emptyChildCounts(), created: 5 },
  }
  return state
}

beforeEach(() => {
  mocks.findMany.mockReset()
  mocks.findMany.mockResolvedValue([])
})

describe('the import view', () => {
  it('shows how far each table has read, the rate, and the minutes the lists still need', async () => {
    const view = await importView(
      'org-1',
      { id: 'conn-1', status: 'active', state: { extract: extract() } },
      NOW
    )
    expect(view.webhookUrl).toMatch(/\/api\/integrations\/shopmonkey\/conn-1\/webhook$/)
    const tables = Object.fromEntries((view.extract?.tables ?? []).map((t) => [t.key, t]))
    expect(tables.customer).toMatchObject({ stage: 'done', read: 400, total: 400, written: 400 })
    expect(tables.order).toMatchObject({ stage: 'list', read: 600, total: 1800, written: 595 })
    // 1,000 records in 10 minutes: 100 a minute, and 1,200 orders left.
    expect(view.extract?.perMinute).toBe(100)
    expect(view.extract?.minutesLeft).toBe(12)
    expect(view.extract?.stopped).toBe(false)
  })

  it('says a run was stopped, and gives no estimate once it has finished', async () => {
    const stopped = await importView(
      'org-1',
      {
        id: 'conn-1',
        status: 'active',
        state: { extract: extract(), extractStop: { runId: 'run-1' } },
      },
      NOW
    )
    expect(stopped.extract?.stopped).toBe(true)
    const finished = extract()
    finished.finishedAt = NOW.toISOString()
    const done = await importView(
      'org-1',
      { id: 'conn-1', status: 'active', state: { extract: finished } },
      NOW
    )
    expect(done.extract?.minutesLeft).toBeNull()
  })

  it('lists the loads of this connection, each with whether it was undone, from the audit log', async () => {
    mocks.findMany.mockResolvedValue([
      {
        action: 'shopmonkey.import_undo',
        timestamp: new Date('2026-01-02T00:00:00Z'),
        metadata: { runId: 'run-a' },
      },
      {
        action: 'shopmonkey.import',
        timestamp: new Date('2026-01-01T13:00:00Z'),
        metadata: { runId: 'run-b', counts: { order: { created: 2, updated: 1 } } },
      },
      {
        action: 'shopmonkey.import',
        timestamp: new Date('2026-01-01T12:00:00Z'),
        metadata: { runId: 'run-a', counts: { customer: { created: 4, updated: 0 } } },
      },
    ])
    const view = await importView('org-1', { id: 'conn-1', status: 'active', state: {} }, NOW)
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1', entityId: 'conn-1' }),
      })
    )
    expect(view.runs).toEqual([
      { runId: 'run-b', at: '2026-01-01T13:00:00.000Z', records: 3, undone: false },
      { runId: 'run-a', at: '2026-01-01T12:00:00.000Z', records: 4, undone: true },
    ])
    expect(view.extract).toBeNull()
  })
})
