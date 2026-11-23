/**
 * fork: work order and quote writes through the public API on a real PostgreSQL (`npm run test:db`;
 * docs/fork/milestones/A4-write-endpoints.md, Acceptance). Parity with the app's own actions (same rows, audit
 * event and webhook delivery) for creating a work order, adding a labor line with a technician, recording a
 * payment and converting a quote; an issued invoice refuses a line change with 409 `document_locked`; another
 * workshop's work order, job, line, technician or payment is a 404. Its own workshops, removed again.
 * SYNTHETIC data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  call,
  eventsOf,
  guardTestDatabase,
  newShop,
  removeCreated,
  route,
  type Shop,
} from './publicApiHarness'

const who = vi.hoisted(() => ({ userId: '', organizationId: '' }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}))
vi.mock('@/lib/cached-session', () => ({
  getCachedSession: async () => ({ user: { id: who.userId }, session: {} }),
  getCachedMembership: async () => ({
    organizationId: who.organizationId,
    role: 'owner',
    roleId: null,
    customRole: null,
  }),
}))

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let resetKeyBudgets: typeof import('@/features/public-api/Lib/rateLimit')['resetKeyBudgets']
let A: Shop
let B: Shop

async function seed(shop: Shop) {
  shop.ids.customer = (
    await db.customer.create({
      data: { organizationId: shop.org, userId: shop.owner, name: 'Owner' },
    })
  ).id
  shop.ids.vehicle = (
    await db.vehicle.create({
      data: {
        organizationId: shop.org,
        userId: shop.owner,
        customerId: shop.ids.customer,
        make: 'Make',
        model: 'Model',
        year: 2020,
      },
    })
  ).id
  shop.ids.technician = (
    await db.technician.create({ data: { organizationId: shop.org, name: 'Tech' } })
  ).id
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  ;({ resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit'))
  A = await newShop('OrdersAlpha')
  B = await newShop('OrdersBravo')
  await seed(A)
  await seed(B)
  B.ids.workOrder = (
    await db.serviceRecord.create({
      data: { organizationId: B.org, title: 'Theirs', vehicleId: B.ids.vehicle },
    })
  ).id
  who.userId = A.owner
  who.organizationId = A.org
})

afterAll(async () => {
  if (db) await removeCreated()
})

const workOrderInput = () => ({ vehicleId: A.ids.vehicle, title: 'Brake service', type: 'repair' })

async function apiWorkOrder(title = 'Brake service') {
  const { POST } = await route('work-orders')
  const response = await call(POST, A.key, 'POST', '/work-orders', {
    body: { ...workOrderInput(), title },
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { data: { id: string } }).data.id
}

describe('creating a work order', () => {
  it('makes the same work order, audit event and webhook delivery as the app’s own action', async () => {
    resetKeyBudgets()
    const id = await apiWorkOrder()
    const { createServiceRecord } = await import('@/features/vehicles/Actions/serviceActions')
    const viaApp = await createServiceRecord(workOrderInput())
    expect(viaApp.success).toBe(true)
    const appId = (viaApp.data as { id: string }).id
    const pick = async (rid: string) =>
      db.serviceRecord.findUniqueOrThrow({
        where: { id: rid },
        select: {
          title: true,
          type: true,
          status: true,
          vehicleId: true,
          organizationId: true,
          totalAmount: true,
          startDateTime: true,
        },
      })
    const [api, app] = await Promise.all([pick(id), pick(appId)])
    expect({ ...api, startDateTime: Boolean(api.startDateTime) }).toEqual({
      ...app,
      startDateTime: Boolean(app.startDateTime),
    })
    const events = await eventsOf(A.org, 'service.create')
    expect(events.audits.map((a) => a.entityId).sort()).toEqual([id, appId].sort())
    expect(events.deliveries).toBe(2)
  })
})

describe('a labor line with a technician', () => {
  it('lands as the app would write it, re-totals the job, and carries the technician', async () => {
    resetKeyBudgets()
    const id = await apiWorkOrder('Labor via API')
    const lines = await route('work-orders/[id]/lines')
    const before = await eventsOf(A.org, 'service.update')
    const response = await call(lines.POST, A.key, 'POST', '/lines', {
      params: { id },
      body: {
        kind: 'labor',
        description: 'Replace pads',
        hours: 1.5,
        rate: 100,
        technicianId: A.ids.technician,
      },
    })
    expect(response.status).toBe(201)
    const line = ((await response.json()) as { data: Record<string, unknown> }).data
    expect(line).toMatchObject({ kind: 'labor', technicianId: A.ids.technician, total: 150 })

    // The same line through the app's own work order save.
    const viaApp = await import('@/features/vehicles/Actions/serviceActions')
    const appRecord = await viaApp.createServiceRecord({
      ...workOrderInput(),
      title: 'Labor via app',
    })
    const appId = (appRecord.data as { id: string }).id
    // The form sends the totals it worked out alongside the lines; the API works them out itself.
    const saved = await viaApp.updateServiceRecord({
      id: appId,
      laborItems: [{ description: 'Replace pads', hours: 1.5, rate: 100, total: 150 }],
      subtotal: 150,
      taxAmount: 0,
      totalAmount: 150,
    })
    expect(saved.success).toBe(true)
    const totals = async (rid: string) =>
      db.serviceRecord.findUniqueOrThrow({
        where: { id: rid },
        select: { subtotal: true, taxAmount: true, totalAmount: true },
      })
    expect(await totals(id)).toEqual(await totals(appId))
    const labor = async (rid: string) =>
      db.serviceLabor.findFirstOrThrow({
        where: { serviceRecordId: rid },
        select: {
          description: true,
          hours: true,
          rate: true,
          total: true,
          taxable: true,
          pricingType: true,
        },
      })
    expect(await labor(id)).toEqual(await labor(appId))
    const after = await eventsOf(A.org, 'service.update')
    expect(after.audits.length - before.audits.length).toBe(2)
    expect(after.deliveries - before.deliveries).toBe(2)
  })

  it('refuses another workshop’s technician, job or line', async () => {
    resetKeyBudgets()
    const id = await apiWorkOrder('Refusals')
    const lines = await route('work-orders/[id]/lines')
    const theirs = await call(lines.POST, A.key, 'POST', '/lines', {
      params: { id },
      body: { kind: 'labor', description: 'X', hours: 1, rate: 1, technicianId: B.ids.technician },
    })
    expect(theirs.status).toBe(404)
    const theirJob = (
      await db.workJob.create({
        data: { organizationId: B.org, serviceRecordId: B.ids.workOrder, name: 'Theirs' },
      })
    ).id
    const withJob = await call(lines.POST, A.key, 'POST', '/lines', {
      params: { id },
      body: { kind: 'labor', description: 'X', hours: 1, rate: 1, jobId: theirJob },
    })
    expect(withJob.status).toBe(404)
    expect(await db.serviceLabor.count({ where: { serviceRecordId: id } })).toBe(0)
    const theirLine = (
      await db.serviceLabor.create({
        data: { serviceRecordId: B.ids.workOrder, description: 'T', hours: 1, rate: 1, total: 1 },
      })
    ).id
    const one = await route('work-orders/[id]/lines/[lineId]')
    // Their line under our work order's id, and under theirs: both not found.
    for (const wo of [id, B.ids.workOrder]) {
      expect(
        (
          await call(one.PATCH, A.key, 'PATCH', '/l', {
            params: { id: wo, lineId: theirLine },
            body: { hours: 9 },
          })
        ).status
      ).toBe(404)
    }
    expect((await db.serviceLabor.findUniqueOrThrow({ where: { id: theirLine } })).hours).toBe(1)
  })
})

describe('recording a payment', () => {
  it('records the same payment, issues the invoice, and logs the same event as the app', async () => {
    resetKeyBudgets()
    const id = await apiWorkOrder('Paid via API')
    const payments = await route('work-orders/[id]/payments')
    const response = await call(payments.POST, A.key, 'POST', '/payments', {
      params: { id },
      body: { amount: 50, method: 'card', note: 'Deposit' },
    })
    expect(response.status).toBe(201)
    const { createPayment } = await import('@/features/payments/Actions/paymentActions')
    const appId = (
      (
        await (
          await import('@/features/vehicles/Actions/serviceActions')
        ).createServiceRecord({
          ...workOrderInput(),
          title: 'Paid via app',
        })
      ).data as { id: string }
    ).id
    expect(
      (await createPayment({ serviceRecordId: appId, amount: 50, method: 'card', note: 'Deposit' }))
        .success
    ).toBe(true)
    const paid = async (rid: string) => ({
      payment: await db.payment.findFirstOrThrow({
        where: { serviceRecordId: rid },
        select: { amount: true, method: true, note: true },
      }),
      issued: Boolean(
        (
          await db.serviceRecord.findUniqueOrThrow({
            where: { id: rid },
            select: { issuedAt: true },
          })
        ).issuedAt
      ),
    })
    expect(await paid(id)).toEqual(await paid(appId))
    const events = await eventsOf(A.org, 'payment.create')
    expect(events.audits).toHaveLength(2)
    expect(events.deliveries).toBe(2)
  })

  it('isn’t recorded on another workshop’s work order', async () => {
    resetKeyBudgets()
    const payments = await route('work-orders/[id]/payments')
    const response = await call(payments.POST, A.key, 'POST', '/payments', {
      params: { id: B.ids.workOrder },
      body: { amount: 10 },
    })
    expect(response.status).toBe(404)
    expect(await db.payment.count({ where: { serviceRecordId: B.ids.workOrder } })).toBe(0)
  })
})

describe('converting a quote', () => {
  it('makes the same work order, and marks the quote, as the app’s own conversion', async () => {
    resetKeyBudgets()
    const quote = async (title: string) =>
      (
        await db.quote.create({
          data: {
            organizationId: A.org,
            userId: A.owner,
            title,
            vehicleId: A.ids.vehicle,
            partItems: { create: [{ name: 'Rotor', quantity: 2, unitPrice: 80, total: 160 }] },
          },
        })
      ).id
    const viaApi = await quote('Convert via API')
    const convert = await route('quotes/[id]/convert')
    const response = await call(convert.POST, A.key, 'POST', '/convert', {
      params: { id: viaApi },
      body: {},
    })
    expect(response.status).toBe(201)
    const apiWorkOrderId = ((await response.json()) as { data: { id: string } }).data.id
    const viaApp = await quote('Convert via app')
    const { convertQuoteToServiceRecord } = await import('@/features/quotes/Actions/quoteActions')
    const converted = await convertQuoteToServiceRecord(viaApp, A.ids.vehicle)
    expect(converted.success).toBe(true)
    const appWorkOrderId = (converted.data as { id: string }).id
    const parts = async (rid: string) =>
      db.servicePart.findMany({
        where: { serviceRecordId: rid },
        select: { name: true, quantity: true, unitPrice: true, total: true },
      })
    expect(await parts(apiWorkOrderId)).toEqual(await parts(appWorkOrderId))
    for (const [q, wo] of [
      [viaApi, apiWorkOrderId],
      [viaApp, appWorkOrderId],
    ]) {
      expect(
        await db.quote.findUniqueOrThrow({
          where: { id: q },
          select: { status: true, convertedToId: true },
        })
      ).toEqual({
        status: 'converted',
        convertedToId: wo,
      })
    }
    const events = await eventsOf(A.org, 'quote.convert')
    expect(events.audits).toHaveLength(2)
    expect(events.deliveries).toBe(2)
  })
})

describe('an issued invoice', () => {
  it('refuses a line change with 409 document_locked and the reason', async () => {
    resetKeyBudgets()
    await db.appSetting.createMany({
      data: [
        { organizationId: A.org, userId: A.owner, key: 'invoice.lockEnabled', value: 'true' },
        { organizationId: A.org, userId: A.owner, key: 'invoice.lockTrigger', value: 'sent' },
      ],
    })
    try {
      const id = await apiWorkOrder('Sent invoice')
      await db.serviceRecord.update({ where: { id }, data: { sentAt: new Date() } })
      const lines = await route('work-orders/[id]/lines')
      const response = await call(lines.POST, A.key, 'POST', '/lines', {
        params: { id },
        body: { kind: 'labor', description: 'Late addition', hours: 1, rate: 50 },
      })
      expect(response.status).toBe(409)
      const body = (await response.json()) as {
        error: { code: string; details: { reason: string } }
      }
      expect(body.error.code).toBe('document_locked')
      expect(body.error.details.reason).toBe('sent')
      expect(await db.serviceLabor.count({ where: { serviceRecordId: id } })).toBe(0)
    } finally {
      await db.appSetting.deleteMany({
        where: {
          organizationId: A.org,
          key: { in: ['invoice.lockEnabled', 'invoice.lockTrigger'] },
        },
      })
    }
  })
})

describe('another workshop’s work order', () => {
  it('can’t be changed, moved, deleted or given jobs: 404 for each', async () => {
    resetKeyBudgets()
    const id = B.ids.workOrder
    const before = await db.serviceRecord.findUniqueOrThrow({
      where: { id },
      select: { title: true, status: true, updatedAt: true },
    })
    const one = await route('work-orders/[id]')
    const status = await route('work-orders/[id]/status')
    const jobs = await route('work-orders/[id]/jobs')
    const lines = await route('work-orders/[id]/lines')
    const answers = [
      await call(one.PATCH, A.key, 'PATCH', '/w', { params: { id }, body: { title: 'Mine now' } }),
      await call(one.DELETE, A.key, 'DELETE', '/w', { params: { id } }),
      await call(status.POST, A.key, 'POST', '/s', {
        params: { id },
        body: { status: 'completed' },
      }),
      await call(jobs.POST, A.key, 'POST', '/j', { params: { id }, body: { name: 'Job' } }),
      await call(lines.POST, A.key, 'POST', '/l', {
        params: { id },
        body: { kind: 'labor', description: 'X', hours: 1, rate: 1 },
      }),
    ]
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404])
    expect(
      await db.serviceRecord.findUniqueOrThrow({
        where: { id },
        select: { title: true, status: true, updatedAt: true },
      })
    ).toEqual(before)
    expect(await db.workJob.count({ where: { serviceRecordId: id, name: 'Job' } })).toBe(0)
  })

  it('a stale If-Match on ours is a 412', async () => {
    resetKeyBudgets()
    const id = await apiWorkOrder('Concurrency')
    const one = await route('work-orders/[id]')
    const etag = (await call(one.GET, A.key, 'GET', '/w', { params: { id } })).headers.get(
      'ETag'
    ) as string
    await db.serviceRecord.update({
      where: { id },
      data: { description: 'Changed by someone else' },
    })
    const response = await call(one.PATCH, A.key, 'PATCH', '/w', {
      params: { id },
      body: { title: 'Mine' },
      headers: { 'if-match': etag },
    })
    expect(response.status).toBe(412)
    expect((await db.serviceRecord.findUniqueOrThrow({ where: { id } })).title).toBe('Concurrency')
  })
})
