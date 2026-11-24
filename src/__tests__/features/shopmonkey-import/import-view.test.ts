/**
 * @vitest-environment node
 *
 * fork (M8): what the import screen shows of an extract and the loads: per table how far it read, the rate and the
 * time the lists still need, whether it was stopped, and each load with whether it was undone; a run whose job is gone
 * says so; the report is cut to what the screen lists. SYNTHETIC state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), jobs: vi.fn(), raw: vi.fn() }))
vi.mock('@/lib/db', () => ({
  db: {
    auditLog: { findMany: mocks.findMany },
    integrationJob: { findMany: mocks.jobs },
    // The load lists: `loadAudits(org, connection, sync, take)`, a tagged template.
    $queryRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => mocks.raw(...values),
  },
}))

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
  mocks.jobs.mockReset()
  mocks.jobs.mockResolvedValue([])
  mocks.raw.mockReset()
  mocks.raw.mockResolvedValue([])
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
    // Asked to stop, but its job hasn't ended yet: not stopped, and the queue says an extract is live.
    mocks.jobs.mockResolvedValueOnce([{ kind: 'extract.step' }])
    const stopping = await importView(
      'org-1',
      {
        id: 'conn-1',
        status: 'active',
        state: { extract: extract(), extractStop: { runId: 'run-1' } },
      },
      NOW
    )
    expect(stopping.extract?.stopped).toBe(false)
    expect(stopping.live).toEqual({ extract: true, sync: false, load: false, cutover: false })
    // The sync's next read queued is not the operator's run: Stop and Resume don't wait on it.
    mocks.jobs.mockResolvedValueOnce([{ kind: 'sync.delta' }])
    const syncQueued = await importView(
      'org-1',
      {
        id: 'conn-1',
        status: 'active',
        state: { extract: extract(), extractStop: { runId: 'run-1' } },
      },
      NOW
    )
    expect(syncQueued.live).toEqual({ extract: false, sync: true, load: false, cutover: false })
    expect(syncQueued.extract?.stopped).toBe(true)
    const finished = extract()
    finished.finishedAt = NOW.toISOString()
    const done = await importView(
      'org-1',
      { id: 'conn-1', status: 'active', state: { extract: finished } },
      NOW
    )
    expect(done.extract?.minutesLeft).toBeNull()
  })

  it('lists the operator’s loads and the sync’s apart, newest first, each with whether it was undone', async () => {
    const operator = [
      {
        timestamp: new Date('2026-01-01T13:00:00Z'),
        metadata: { runId: 'run-b', counts: { order: { created: 2, updated: 1 } } },
      },
      {
        timestamp: new Date('2026-01-01T12:00:00Z'),
        metadata: { runId: 'run-a', counts: { customer: { created: 4, updated: 0 } } },
      },
    ]
    const sync = [
      {
        timestamp: new Date('2026-01-03T00:10:00Z'),
        metadata: { runId: 'run-s', counts: { order: { created: 0, updated: 1 } }, sync: true },
      },
    ]
    mocks.raw.mockImplementation((org, connection, isSync, take) => {
      expect([org, connection]).toEqual(['org-1', 'conn-1'])
      return Promise.resolve(isSync ? sync : operator).then((rows) => rows.slice(0, take as number))
    })
    mocks.findMany.mockResolvedValue([{ metadata: { runId: 'run-a' } }])
    const view = await importView('org-1', { id: 'conn-1', status: 'active', state: {} }, NOW)
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          entityId: 'conn-1',
          action: 'shopmonkey.import_undo',
        }),
      })
    )
    // The operator's twenty and the sync's five, each list asked for on its own.
    expect(mocks.raw).toHaveBeenCalledWith('org-1', 'conn-1', false, 20)
    expect(mocks.raw).toHaveBeenCalledWith('org-1', 'conn-1', true, 5)
    expect(view.runs).toEqual([
      { runId: 'run-s', at: '2026-01-03T00:10:00.000Z', records: 1, undone: false, sync: true },
      { runId: 'run-b', at: '2026-01-01T13:00:00.000Z', records: 3, undone: false, sync: false },
      { runId: 'run-a', at: '2026-01-01T12:00:00.000Z', records: 4, undone: true, sync: false },
    ])
    expect(view.extract).toBeNull()
  })

  it('says a load or a cutover the queue no longer has was interrupted, and leaves a live one as it is', async () => {
    const state = {
      loadRun: { status: 'running', dryRun: false, at: '2026-01-01T12:00:00Z', token: 't' },
      cutoverRun: { status: 'queued', dryRun: true, at: '2026-01-01T12:00:00Z', token: 'c' },
    }
    const gone = await importView('org-1', { id: 'conn-1', status: 'paused', state }, NOW)
    expect(gone.loadRun?.status).toBe('interrupted')
    expect(gone.cutoverRun?.status).toBe('interrupted')
    mocks.jobs.mockResolvedValueOnce([{ kind: 'load.run' }, { kind: 'cutover.run' }])
    const live = await importView('org-1', { id: 'conn-1', status: 'active', state }, NOW)
    expect(live.loadRun?.status).toBe('running')
    expect(live.cutoverRun?.status).toBe('queued')
  })

  it('sends the report with its lists cut to what the screen shows', async () => {
    const many = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))
    const report = {
      version: 1,
      countProblems: many(500, (i) => ({ table: 'order', remoteId: `o${i}` })),
      countProblemTotal: 500,
      money: {
        workOrders: 0,
        quotes: 0,
        differences: many(1000, (i) => ({ remoteId: `o${i}` })),
        differenceTotal: 1000,
        unexplained: 1000,
      },
      spotChecks: many(30, (i) => ({ remoteId: `o${i}` })),
      warnings: {
        phone_invalid: { count: 300, examples: many(50, (i) => ({ remoteId: `c${i}` })) },
      },
      failures: many(40, (i) => ({ table: 'order', remoteId: `f${i}` })),
      unmapped: many(60, (i) => ({ table: 'order', field: `f${i}` })),
      passed: false,
    }
    const view = await importView(
      'org-1',
      { id: 'conn-1', status: 'active', state: { lastReconciliation: report } },
      NOW
    )
    expect(view.report?.countProblems).toHaveLength(20)
    expect(view.report?.money.differences).toHaveLength(20)
    expect(view.report?.spotChecks).toHaveLength(20)
    expect(view.report?.failures).toHaveLength(20)
    expect(view.report?.unmapped).toHaveLength(20)
    // The counts stay whole: the screen says how many there were.
    expect(view.report?.money.differenceTotal).toBe(1000)
    expect(view.report?.countProblemTotal).toBe(500)
    expect(view.report?.warnings).toEqual({ phone_invalid: { count: 300, examples: [] } })
  })
})
