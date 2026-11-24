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
import { Prisma } from '@/generated/prisma/client'
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
  // A webhook that takes every event, there from before the first load: no run, and no invoice it issues, may
  // reach it (acceptance; asserted at the end).
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
    // Everything hanging off each work order, by row id: a rewrite gives new ids.
    const rowsOf = async (serviceRecordId: string) => {
      const where = { serviceRecordId }
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort()
      return {
        parts: ids(await db.servicePart.findMany({ where, select: { id: true } })),
        labor: ids(await db.serviceLabor.findMany({ where, select: { id: true } })),
        jobs: ids(await db.workJob.findMany({ where, select: { id: true } })),
        payments: ids(await db.payment.findMany({ where, select: { id: true } })),
      }
    }
    const childrenBefore = new Map(
      await Promise.all(before.map(async (r) => [r.id, await rowsOf(r.id)] as const))
    )
    const people = async () => ({
      customers: await db.customer.findMany({
        where: { organizationId },
        select: { id: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
      vehicles: await db.vehicle.findMany({
        where: { organizationId },
        select: { id: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    })
    const peopleBefore = await people()
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
        expect((await rowsOf(row.id)).labor).not.toEqual(childrenBefore.get(row.id)?.labor)
      } else {
        expect(row.updatedAt).toEqual(was?.updatedAt)
        expect(await rowsOf(row.id), row.invoiceNumber ?? row.id).toEqual(
          childrenBefore.get(row.id)
        )
      }
    }
    expect(await people()).toEqual(peopleBefore)
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

  it('prints an imported invoice by its Shopmonkey services, in their order, each line under its own (M9)', async () => {
    // PROVISIONAL(M0:S5): the structure of Shopmonkey's own invoice PDF is taken from its documented services; there
    // is no recorded PDF to compare with until a key is available (B1).
    const invoice = await db.serviceRecord.findFirstOrThrow({
      where: { organizationId, invoiceNumber: '1003' },
      select: { id: true },
    })
    const jobs = await db.workJob.findMany({
      where: { serviceRecordId: invoice.id },
      orderBy: { ordinal: 'asc' },
      select: { id: true, name: true },
    })
    expect(jobs.length).toBeGreaterThan(1)
    const { assembleInvoicePrint } = await import('@/features/invoices/Lib/assembleInvoicePrint')
    const { buildInvoicePrintSpec } = await import(
      '@/features/invoice-designer/Pdf/buildInvoicePrint'
    )
    const sheet = await assembleInvoicePrint(invoice.id)
    if (!sheet) throw new Error('no sheet')
    const spec = buildInvoicePrintSpec({
      data: sheet.data,
      workshop: sheet.workshop,
      invoiceSettings: sheet.invoiceSettings,
      template: sheet.template,
      labels: {},
    })
    // The workshop's design sets no grouping: an imported invoice prints by job. Each table's headings follow the
    // services' order, and every line sits under the heading of the job it was loaded under.
    const jobOfLine = new Map<string, string>()
    for (const l of sheet.data.laborItems) jobOfLine.set(l.description, l.jobId ?? '')
    for (const p of sheet.data.partItems) jobOfLine.set(p.name, p.jobId ?? '')
    const nameOf = new Map(jobs.map((j) => [j.id, j.name]))
    const order = jobs.map((j) => j.name)
    const tables: { rows: Record<string, string>[] }[] = []
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk)
      else if (node && typeof node === 'object') {
        const n = node as Record<string, unknown>
        if (n.kind === 'table' && Array.isArray(n.rows) && n.groupKey) tables.push(n as never)
        Object.values(n).forEach(walk)
      }
    }
    walk(spec)
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      let heading = ''
      const headings: string[] = []
      for (const row of table.rows) {
        if (row.groupTitle) {
          // A declined or deferred service is marked after its name (its lines don't count toward the total).
          heading = row.groupTitle.replace(/ \((declined|deferred)\)$/, '')
          headings.push(heading)
        } else if (!row.groupSubtotal && row.desc && jobOfLine.has(row.desc)) {
          const jobId = jobOfLine.get(row.desc) as string
          expect(heading).toBe(jobId ? nameOf.get(jobId) : 'Other')
        }
      }
      const named = headings.filter((h) => h !== 'Other')
      expect(named).toEqual(order.filter((name) => named.includes(name)))
      // A declined or deferred service: its lines are left out of the invoice's stored subtotal, so no subtotal of
      // its own either (the fixture's "Coolant flush" is declined).
      // The counted services keep theirs.
      expect(table.rows.some((row) => row.groupSubtotal)).toBe(true)
      for (const row of table.rows) {
        if (row.groupSubtotal) expect(row.desc).not.toMatch(/\((declined|deferred)\)/)
      }
    }
    expect(JSON.stringify(spec)).toContain('Coolant flush (declined)')
  })

  it('records one audit event per run, and fires no webhook even for a webhook that takes every event', async () => {
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
    // The webhook has been there since before the first load and every invoice it issued: nothing reached it.
    expect(await db.webhookDelivery.count({ where: { webhook: { organizationId } } })).toBe(0)
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

  it('refuses too while such a connection is in error: its jobs wait and run once it is fixed', async () => {
    const before = await counts()
    const xero = await db.integrationConnection.create({
      data: { organizationId, connectorId: 'xero', createdById: userId, status: 'error' },
    })
    try {
      await expect(run()).rejects.toMatchObject({ name: 'LoadRefused' })
      expect(await counts()).toEqual(before)
    } finally {
      await db.integrationConnection.delete({ where: { id: xero.id } })
    }
  })

  it('issues on the next run an imported invoice a past run left unissued, though its order is unchanged', async () => {
    const invoice = await db.serviceRecord.findFirstOrThrow({
      where: { organizationId, invoiceNumber: '1004' },
      select: { id: true },
    })
    // As a run that stopped before issuing, or whose issue failed, leaves it.
    await db.serviceRecord.update({
      where: { id: invoice.id },
      data: { issuedAt: null, issuedData: Prisma.DbNull },
    })
    const summary = await run()
    expect(summary.counts.order.updated).toBe(0)
    expect(summary.issued).toBe(1)
    expect(summary.issueFailed).toBe(0)
    const after = await db.serviceRecord.findFirstOrThrow({
      where: { id: invoice.id },
      select: { issuedAt: true },
    })
    expect(after.issuedAt).not.toBeNull()
    // Issued once: a further run issues nothing.
    expect((await run()).issued).toBe(0)
  })
})
