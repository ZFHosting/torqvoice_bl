/**
 * fork (A5, docs/fork/milestones/A5-events-reports.md) on a real PostgreSQL (`npm run test:db`): the reports match the
 * app's own reports for the same period, in a time zone far from UTC; `/source-records` and `/deleted` are scoped by
 * the key's workshop and refuse a key without the permission; a fork event goes out with the API's resource as `data`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  call,
  eventsOf,
  guardTestDatabase,
  newKey,
  newShop,
  removeCreated,
  route,
  type Shop,
} from './publicApiHarness'

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let a: Shop
let b: Shop

const ctx = vi.hoisted(() => ({ organizationId: '', userId: '' }))
// The reports screen's actions, run as the workshop's owner.
vi.mock('@/lib/with-auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/with-auth')>()
  return {
    ...real,
    withAuth: async (fn: (c: unknown) => Promise<unknown>) => ({
      success: true,
      data: await fn({ ...ctx, role: 'owner', isAdmin: true, isSuperAdmin: false }),
    }),
  }
})

const ZONE = 'Pacific/Auckland'

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  a = await newShop('A5a')
  b = await newShop('A5b')
  const { SETTING_KEYS } = await import('@/features/settings/Schema/settingsSchema')
  await db.appSetting.create({
    data: { organizationId: a.org, key: SETTING_KEYS.TIMEZONE, value: ZONE },
  })
  const customer = await db.customer.create({
    data: { organizationId: a.org, userId: a.owner, name: 'Report Customer' },
    select: { id: true },
  })
  const vehicle = await db.vehicle.create({
    data: { organizationId: a.org, userId: a.owner, customerId: customer.id, make: 'Volvo', model: 'V70', year: 2010 },
    select: { id: true },
  })
  // 1 May 01:00 in Auckland is still 30 April in UTC: the API and the screen must both call it May.
  const jobs = [
    { start: '2026-04-30T13:00:00.000Z', total: 1250, paid: 250, due: '2026-04-20T00:00:00.000Z' },
    { start: '2026-05-10T09:00:00.000Z', total: 800, paid: 800, due: '2026-05-20T00:00:00.000Z' },
    { start: '2026-03-31T10:00:00.000Z', total: 300, paid: 0, due: '2099-01-01T00:00:00.000Z' },
  ]
  for (const j of jobs) {
    const record = await db.serviceRecord.create({
      data: {
        organizationId: a.org,
        vehicleId: vehicle.id,
        customerId: customer.id,
        title: 'Report job',
        serviceDate: new Date(j.start),
        startDateTime: new Date(j.start),
        totalAmount: j.total,
        subtotal: j.total,
        invoiceDueDate: new Date(j.due),
        status: 'completed',
      },
      select: { id: true },
    })
    if (j.paid) await db.payment.create({ data: { serviceRecordId: record.id, amount: j.paid } })
  }
  await db.deletedRecord.createMany({
    data: [
      { organizationId: a.org, entityType: 'work_order', entityId: 'gone-wo' },
      { organizationId: a.org, entityType: 'customer', entityId: 'gone-cus' },
      { organizationId: b.org, entityType: 'work_order', entityId: 'other-shop' },
    ],
  })
  await db.sourceRecord.createMany({
    data: [
      { organizationId: a.org, connectionId: 'conn-a', table: 'order', remoteId: 'syn_1', payload: { id: 'syn_1' }, payloadHash: 'h1' },
      { organizationId: b.org, connectionId: 'conn-b', table: 'order', remoteId: 'syn_1', payload: { id: 'syn_1', b: true }, payloadHash: 'h2' },
    ],
  })
}, 120_000)

afterAll(async () => {
  if (db) {
    await db.sourceRecord.deleteMany({ where: { organizationId: { in: [a?.org, b?.org].filter(Boolean) } } })
  }
  await removeCreated()
})

describe('the reports', () => {
  it('group sales by the workshop’s month, as the reports screen does', async () => {
    const { GET } = await route('reports/sales')
    const res = await call(GET, a.key, 'GET', '/reports/sales?from=2026-03-01&to=2026-05-31&group=month')
    expect(res.status).toBe(200)
    const body = (await res.json()).data
    expect(body.timeZone).toBe(ZONE)
    const byMonth = Object.fromEntries(body.periods.map((p: { period: string }) => [p.period, p]))
    expect(byMonth['2026-05']).toMatchObject({ revenue: 2050, collected: 1050, count: 2 })
    expect(byMonth['2026-03']).toMatchObject({ revenue: 300, collected: 0, count: 1 })

    ctx.organizationId = a.org
    ctx.userId = a.owner
    const { getRevenueReport } = await import('@/features/reports/Actions/reportActions')
    const screen = await getRevenueReport({ startDate: '2026-03-01', endDate: '2026-05-31' })
    const screenMonths = Object.fromEntries(
      (screen.data?.monthly ?? []).map((m: { month: string; revenue: number; collected: number }) => [
        m.month,
        { revenue: m.revenue, collected: m.collected },
      ])
    )
    for (const [month, p] of Object.entries(byMonth) as [string, { revenue: number; collected: number }][]) {
      expect(screenMonths[month], month).toEqual({ revenue: p.revenue, collected: p.collected })
    }
  })

  it('age what is owed, its overdue part the past-due report’s total', async () => {
    const { GET } = await route('reports/receivables')
    const body = (await (await call(GET, a.key, 'GET', '/reports/receivables')).json()).data
    expect(body.totals).toMatchObject({ open: 1300, invoices: 2, overdueInvoices: 1 })
    const { getPastDueInvoicesReport } = await import('@/features/reports/Actions/reportActions')
    const screen = await getPastDueInvoicesReport()
    expect(body.totals.overdue).toBe(screen.data?.summary.totalAmountDue)
  })

  it('refuse a key without reports permission, and an unknown parameter', async () => {
    const { GET } = await route('reports/sales')
    const limited = await newKey(a.org, a.owner, [{ action: 'read', subject: 'customers' }])
    expect((await call(GET, limited, 'GET', '/reports/sales')).status).toBe(403)
    expect((await call(GET, a.key, 'GET', '/reports/sales?groupBy=month')).status).toBe(400)
  })
})

describe('tombstones and the archive', () => {
  it('list only the key’s workshop’s deletes, and only the kinds it may read', async () => {
    const { GET } = await route('deleted')
    const all = (await (await call(GET, a.key, 'GET', '/deleted')).json()).data
    expect(all.map((t: { entityId: string }) => t.entityId).sort()).toEqual(['gone-cus', 'gone-wo'])
    const servicesOnly = await newKey(a.org, a.owner, [{ action: 'read', subject: 'services' }])
    const some = (await (await call(GET, servicesOnly, 'GET', '/deleted')).json()).data
    expect(some.map((t: { entityId: string }) => t.entityId)).toEqual(['gone-wo'])
  })

  it('serve the Shopmonkey archive to its own workshop only, with read:settings', async () => {
    const { GET } = await route('source-records')
    const own = (await (await call(GET, a.key, 'GET', '/source-records?table=order')).json()).data
    expect(own).toEqual([expect.objectContaining({ remoteId: 'syn_1', payload: { id: 'syn_1' } })])
    const noSettings = await newKey(a.org, a.owner, [{ action: 'read', subject: 'customers' }])
    expect((await call(GET, noSettings, 'GET', '/source-records')).status).toBe(403)
  })
})

describe('a fork event', () => {
  it('goes out with the API’s resource as its data', async () => {
    const { POST } = await route('appointments')
    const res = await call(POST, a.key, 'POST', '/appointments', {
      body: { title: 'Event check', startAt: '2026-06-01T08:00:00.000Z', durationMinutes: 30 },
    })
    expect(res.status).toBe(201)
    const created = (await res.json()).data
    const events = await eventsOf(a.org, 'appointment.create')
    expect(events.deliveries).toBe(1)
    const sent = await db.webhookDelivery.findFirstOrThrow({
      where: { webhook: { organizationId: a.org }, event: 'appointment.create' },
      select: { payload: true },
    })
    expect(JSON.parse(sent.payload).data).toMatchObject({ id: created.id, title: 'Event check' })
  })
})
