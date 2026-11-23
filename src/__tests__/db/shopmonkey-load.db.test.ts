/**
 * fork: loading the staged Shopmonkey archive into a workshop, on a real PostgreSQL (`npm run test:db`; M5
 * acceptance). The archive comes from a full extract against the mock Shopmonkey (synthetic fixtures). Loading
 * twice gives the same rows and updates nothing; one changed order updates only its rows; balances match; a dry run
 * keeps nothing.
 *
 * Its own workshop, removed again; it empties nothing. SYNTHETIC fixtures.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'

const url = process.env.E2E_DATABASE_URL ?? ''
const databaseName = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
if (url && !/test|e2e/.test(databaseName)) {
  throw new Error(
    `Refusing to use database "${databaseName}": its name must say test or e2e, like the rest of this suite.`
  )
}
process.env.DATABASE_URL = url

const stamp = randomUUID().slice(0, 8)
const NOW = new Date('2025-06-01T00:00:00.000Z')

let db: typeof import('@/lib/db')['db']
let load: typeof import('@/integrations/shopmonkey/load/run')
let organizationId = ''
let connectionId = ''
let userId = ''
let mock: ReturnType<typeof createMockShopmonkey>

/** Stages the mock's records into the archive, as a real extract would. */
async function extract() {
  const { createShopmonkeyClient } = await import('@/integrations/shopmonkey/client')
  const engine = await import('@/integrations/shopmonkey/extract/engine')
  const plan = await import('@/integrations/shopmonkey/extract/plan')
  const stage = await import('@/integrations/shopmonkey/extract/stage')
  const deps = {
    client: createShopmonkeyClient({
      fetch: mock.fetch,
      log: () => undefined,
      sleep: async () => undefined,
    }),
    store: stage.prismaSourceStore({ organizationId, connectionId }),
    files: {
      fetchUrl: async () => ({ skipped: 'not_found' as const }),
      write: async () => ({ skipped: 'too_large' as const }),
    },
    settings: engine.extractSettings({ locationId: 'syn_loc_1' }),
    companyId: 'syn_com_1',
    log: () => undefined,
    now: () => NOW,
  }
  let state = plan.startState(null, { runId: randomUUID(), now: NOW })
  for (let i = 0; i < 2_000; i++) {
    const result = await engine.extractStep(deps, state)
    state = result.state
    if (result.done) return
  }
  throw new Error('The extract did not finish')
}

const TABLES = [
  'customer',
  'customerContact',
  'vehicle',
  'technician',
  'workOrderStatus',
  'serviceRecord',
  'quote',
  'workJob',
  'serviceLabor',
  'servicePart',
  'quoteLabor',
  'quotePart',
  'payment',
  'vehicleFinding',
  'serviceRecordMeta',
  'inventoryPart',
  'stockMovement',
  'laborPreset',
  'appointment',
  'inspectionTemplate',
  'inspection',
  'inspectionItem',
  'timeEntry',
  'technicianShift',
  'customFieldValue',
] as const

async function counts() {
  const where = { organizationId }
  const out: Record<string, number> = {}
  const d = db as unknown as Record<string, { count: (args: unknown) => Promise<number> }>
  for (const t of TABLES) {
    const scoped: Record<string, unknown> = {
      serviceLabor: { serviceRecord: where },
      servicePart: { serviceRecord: where },
      payment: { serviceRecord: where },
      quoteLabor: { quote: where },
      quotePart: { quote: where },
      vehicleFinding: { vehicle: where },
      inspectionItem: { inspection: where },
      customFieldValue: { field: where },
    }
    out[t] = await d[t].count({ where: scoped[t] ?? where })
  }
  return out
}

const run = (dryRun = false) =>
  load.runLoad({
    organizationId,
    connectionId,
    runUserId: userId,
    dryRun,
    now: NOW,
    countryCode: 'US',
  })

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  load = await import('@/integrations/shopmonkey/load/run')
  organizationId = (await db.organization.create({ data: { name: `Load ${stamp}` } })).id
  const user = await db.user.create({
    data: { email: `load-owner-${stamp}@example.com`, name: 'Owner' },
  })
  userId = user.id
  await db.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
  connectionId = (
    await db.integrationConnection.create({
      data: { organizationId, connectorId: 'shopmonkey', createdById: userId, status: 'active' },
    })
  ).id
  mock = createMockShopmonkey()
  await extract()
})

afterAll(async () => {
  if (!db) return
  if (organizationId) await db.organization.deleteMany({ where: { id: organizationId } })
  if (userId) await db.user.deleteMany({ where: { id: userId } })
})

describe('loading the archive into a workshop', () => {
  it('keeps nothing on a dry run, and reports what a real run would make', async () => {
    const summary = await run(true)
    expect(summary.dryRun).toBe(true)
    expect(summary.counts.customer.created).toBeGreaterThan(0)
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true)
  })

  it('writes every record, and loading again changes nothing', async () => {
    const first = await run()
    expect(first.failures).toEqual([])
    const after = await counts()
    expect(after).toMatchObject({
      customer: 3,
      vehicle: 3,
      serviceRecord: 3,
      quote: 1,
      payment: 5,
      inventoryPart: 3,
      laborPreset: 3,
      appointment: 1,
      inspectionTemplate: 1,
      inspection: 1,
      timeEntry: 1,
      technicianShift: 2,
    })
    expect(after.stockMovement).toBeGreaterThan(0)
    expect(after.inspectionItem).toBeGreaterThan(0)
    const second = await run()
    expect(second.failures).toEqual([])
    for (const [table, c] of Object.entries(second.counts)) {
      expect(c.created + c.updated, table).toBe(0)
    }
    expect(await counts()).toEqual(after)
  })

  it('keeps open balances: an unpaid invoice is unpaid, a part-paid one shows its balance', async () => {
    const invoice = await db.serviceRecord.findFirst({
      where: { organizationId, invoiceNumber: '1003' },
      select: { totalAmount: true, payments: { select: { amount: true } } },
    })
    const paid = invoice?.payments.reduce((a, p) => a + Math.round(p.amount * 100), 0) ?? 0
    // Order 1003: deposit 100 + card 500 − refund 50 = 550 paid (the failed charge isn't a payment).
    expect(paid).toBe(55_000)
    expect(Math.round((invoice?.totalAmount ?? 0) * 100)).toBe(116_811)
    const open = await db.serviceRecord.findFirst({
      where: { organizationId, invoiceNumber: '1002' },
      select: { payments: { select: { id: true } } },
    })
    expect(open?.payments).toEqual([])
  })

  it('gives every imported job a start, so the date-ranged reports find it', async () => {
    const jobs = await db.serviceRecord.findMany({
      where: { organizationId },
      select: { startDateTime: true, serviceDate: true },
    })
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.filter((j) => !j.startDateTime)).toEqual([])
  })

  it('updates exactly the order that changed', async () => {
    const before = await db.serviceRecord.findMany({
      where: { organizationId },
      select: { id: true, invoiceNumber: true, updatedAt: true },
      orderBy: { invoiceNumber: 'asc' },
    })
    mock.change('order', 'syn_ord_1002', { name: 'Fleet service, renamed in Shopmonkey' })
    await extract()
    const summary = await run()
    expect(summary.counts.order).toMatchObject({ updated: 1, created: 0 })
    const after = await db.serviceRecord.findMany({
      where: { organizationId },
      select: { id: true, invoiceNumber: true, updatedAt: true, title: true },
      orderBy: { invoiceNumber: 'asc' },
    })
    for (const row of after) {
      const was = before.find((b) => b.id === row.id)
      if (row.invoiceNumber === '1002') {
        expect(row.title).toBe('Fleet service, renamed in Shopmonkey')
        expect(row.updatedAt.getTime()).toBeGreaterThan(was?.updatedAt.getTime() ?? 0)
      } else {
        expect(row.updatedAt).toEqual(was?.updatedAt)
      }
    }
  })
})

describe('around the records', () => {
  it('issues an imported invoice: locked like the app’s own, printing Shopmonkey’s number, lines and totals', async () => {
    const invoice = await db.serviceRecord.findFirst({
      where: { organizationId, invoiceNumber: '1003' },
      select: { id: true, issuedAt: true, sentAt: true, issuedData: true },
    })
    expect(invoice?.issuedAt).toEqual(new Date('2025-03-14T17:05:00.000Z'))
    expect(invoice?.sentAt).toEqual(new Date('2025-03-14T17:05:00.000Z'))
    expect(invoice?.issuedData).not.toBeNull()
    const { assembleInvoicePrint } = await import('@/features/invoices/Lib/assembleInvoicePrint')
    const sheet = await assembleInvoicePrint(invoice?.id as string)
    expect(sheet?.issuedAt).not.toBeNull()
    expect(sheet?.data).toMatchObject({
      invoiceNumber: '1003',
      subtotal: 1088.09,
      taxAmount: 80.02,
      totalAmount: 1168.11,
    })
    expect(sheet?.data.partItems.length).toBeGreaterThan(0)
    // A repair order isn't issued.
    const open = await db.serviceRecord.findFirst({
      where: { organizationId, invoiceNumber: '1002' },
      select: { issuedAt: true },
    })
    expect(open?.issuedAt).toBeNull()
  })

  it('records one audit event per run, and fires no webhook even for a webhook that takes every event', async () => {
    await db.webhook.create({
      data: {
        organizationId,
        name: 'Everything',
        createdById: userId,
        url: 'https://hooks.example.test/all',
        secret: 'x'.repeat(32),
        events: JSON.stringify(['*']),
        isActive: true,
      },
    })
    const deliveriesBefore = await db.webhookDelivery.count({
      where: { webhook: { organizationId } },
    })
    const auditsBefore = await db.auditLog.count({
      where: { organizationId, action: 'shopmonkey.import' },
    })
    mock.change('order', 'syn_ord_1003', { complaint: 'Changed again' })
    await extract()
    await run()
    // logAudit fans out to webhooks asynchronously; give it a moment.
    await new Promise((r) => setTimeout(r, 500))
    expect(
      await db.auditLog.count({ where: { organizationId, action: 'shopmonkey.import' } })
    ).toBe(auditsBefore + 1)
    expect(await db.webhookDelivery.count({ where: { webhook: { organizationId } } })).toBe(
      deliveriesBefore
    )
  })

  it('refuses to run while a connection that hears service.update is on, before writing anything', async () => {
    const before = await counts()
    const fiken = await db.integrationConnection.create({
      data: { organizationId, connectorId: 'fiken', createdById: userId, status: 'active' },
    })
    try {
      await expect(run()).rejects.toMatchObject({ name: 'LoadRefused' })
      expect(await counts()).toEqual(before)
      // A dry run issues nothing, so it may run.
      await expect(run(true)).resolves.toMatchObject({ dryRun: true })
    } finally {
      await db.integrationConnection.delete({ where: { id: fiken.id } })
    }
  })
})
