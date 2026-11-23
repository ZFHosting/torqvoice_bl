/**
 * fork: the reconciliation on a real PostgreSQL (`npm run test:db`; docs/fork/milestones/M6-reconcile.md,
 * Acceptance; MAPPING §12). On the fixture set, its files staged and attached, every gate passes; a line total
 * corrupted in the database fails the money gate and names its order; an imported customer deleted in the app fails
 * the count gate and names it. An order whose Shopmonkey lines and subtotal disagree is explained while its lines are
 * as loaded, and not once one changes; an order that failed in the last load fails the failures gate.
 *
 * Its own workshops and data folder, removed again. SYNTHETIC fixtures: extracts against the mock Shopmonkey.
 */
import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
const previousDataRoot = process.env.DATA_ROOT
let dataRoot = ''
let db: typeof import('@/lib/db')['db']
let engine: typeof import('@/integrations/shopmonkey/reconcile/engine')
let load: typeof import('@/integrations/shopmonkey/load/run')
let shop: Awaited<ReturnType<typeof createWorkshop>>
let mismatched: Awaited<ReturnType<typeof createWorkshop>>

type Shop = Awaited<ReturnType<typeof createWorkshop>>

/** A download of a file's link: a few bytes of the type its extension says. */
function download(link: URL): Promise<IncomingMessage> {
  const type = link.pathname.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'
  const stream = Readable.from([
    Buffer.from(`bytes of ${link.pathname}`),
  ]) as unknown as IncomingMessage
  stream.statusCode = 200
  stream.headers = { 'content-type': type }
  return Promise.resolve(stream)
}

const reconcile = (s: Shop) =>
  engine.reconcile(
    { organizationId: s.organizationId, connectionId: s.connectionId },
    { now: NOW, timeZone: 'America/Chicago' }
  )

const runLoad = async (s: Shop) => {
  const summary = await load.runLoad({
    organizationId: s.organizationId,
    connectionId: s.connectionId,
    runUserId: s.userId,
    now: NOW,
    countryCode: 'US',
    timeZone: 'America/Chicago',
  })
  expect(summary.failures).toEqual([])
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  dataRoot = await mkdtemp(path.join(tmpdir(), 'shopmonkey-reconcile-'))
  process.env.DATA_ROOT = dataRoot
  ;({ db } = await import('@/lib/db'))
  engine = await import('@/integrations/shopmonkey/reconcile/engine')
  load = await import('@/integrations/shopmonkey/load/run')
  const { createFileStager } = await import('@/integrations/shopmonkey/extract/files')

  shop = await createWorkshop('Reconcile')
  await extractInto(
    createMockShopmonkey(),
    shop,
    createFileStager({
      connectionId: shop.connectionId,
      root: dataRoot,
      open: download,
      check: async () => ({ ok: true }),
    })
  )
  await runLoad(shop)

  // Shopmonkey's own lines and subtotal disagree on order 1002: 5.00 more labor in the header than in its lines.
  mismatched = await createWorkshop('ReconcileMismatch')
  await extractInto(createMockShopmonkey(), mismatched)
  const order = await db.sourceRecord.findFirstOrThrow({
    where: { organizationId: mismatched.organizationId, table: 'order', remoteId: 'syn_ord_1002' },
    select: { id: true, payload: true },
  })
  const payload = order.payload as Record<string, unknown>
  await db.sourceRecord.update({
    where: { id: order.id },
    data: { payload: { ...payload, laborCents: Number(payload.laborCents ?? 0) + 500 } },
  })
  await runLoad(mismatched)
}, 120_000)

afterAll(async () => {
  if (shop) await shop.remove()
  if (mismatched) await mismatched.remove()
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT
  else process.env.DATA_ROOT = previousDataRoot
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
})

const lineOf = async (s: Shop, orderId: string) => {
  const workOrder = await db.sourceRecord.findFirstOrThrow({
    where: { organizationId: s.organizationId, table: 'order', remoteId: orderId },
    select: { localId: true },
  })
  // A labor line on a job that counts (not declined, not deferred).
  return db.serviceLabor.findFirstOrThrow({
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
}

describe('the reconciliation of the fixture set', () => {
  it('passes every gate, with every staged record (files included) in a bucket', async () => {
    const report = await reconcile(shop)
    expect(report.gates).toEqual({
      counts: expect.objectContaining({ passed: true, code: 'all_accounted' }),
      money: expect.objectContaining({ passed: true, code: 'money_explained' }),
      receivables: expect.objectContaining({ passed: true, code: 'receivables_equal' }),
      failures: expect.objectContaining({ passed: true, code: 'no_failures' }),
    })
    expect(report.passed).toBe(true)
    expect(report.countProblems).toEqual([])
    // Every staged record is in exactly one bucket.
    for (const t of report.counts) {
      const inBuckets = Object.values(t.buckets).reduce((a, n) => a + (n ?? 0), 0)
      expect(inBuckets, t.table).toBe(t.staged)
    }
    const by = (table: string) => report.counts.find((t) => t.table === table)
    expect(by('order')?.buckets).toMatchObject({ loaded: 4, deleted: 1 })
    expect(by('order')?.shopmonkeyTotal).toBe(5)
    expect(by('payment')?.skipped).toEqual({ payment_not_succeeded: 1 })
    // Downloaded files: the order's attached, the inspection's photo in its items.
    expect(by('order_file')?.buckets).toEqual({ loaded: 1 })
    expect(by('inspection_file')?.buckets).toEqual({ folded: 1 })
    // The two invoices' balances, to the cent, on both sides; the estimate's total too.
    expect(report.receivables.torqvoiceCents).toBe(report.receivables.shopmonkeyCents)
    expect(report.money).toMatchObject({ workOrders: 3, quotes: 1, unexplained: 0 })
    expect(report.spotChecks.map((s) => s.orderId).sort()).toEqual(['syn_ord_1003', 'syn_ord_1004'])
    expect(report.months.torqvoice.at(-1)?.openReceivables).toBe(
      report.months.shopmonkey.at(-1)?.openReceivables
    )
    // Kept on the connection, for the import page, beside the extract's own state.
    const state = (
      await db.integrationConnection.findUniqueOrThrow({
        where: { id: shop.connectionId },
        select: { state: true },
      })
    ).state as { lastReconciliation: { passed: boolean }; extract: { runId: string } }
    expect(state.lastReconciliation.passed).toBe(true)
    expect(state.extract.runId).toEqual(expect.any(String))
  })

  it('fails the money gate on a line total corrupted in the database, naming the order', async () => {
    const line = await lineOf(shop, 'syn_ord_1003')
    await db.serviceLabor.update({ where: { id: line.id }, data: { total: line.total + 12.34 } })
    try {
      const report = await reconcile(shop)
      expect(report.gates.money).toMatchObject({ passed: false, code: 'money_unexplained' })
      expect(report.passed).toBe(false)
      const unexplained = report.money.differences.filter((d) => !d.explainedBy)
      expect(unexplained).toEqual([
        expect.objectContaining({ orderId: 'syn_ord_1003', field: 'lines' }),
      ])
      expect(unexplained[0].torqvoiceCents - unexplained[0].shopmonkeyCents).toBe(1234)
    } finally {
      await db.serviceLabor.update({ where: { id: line.id }, data: { total: line.total } })
    }
    expect((await reconcile(shop)).gates.money.passed).toBe(true)
  })

  it('fails the count gate when an imported customer is deleted in the app, naming it', async () => {
    const record = await db.sourceRecord.findFirstOrThrow({
      where: { organizationId: shop.organizationId, table: 'customer', localEntity: 'Customer' },
      select: { remoteId: true, localId: true },
    })
    await db.customer.delete({ where: { id: record.localId as string } })
    const report = await reconcile(shop)
    expect(report.gates.counts).toMatchObject({ passed: false, code: 'records_unaccounted' })
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

describe('an order whose Shopmonkey lines and subtotal disagree', () => {
  it('is explained by money_mismatch while its lines are as loaded, and not once one changes', async () => {
    const report = await reconcile(mismatched)
    expect(report.gates.money.passed).toBe(true)
    expect(report.money.differences).toEqual([
      expect.objectContaining({
        orderId: 'syn_ord_1002',
        field: 'lines',
        explainedBy: 'money_mismatch',
      }),
    ])
    const line = await lineOf(mismatched, 'syn_ord_1002')
    await db.serviceLabor.update({ where: { id: line.id }, data: { total: line.total + 1 } })
    try {
      const changed = await reconcile(mismatched)
      expect(changed.gates.money.passed).toBe(false)
      expect(changed.money.differences).toEqual([
        expect.objectContaining({ orderId: 'syn_ord_1002', field: 'lines', explainedBy: null }),
      ])
    } finally {
      await db.serviceLabor.update({ where: { id: line.id }, data: { total: line.total } })
    }
  })

  it('fails the failures gate on an order that failed in the last load, though its old row is linked', async () => {
    const connection = await db.integrationConnection.findUniqueOrThrow({
      where: { id: mismatched.connectionId },
      select: { state: true },
    })
    const state = connection.state as {
      lastLoad: { counts: Record<string, Record<string, number>> }
    }
    state.lastLoad.counts.order.failed = 1
    await db.integrationConnection.update({
      where: { id: mismatched.connectionId },
      data: { state: state as object },
    })
    const report = await reconcile(mismatched)
    expect(report.gates.failures).toMatchObject({
      passed: false,
      code: 'orders_failed',
      values: { orders: 1 },
    })
  })
})
