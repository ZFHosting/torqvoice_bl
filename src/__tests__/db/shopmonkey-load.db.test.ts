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
] as const

async function counts() {
  const where = { organizationId }
  const out: Record<string, number> = {}
  const d = db as unknown as Record<string, { count: (args: unknown) => Promise<number> }>
  for (const t of TABLES) {
    out[t] =
      t === 'serviceLabor' || t === 'servicePart' || t === 'payment'
        ? await d[t].count({ where: { serviceRecord: where } })
        : t === 'quoteLabor' || t === 'quotePart'
          ? await d[t].count({ where: { quote: where } })
          : t === 'vehicleFinding'
            ? await d[t].count({ where: { vehicle: where } })
            : await d[t].count({ where })
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
    expect(after).toMatchObject({ customer: 3, vehicle: 3, serviceRecord: 3, quote: 1 })
    expect(after.payment).toBe(5)
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
