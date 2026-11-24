/**
 * fork (A5, docs/fork/milestones/A5-events-reports.md) on a real PostgreSQL (`npm run test:db`): the reports match the
 * app's own reports for the same period, in a time zone far from UTC; `/source-records` and `/deleted` are scoped by
 * the key's workshop and refuse a key without the permission; a fork event goes out with the API's resource as `data`;
 * `include=source` hands an imported row its archived record (with `read:settings`); a restore or a bulk delete
 * leaves a marker every key sees, and a restore sends `restore.complete`.
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
// The app's own actions (the reports screen, the booking dialog) through the real `withAuth`, audit and all, signed
// in as the workshop's owner.
vi.mock('@/lib/cached-session', () => ({
  getCachedSession: async () => ({ user: { id: ctx.userId, name: 'Owner', email: null } }),
  getCachedMembership: async () => ({
    organizationId: ctx.organizationId,
    role: 'owner',
    customRole: null,
  }),
  getCachedSessionScope: async () => null,
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }))

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
  const technician = await db.technician.create({
    data: { organizationId: a.org, name: 'Report Technician' },
    select: { id: true },
  })
  a.ids.technician = technician.id
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
    // The May job: the technician's, two hours sold, an hour and a half clocked on it.
    if (j.start.startsWith('2026-05-10')) {
      await db.serviceRecord.update({
        where: { id: record.id },
        data: { technicianId: technician.id },
      })
      await db.serviceLabor.create({
        data: { serviceRecordId: record.id, description: 'Brakes', hours: 2, rate: 0, total: 0 },
      })
      await db.timeEntry.create({
        data: {
          organizationId: a.org,
          technicianId: technician.id,
          serviceRecordId: record.id,
          startedAt: new Date('2026-05-10T09:00:00.000Z'),
          endedAt: new Date('2026-05-10T10:30:00.000Z'),
          durationMinutes: 90,
        },
      })
    }
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
      { organizationId: a.org, connectionId: 'conn-a', table: 'customer', remoteId: 'syn_cus_9', payload: { id: 'syn_cus_9', note: 'from Shopmonkey' }, payloadHash: 'h3' },
    ],
  })
  // An imported customer: linked through a Shopmonkey connection of workshop A.
  const connection = await db.integrationConnection.create({
    data: { organizationId: a.org, connectorId: 'shopmonkey', status: 'active', createdById: a.owner },
    select: { id: true },
  })
  a.ids.imported = (
    await db.customer.create({
      data: { organizationId: a.org, userId: a.owner, name: 'Imported Customer' },
      select: { id: true },
    })
  ).id
  a.ids.customer = customer.id
  await db.integrationLink.create({
    data: {
      connectionId: connection.id,
      entityType: 'Customer',
      entityId: a.ids.imported,
      remoteId: 'customer:syn_cus_9',
    },
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

  it('give each technician the hours sold and clocked the reports screen gives them', async () => {
    const { GET } = await route('reports/technicians')
    const body = (
      await (await call(GET, a.key, 'GET', '/reports/technicians?from=2026-05-01&to=2026-05-31')).json()
    ).data
    const row = body.technicians.find((t: { technicianId: string }) => t.technicianId === a.ids.technician)
    expect(row.total).toMatchObject({ soldHours: 2, clockedMinutes: 90, jobsCompleted: 1 })
    expect(row.periods.map((p: { period: string }) => p.period)).toEqual(['2026-05'])
    ctx.organizationId = a.org
    ctx.userId = a.owner
    const { getTechnicianTimeReport } = await import('@/features/reports/Actions/reportActions')
    const screen = await getTechnicianTimeReport({ startDate: '2026-05-01', endDate: '2026-05-31' })
    const own = screen.data?.technicians.find((t) => t.technicianId === a.ids.technician)
    expect({ soldHours: own?.billedHours, clockedMinutes: own?.clockedMinutes }).toEqual({
      soldHours: row.total.soldHours,
      clockedMinutes: row.total.clockedMinutes,
    })
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
  it('goes out once from the app’s own booking dialog, with the API’s resource as its data', async () => {
    ctx.organizationId = b.org
    ctx.userId = b.owner
    const { createBookingOnce } = await import('@/features/calendar/Actions/createBooking')
    const booked = await createBookingOnce({
      kind: 'appointment',
      token: 'a5-ui-event-token-0001',
      title: 'Booked in the app',
      startDate: '2026-06-02',
      startTime: '09:00',
      endDate: '2026-06-02',
      endTime: '09:30',
      notifications: [],
    })
    expect(booked.success).toBe(true)
    const events = await eventsOf(b.org, 'appointment.create')
    expect(events.deliveries).toBe(1)
    const sent = await db.webhookDelivery.findFirstOrThrow({
      where: { webhook: { organizationId: b.org }, event: 'appointment.create' },
      select: { payload: true },
    })
    const { GET } = await route('appointments')
    const listed = (await (await call(GET, b.key, 'GET', '/appointments')).json()).data
    const asApi = listed.find((x: { title: string }) => x.title === 'Booked in the app')
    expect(JSON.parse(sent.payload).data).toEqual(asApi)
  })

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

describe('include=source', () => {
  it('hands an imported row the record it came from, and a row made here null', async () => {
    const { GET } = await route('customers/[id]')
    const imported = await call(GET, a.key, 'GET', `/customers/${a.ids.imported}?include=source`, {
      params: { id: a.ids.imported },
    })
    expect(imported.status).toBe(200)
    expect((await imported.json()).data.source).toMatchObject({
      source: 'shopmonkey',
      table: 'customer',
      remoteId: 'syn_cus_9',
      payload: { id: 'syn_cus_9', note: 'from Shopmonkey' },
    })
    const own = await call(GET, a.key, 'GET', `/customers/${a.ids.customer}?include=source`, {
      params: { id: a.ids.customer },
    })
    expect((await own.json()).data.source).toBeNull()
    // Without the include, no source at all.
    const plain = await call(GET, a.key, 'GET', `/customers/${a.ids.imported}`, {
      params: { id: a.ids.imported },
    })
    expect((await plain.json()).data).not.toHaveProperty('source')
  })

  it('lists them on a page, and needs read:settings', async () => {
    const list = await route('customers')
    const page = (await (await call(list.GET, a.key, 'GET', '/customers?include=source')).json()).data
    const byId = Object.fromEntries(page.map((c: { id: string; source: unknown }) => [c.id, c.source]))
    expect(byId[a.ids.imported]).toMatchObject({ remoteId: 'syn_cus_9' })
    expect(byId[a.ids.customer]).toBeNull()
    const customersOnly = await newKey(a.org, a.owner, [{ action: 'read', subject: 'customers' }])
    expect((await call(list.GET, customersOnly, 'GET', '/customers?include=source')).status).toBe(403)
    expect((await call(list.GET, customersOnly, 'GET', '/customers')).status).toBe(200)
  })

  it('never reads another workshop’s archive', async () => {
    const { GET } = await route('customers/[id]')
    // B's key can't see A's customer at all; and B's own rows have no link to A's archive.
    expect(
      (await call(GET, b.key, 'GET', `/customers/${a.ids.imported}?include=source`, { params: { id: a.ids.imported } }))
        .status
    ).toBe(404)
  })
})

describe('restores and bulk deletes', () => {
  it('leave a marker every key sees at /deleted, and a restore sends restore.complete', async () => {
    const { recordReset, announceRestore } = await import('@/features/public-api/Lib/resets.server')
    const since = new Date().toISOString()
    await recordReset(a.org, 'delete_content', a.owner)
    await recordReset(a.org, 'restore', a.owner)
    await announceRestore(a.org, a.owner)
    const { GET } = await route('deleted')
    // A key that may read only work orders still learns it must resync.
    const servicesOnly = await newKey(a.org, a.owner, [{ action: 'read', subject: 'services' }])
    const seen = (
      await (await call(GET, servicesOnly, 'GET', `/deleted?since=${encodeURIComponent(since)}`)).json()
    ).data
    expect(seen.map((t: { entityType: string; entityId: string }) => `${t.entityType}:${t.entityId}`)).toEqual([
      'reset:delete_content',
      'restore:restore',
    ])
    // Not B's.
    const other = (await (await call(GET, b.key, 'GET', `/deleted?since=${encodeURIComponent(since)}`)).json()).data
    expect(other).toEqual([])
    expect((await eventsOf(a.org, 'restore.complete')).deliveries).toBe(1)
    const sent = await db.webhookDelivery.findFirstOrThrow({
      where: { webhook: { organizationId: a.org }, event: 'restore.complete' },
      select: { payload: true },
    })
    expect(JSON.parse(sent.payload).data).toEqual({ restoredAt: expect.any(String) })
  })
})
