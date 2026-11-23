/**
 * fork: the reconciliation at a real shop's size, on a real PostgreSQL (`npm run test:db`; M6 acceptance: "under a
 * minute on 50,000 orders"). Generated data: 50,000 imported invoices, each with two lines and a payment, and the
 * Shopmonkey records they were loaded from (each order with a service), written straight to the tables. An order's
 * payload carries about 2 KB of text that doesn't compress, so Postgres keeps it out of line as it would a real
 * one, and every key read of it costs what it would. The report is timed, and its gates pass.
 *
 * Its own workshop, removed again. GENERATED data.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorkshop, guardTestDatabase } from './shopmonkeyLoadHarness'

const ORDERS = 50_000
/** What doesn't compress: a real order's notes, labels, custom fields and line summaries, in size. */
const FILLER = randomBytes(1_650).toString('base64')
const CHUNK = 2_000
const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let shop: Awaited<ReturnType<typeof createWorkshop>>

async function inChunks<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK))
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  shop = await createWorkshop('ReconcileScale')
  const { organizationId, connectionId } = shop
  const records = []
  const labor = []
  const payments = []
  const sources = []
  const start = Date.UTC(2020, 0, 1)
  for (let i = 0; i < ORDERS; i++) {
    const id = randomUUID()
    const orderId = `gen_ord_${i}`
    const paymentId = `gen_pay_${i}`
    // Two lines of 25.00 and 37.50, 5.00 of tax, 40.00 paid: 27.50 open.
    const invoiced = new Date(start + i * 3_600_000)
    records.push({
      id,
      organizationId,
      title: `Order ${i}`,
      status: 'completed',
      invoiceNumber: String(10_000 + i),
      invoiceDate: invoiced,
      subtotal: 62.5,
      taxAmount: 5,
      totalAmount: 67.5,
      cost: 67.5,
    })
    labor.push(
      { serviceRecordId: id, description: 'Labor', hours: 1, rate: 25, total: 25 },
      { serviceRecordId: id, description: 'Labor', hours: 1.5, rate: 25, total: 37.5 }
    )
    payments.push({
      serviceRecordId: id,
      amount: 40,
      date: invoiced,
      method: 'cash',
      provider: 'shopmonkey',
      externalId: paymentId,
    })
    sources.push(
      {
        organizationId,
        connectionId,
        table: 'order',
        remoteId: orderId,
        payloadHash: orderId,
        localEntity: 'ServiceRecord',
        localId: id,
        payload: {
          id: orderId,
          number: 10_000 + i,
          status: 'Invoice',
          invoicedDate: invoiced.toISOString(),
          laborCents: 6_250,
          taxCents: 500,
          discountCents: 0,
          totalCostCents: 6_750,
          paidCostCents: 4_000,
          remainingCostCents: 2_750,
          notes: FILLER,
        },
      },
      {
        organizationId,
        connectionId,
        table: 'order_service',
        remoteId: `gen_svc_${i}`,
        payloadHash: `gen_svc_${i}`,
        payload: { id: `gen_svc_${i}`, orderId, name: 'Service' },
      },
      {
        organizationId,
        connectionId,
        table: 'payment',
        remoteId: paymentId,
        payloadHash: paymentId,
        payload: {
          id: paymentId,
          orderId,
          status: 'Succeeded',
          transactionType: 'Charge',
          amountCents: 4_000,
          recordedDate: invoiced.toISOString(),
        },
      }
    )
  }
  await inChunks(records, (data) => db.serviceRecord.createMany({ data }))
  await inChunks(labor, (data) => db.serviceLabor.createMany({ data }))
  await inChunks(payments, (data) => db.payment.createMany({ data }))
  await inChunks(sources, (data) => db.sourceRecord.createMany({ data }))
  await db.integrationConnection.update({
    where: { id: connectionId },
    data: {
      state: {
        extract: { steps: { order: { total: ORDERS, skip: ORDERS, counts: { skipped: 0 } } } },
      },
    },
  })
}, 600_000)

afterAll(async () => {
  if (shop) await shop.remove()
}, 600_000)

describe('the reconciliation of 50,000 orders', () => {
  it('runs in under a minute, and every gate passes', async () => {
    const engine = await import('@/integrations/shopmonkey/reconcile/engine')
    const started = Date.now()
    const report = await engine.reconcile(
      { organizationId: shop.organizationId, connectionId: shop.connectionId },
      { timeZone: 'America/Chicago' }
    )
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(60_000)
    expect(report.money.workOrders).toBe(ORDERS)
    expect(report.money.unexplained).toBe(0)
    expect(report.receivables).toMatchObject({
      shopmonkeyCents: ORDERS * 2_750,
      torqvoiceCents: ORDERS * 2_750,
    })
    expect(report.counts.find((t) => t.table === 'order')?.buckets).toEqual({ loaded: ORDERS })
    expect(report.counts.find((t) => t.table === 'payment')?.buckets).toEqual({ loaded: ORDERS })
    expect(report.counts.find((t) => t.table === 'order_service')?.buckets).toEqual({
      folded: ORDERS,
    })
    expect(report.spotChecks).toHaveLength(25)
    expect(report.passed).toBe(true)
  }, 600_000)
})
