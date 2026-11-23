/**
 * fork: the reconciliation on a real PostgreSQL (`npm run test:db`; docs/fork/milestones/M6-reconcile.md,
 * Acceptance). On the fixture set every gate passes; a line total corrupted in the database fails the money gate and
 * names its order; an imported customer deleted in the app fails the count gate and names it. The report is kept on
 * the connection.
 *
 * Its own workshop, removed again. SYNTHETIC fixtures: an extract against the mock Shopmonkey, then a load.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let engine: typeof import('@/integrations/shopmonkey/reconcile/engine')
let shop: Awaited<ReturnType<typeof createWorkshop>>

const reconcile = () =>
  engine.reconcile(
    { organizationId: shop.organizationId, connectionId: shop.connectionId },
    { now: NOW, timeZone: 'America/Chicago' }
  )

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  engine = await import('@/integrations/shopmonkey/reconcile/engine')
  const load = await import('@/integrations/shopmonkey/load/run')
  shop = await createWorkshop('Reconcile')
  await extractInto(createMockShopmonkey(), shop)
  const summary = await load.runLoad({
    organizationId: shop.organizationId,
    connectionId: shop.connectionId,
    runUserId: shop.userId,
    now: NOW,
    countryCode: 'US',
    timeZone: 'America/Chicago',
  })
  expect(summary.failures).toEqual([])
})

afterAll(async () => {
  if (shop) await shop.remove()
})

describe('the reconciliation of the fixture set', () => {
  it('passes every gate, with every staged record in a bucket', async () => {
    const report = await reconcile()
    expect(report.gates).toEqual({
      counts: { passed: true, summary: expect.any(String) },
      money: { passed: true, summary: expect.any(String) },
      receivables: { passed: true, summary: expect.any(String) },
      failures: { passed: true, summary: expect.any(String) },
    })
    expect(report.passed).toBe(true)
    expect(report.countProblems).toEqual([])
    // Every staged record is in exactly one bucket.
    for (const t of report.counts) {
      const inBuckets = Object.values(t.buckets).reduce((a, n) => a + (n ?? 0), 0)
      expect(inBuckets, t.table).toBe(t.staged)
    }
    const orders = report.counts.find((t) => t.table === 'order')
    expect(orders?.buckets).toMatchObject({ loaded: 4, deleted: 1 })
    expect(orders?.shopmonkeyTotal).toBe(5)
    const payments = report.counts.find((t) => t.table === 'payment')
    expect(payments?.skipped).toEqual({ payment_not_succeeded: 1 })
    // The two invoices' balances, to the cent, on both sides.
    expect(report.receivables.torqvoiceCents).toBe(report.receivables.shopmonkeyCents)
    expect(report.money.workOrders).toBe(3)
    expect(report.money.unexplained).toBe(0)
    expect(report.spotChecks.length).toBeGreaterThan(0)
    expect(report.months.torqvoice.length).toBeGreaterThan(0)
    expect(report.months.torqvoice.at(-1)?.openReceivables).toBe(
      report.months.shopmonkey.at(-1)?.openReceivables
    )
    // Kept on the connection, for the import page.
    const state = (
      await db.integrationConnection.findUniqueOrThrow({
        where: { id: shop.connectionId },
        select: { state: true },
      })
    ).state as { lastReconciliation: { passed: boolean } }
    expect(state.lastReconciliation.passed).toBe(true)
  })

  it('fails the money gate on a line total corrupted in the database, naming the order', async () => {
    const workOrder = await db.sourceRecord.findFirstOrThrow({
      where: { organizationId: shop.organizationId, table: 'order', remoteId: 'syn_ord_1003' },
      select: { localId: true },
    })
    // A labor line on a job that counts (not declined, not deferred).
    const line = await db.serviceLabor.findFirstOrThrow({
      where: {
        serviceRecordId: workOrder.localId as string,
        OR: [
          { jobId: null },
          { job: { authorizationStatus: { not: 'Declined' }, deferredDate: null } },
        ],
        total: { gt: 0 },
      },
      select: { id: true, total: true },
    })
    await db.serviceLabor.update({ where: { id: line.id }, data: { total: line.total + 12.34 } })
    try {
      const report = await reconcile()
      expect(report.gates.money.passed).toBe(false)
      expect(report.passed).toBe(false)
      expect(report.money.differences.filter((d) => !d.explainedBy)).toEqual([
        expect.objectContaining({
          orderId: 'syn_ord_1003',
          field: 'lines',
          torqvoiceCents: expect.any(Number),
          shopmonkeyCents: expect.any(Number),
        }),
      ])
      const [difference] = report.money.differences
      expect(difference.torqvoiceCents - difference.shopmonkeyCents).toBe(1234)
    } finally {
      await db.serviceLabor.update({ where: { id: line.id }, data: { total: line.total } })
    }
    expect((await reconcile()).gates.money.passed).toBe(true)
  })

  it('fails the count gate when an imported customer is deleted in the app, naming it', async () => {
    const record = await db.sourceRecord.findFirstOrThrow({
      where: {
        organizationId: shop.organizationId,
        table: 'customer',
        localEntity: 'Customer',
      },
      select: { remoteId: true, localId: true },
    })
    await db.customer.delete({ where: { id: record.localId as string } })
    const report = await reconcile()
    expect(report.gates.counts.passed).toBe(false)
    expect(report.passed).toBe(false)
    expect(report.countProblems).toContainEqual(
      expect.objectContaining({
        table: 'customer',
        remoteId: record.remoteId,
        localId: record.localId,
        reason: 'missing',
      })
    )
  })
})
