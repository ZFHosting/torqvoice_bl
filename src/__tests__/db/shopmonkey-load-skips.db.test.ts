/**
 * fork: what a Shopmonkey load records about what it left out, on a real PostgreSQL (`npm run test:db`; M6 tasks
 * 0 and 1). Orders created before the connection's `historyFrom` stay in the archive; every record a load leaves
 * out says why (`SourceRecord.loadSkip`), and loading it later clears that; the run's warnings, by code with
 * examples, and its failures are kept in the connection's `state.lastLoad` for the reconciliation.
 *
 * Its own workshop, removed again. SYNTHETIC fixtures: order 1004 was created in 2023; 1005 is deleted; payment
 * `1003_4` failed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let load: typeof import('@/integrations/shopmonkey/load/run')
let shop: Awaited<ReturnType<typeof createWorkshop>>

const run = () =>
  load.runLoad({
    organizationId: shop.organizationId,
    connectionId: shop.connectionId,
    runUserId: shop.userId,
    now: NOW,
    countryCode: 'US',
    timeZone: 'America/Chicago',
  })

const skipOf = async (table: string, remoteId: string) =>
  await db.sourceRecord.findFirstOrThrow({
    where: { organizationId: shop.organizationId, source: 'shopmonkey', table, remoteId },
    select: { loadSkip: true, localId: true },
  })

const setHistoryFrom = (historyFrom: string | null) =>
  db.integrationConnection.update({
    where: { id: shop.connectionId },
    data: { settings: historyFrom ? { historyFrom } : {} },
  })

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  load = await import('@/integrations/shopmonkey/load/run')
  shop = await createWorkshop('LoadSkips')
  await extractInto(createMockShopmonkey(), shop)
})

afterAll(async () => {
  if (shop) await shop.remove()
})

describe('a load', () => {
  it('leaves orders from before historyFrom in the archive, and says why it left each record out', async () => {
    await setHistoryFrom('2024-01-01')
    const summary = await run()
    expect(summary.failures).toEqual([])

    // Created in 2023: no work order, its payments with it.
    expect(await skipOf('order', 'syn_ord_1004')).toEqual({ loadSkip: 'history', localId: null })
    for (const payment of ['syn_pay_1004_1', 'syn_pay_1004_2']) {
      expect((await skipOf('payment', payment)).loadSkip).toBe('payment_order_not_loaded')
    }
    expect(
      await db.payment.count({
        where: { provider: 'shopmonkey', externalId: { in: ['syn_pay_1004_1', 'syn_pay_1004_2'] } },
      })
    ).toBe(0)
    // Deleted in Shopmonkey: the extract marked it, and the load never reads it (the reconciliation counts it
    // deleted from that mark). A failed charge says why it's out.
    expect(
      await db.sourceRecord.findFirstOrThrow({
        where: { organizationId: shop.organizationId, table: 'order', remoteId: 'syn_ord_1005' },
        select: { loadSkip: true, localId: true, remoteDeletedAt: true },
      })
    ).toEqual({ loadSkip: null, localId: null, remoteDeletedAt: expect.any(Date) })
    expect((await skipOf('payment', 'syn_pay_1003_4')).loadSkip).toBe('payment_not_succeeded')
    // Loaded records carry no reason.
    expect((await skipOf('order', 'syn_ord_1003')).loadSkip).toBeNull()
    expect(summary.counts.order.skipped).toBe(1)

    // Every customer the load didn't make (and Shopmonkey didn't delete) says why.
    const customers = await db.sourceRecord.findMany({
      where: { organizationId: shop.organizationId, table: 'customer', remoteDeletedAt: null },
      select: { localId: true, loadSkip: true },
    })
    expect(customers.every((c) => (c.localId === null) === (c.loadSkip !== null))).toBe(true)
  })

  it('keeps its warnings by code, with examples, and its failures, for the reconciliation', async () => {
    const state = (
      await db.integrationConnection.findUniqueOrThrow({
        where: { id: shop.connectionId },
        select: { state: true },
      })
    ).state as {
      lastLoad: {
        runId: string
        warnings: Record<string, { count: number; examples: { code: string; remoteId: string }[] }>
        failures: unknown[]
        failureCount: number
      }
    }
    expect(state.lastLoad.runId).toEqual(expect.any(String))
    expect(state.lastLoad.failures).toEqual([])
    expect(state.lastLoad.failureCount).toBe(0)
    const groups = Object.entries(state.lastLoad.warnings)
    expect(groups.length).toBeGreaterThan(0)
    for (const [code, group] of groups) {
      expect(group.examples.length).toBe(Math.min(group.count, 20))
      expect(group.examples.every((e) => e.code === code)).toBe(true)
    }
  })

  it('loads an order left out once historyFrom no longer leaves it out, and forgets why it was', async () => {
    await setHistoryFrom(null)
    const summary = await run()
    expect(summary.failures).toEqual([])
    const order = await skipOf('order', 'syn_ord_1004')
    expect(order.loadSkip).toBeNull()
    expect(order.localId).not.toBeNull()
    // Its payments loaded too, and no longer say why they were left out.
    for (const payment of ['syn_pay_1004_1', 'syn_pay_1004_2']) {
      expect((await skipOf('payment', payment)).loadSkip).toBeNull()
    }
    // The failed charge on 1003 still says why, though its order was unchanged this run.
    expect((await skipOf('payment', 'syn_pay_1003_4')).loadSkip).toBe('payment_not_succeeded')
    expect(
      await db.payment.count({
        where: { provider: 'shopmonkey', externalId: { in: ['syn_pay_1004_1', 'syn_pay_1004_2'] } },
      })
    ).toBe(2)
  })

  it('keeps payment and refund warnings in the last load though every order is unchanged', async () => {
    const summary = await run()
    expect(summary.counts.order.unchanged).toBeGreaterThan(0)
    expect(summary.counts.order.created + summary.counts.order.updated).toBe(0)
    const state = (
      await db.integrationConnection.findUniqueOrThrow({
        where: { id: shop.connectionId },
        select: { state: true },
      })
    ).state as { lastLoad: { warnings: Record<string, { count: number }> } }
    // Order 1004 is refunded in full (MAPPING §6.5).
    expect(state.lastLoad.warnings.refund_net_nonpositive?.count).toBe(1)
  })
})
