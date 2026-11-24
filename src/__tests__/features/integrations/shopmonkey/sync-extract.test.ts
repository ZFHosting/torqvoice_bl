/**
 * @vitest-environment node
 *
 * fork: the extract's part in the sync window (M7). A delta reads a large GET list newest first and stops at its
 * start, and reads it whole when the pages don't come back in that order; each table starts at its own watermark; one
 * record is read again by id with its children, and a 404 marks it deleted; a webhook names the record to read, never
 * the data to keep. SYNTHETIC fixtures; PROVISIONAL(M0:S1/S2).
 */
import { describe, expect, it } from 'vitest'
import { createShopmonkeyClient } from '@/integrations/shopmonkey/client'
import {
  type ExtractDeps,
  extractSettings,
  extractStep,
  refetchRecord,
} from '@/integrations/shopmonkey/extract/engine'
import type { FileStager } from '@/integrations/shopmonkey/extract/files'
import { type ExtractState, startState } from '@/integrations/shopmonkey/extract/plan'
import { deltaStart, OVERLAP_MS } from '@/integrations/shopmonkey/sync/delta'
import { refetchTarget } from '@/integrations/shopmonkey/webhook'
import { createMemoryStore } from './memoryStore'
import { createMockShopmonkey, type MockOptions } from './mockServer'

const NOW = new Date('2025-06-01T00:00:00.000Z')

function harness(options: MockOptions = {}) {
  const mock = createMockShopmonkey(options)
  const memory = createMemoryStore()
  const logs: unknown[][] = []
  const files: FileStager = {
    fetchUrl: async () => ({ skipped: 'not_found' as const }),
    write: async () => ({ skipped: 'too_large' as const }),
  }
  const deps: ExtractDeps = {
    client: createShopmonkeyClient({
      fetch: mock.fetch,
      log: () => undefined,
      sleep: async () => undefined,
      random: () => 0,
    }),
    store: memory.store,
    files,
    settings: extractSettings({ locationId: 'syn_loc_1' }),
    companyId: 'syn_com_1',
    log: (...args: unknown[]) => {
      logs.push(args)
    },
    now: () => NOW,
  }
  async function run(state: ExtractState): Promise<ExtractState> {
    let current = state
    for (let i = 0; i < 5000; i++) {
      const result = await extractStep(deps, current)
      current = result.state
      if (result.done) return current
    }
    throw new Error('The extract did not finish')
  }
  const orderListReads = () =>
    mock.calls.filter((c) => c.method === 'GET' && c.path === '/v3/order').length
  return { mock, memory, deps, logs, run, orderListReads }
}

describe('a delta of a large GET list', () => {
  // 250 orders dated 2025-01-01 besides the fixtures' five (the newest 2025-03-10): three pages read whole.
  const only = ['order']
  const sinceByTable = { order: '2025-02-01T00:00:00.000Z' }

  it('reads it newest first and stops at the first page that reaches its start', async () => {
    const h = harness({ extra: { order: 250 } })
    const state = await h.run(startState(null, { runId: 'd1', only, sinceByTable, now: NOW }))
    expect(h.orderListReads()).toBe(1)
    expect(state.steps.order.phase).toBe('delta')
    expect(state.steps.order.unordered).toBeUndefined()
    // The changed ones are on the first page, newest first.
    for (const id of ['syn_ord_1003', 'syn_ord_1002'])
      expect(h.memory.get('order', id)).toBeTruthy()
  })

  it('reads it whole, warning, when the pages come back in another order', async () => {
    const h = harness({ extra: { order: 250 }, ignoreOrderby: true })
    const state = await h.run(startState(null, { runId: 'd2', only, sinceByTable, now: NOW }))
    expect(h.orderListReads()).toBe(3)
    expect(state.steps.order.unordered).toBe(true)
    expect(
      h.logs.some(
        ([level, message]) => level === 'warn' && /isn't newest first/.test(String(message))
      )
    ).toBe(true)
  })

  it('reads every page a few records back from the last, so a delete between pages skips nothing', async () => {
    const h = harness({ extra: { order: 250 } })
    await h.run(
      startState(null, {
        runId: 'd4',
        only,
        sinceByTable: { order: '2024-12-01T00:00:00.000Z' },
        now: NOW,
      })
    )
    // 255 orders newest first, ten read again per page: 0-99, 90-189, 180-254.
    expect(
      h.mock.calls.filter((c) => c.method === 'GET' && c.path === '/v3/order').map((c) => c.skip)
    ).toEqual([0, 90, 180])
    expect([...h.memory.rows.values()].filter((r) => r.table === 'order')).toHaveLength(255)
  })

  it('keeps reading newest first across pages when every record has its own date', async () => {
    const h = harness({ extra: { order: 250 } })
    // A minute apart, all on 1 January 2025: newest first, they never tie.
    let minute = 0
    for (const row of h.mock.data.order) {
      if (String(row.id).includes('_gen_')) {
        row.updatedDate = new Date(Date.UTC(2025, 0, 1) + minute++ * 60_000).toISOString()
      }
    }
    const state = await h.run(
      startState(null, {
        runId: 'd5',
        only,
        sinceByTable: { order: '2024-12-01T00:00:00.000Z' },
        now: NOW,
      })
    )
    expect(
      h.mock.calls.filter((c) => c.method === 'GET' && c.path === '/v3/order').map((c) => c.skip)
    ).toEqual([0, 90, 180])
    expect(state.steps.order.unordered).toBeUndefined()
    expect(h.logs.some(([level]) => level === 'warn')).toBe(false)
  })

  it('reads a backfill whole, in id order, whatever the table says', async () => {
    const h = harness({ extra: { order: 250 } })
    await h.run(startState(null, { runId: 'b1', only, now: NOW }))
    expect(h.orderListReads()).toBe(3)
  })
})

describe('a delta of a search', () => {
  it("starts each table at its own date, and a table it doesn't name at the run's", async () => {
    const h = harness()
    await h.run(
      startState(null, {
        runId: 'd3',
        only: ['customer', 'inventory_part'],
        since: '2099-01-01T00:00:00.000Z',
        sinceByTable: { customer: '2021-06-01T00:00:00.000Z' },
        now: NOW,
      })
    )
    // The two customers updated since 2021-06-01; no part is updated since 2099.
    expect(
      [...h.memory.rows.values()]
        .filter((r) => r.table === 'customer')
        .map((r) => r.remoteId)
        .sort()
    ).toEqual(['syn_cus_3', 'syn_cus_4'])
    expect([...h.memory.rows.values()].filter((r) => r.table === 'inventory_part')).toEqual([])
  })
})

describe('deltaStart', () => {
  it('starts each table five minutes before its watermark, the rest five minutes before the last run', () => {
    const previous = startState(null, { runId: 'p', now: NOW })
    previous.finishedAt = NOW.toISOString()
    previous.watermarks = { order: '2025-03-10T15:00:00.000Z' }
    const next = deltaStart(previous, { runId: 'n', now: NOW, sync: true })
    expect(OVERLAP_MS).toBe(5 * 60_000)
    expect(next.sinceByTable).toEqual({ order: '2025-03-10T14:55:00.000Z' })
    expect(next.since).toBe('2025-05-31T23:55:00.000Z')
    expect(next.sync).toBe(true)
    expect(next.watermarks).toEqual(previous.watermarks)
  })
})

describe('refetchRecord', () => {
  it('reads one order again by id with its children, whether or not the order itself changed', async () => {
    const h = harness()
    const first = await refetchRecord(h.deps, 'order', 'syn_ord_1002')
    expect(first.outcome).toBe('staged')
    expect(first.counts.created).toBe(1)
    expect(h.memory.get('order_service', 'syn_svc_1002_1')).toBeTruthy()
    expect(h.memory.get('order_service', 'syn_svc_1002_2')).toBeTruthy()
    // Its customer and vehicle, which no list staged here, read by id.
    expect(h.memory.get('customer', 'syn_cus_2')).toBeTruthy()
    expect(h.memory.get('vehicle', 'syn_veh_2')).toBeTruthy()

    // A service removed in Shopmonkey, the order untouched: the refetch still reads its services, and marks it gone.
    h.mock.remove('order_service', 'syn_svc_1002_2')
    const again = await refetchRecord(h.deps, 'order', 'syn_ord_1002')
    expect(again.counts.unchanged).toBe(1)
    expect(again.children.gone).toBe(1)
    expect(h.memory.get('order_service', 'syn_svc_1002_2')?.remoteDeletedAt).toEqual(NOW)
    expect(h.memory.get('order_service', 'syn_svc_1002_1')?.remoteDeletedAt).toBeFalsy()
  })

  it('marks a record Shopmonkey answers 404 for deleted, and leaves one it never staged alone', async () => {
    const h = harness()
    await refetchRecord(h.deps, 'customer', 'syn_cus_1')
    expect(h.memory.get('customer', 'syn_cus_1')?.remoteDeletedAt).toBeFalsy()
    h.mock.remove('customer', 'syn_cus_1')
    expect((await refetchRecord(h.deps, 'customer', 'syn_cus_1')).outcome).toBe('gone')
    expect(h.memory.get('customer', 'syn_cus_1')?.remoteDeletedAt).toEqual(NOW)
    expect((await refetchRecord(h.deps, 'customer', 'syn_cus_404')).outcome).toBe('gone')
    expect(h.memory.get('customer', 'syn_cus_404')).toBeUndefined()
  })

  it("leaves another location's record out, and reads nothing for a table it can't read by id", async () => {
    const h = harness()
    h.mock.change('order', 'syn_ord_1002', { locationId: 'syn_loc_2' })
    expect((await refetchRecord(h.deps, 'order', 'syn_ord_1002')).outcome).toBe('elsewhere')
    expect(h.memory.get('order', 'syn_ord_1002')).toBeUndefined()
    expect((await refetchRecord(h.deps, 'company', 'syn_com_1')).outcome).toBe('not_read')
    expect((await refetchRecord(h.deps, 'not_a_table', 'x')).outcome).toBe('not_read')
  })
})

describe("a webhook's target", () => {
  it('is the record its table and data.id name, and a payment its order', () => {
    expect(
      refetchTarget({
        operation: 'UPDATE',
        table: 'order',
        data: { id: 'syn_ord_1002', status: 'x' },
      })
    ).toEqual({ table: 'order', id: 'syn_ord_1002' })
    expect(
      refetchTarget({
        operation: 'DELETE',
        table: 'payment',
        data: { id: 'syn_pay_1', orderId: 'syn_ord_1003' },
      })
    ).toEqual({ table: 'order', id: 'syn_ord_1003' })
  })

  it('is nothing for a table not read by id, or a body without an id', () => {
    expect(refetchTarget({ table: 'company', data: { id: 'syn_com_1' } })).toBeNull()
    expect(refetchTarget({ table: 'webhook_test', data: { id: '1' } })).toBeNull()
    expect(refetchTarget({ table: 'order', data: {} })).toBeNull()
    expect(refetchTarget({ table: 'payment', data: { id: 'p' } })).toBeNull()
    expect(refetchTarget('not json')).toBeNull()
  })
})
