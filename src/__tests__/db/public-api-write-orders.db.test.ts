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
// The app's sentences are read through next-intl, which needs a Next request; a stand-in says the key and values.
vi.mock('next-intl/server', async (original) => ({
  ...(await original<typeof import('next-intl/server')>()),
  getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
    `${key}: ${JSON.stringify(values ?? {})}`,
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

const audits = (action: string) => db.auditLog.count({ where: { organizationId: A.org, action } })
const tombstones = (entityType: string, entityId: string) =>
  db.deletedRecord.count({ where: { organizationId: A.org, entityType, entityId } })
const totalsOf = (id: string) =>
  db.serviceRecord.findUniqueOrThrow({
    where: { id },
    select: { subtotal: true, discountAmount: true, taxAmount: true, totalAmount: true },
  })

describe('a work order, from its making to its removal', () => {
  it('takes its totals from its lines, keeps them on a change of title, moves, and leaves a tombstone', async () => {
    resetKeyBudgets()
    const list = await route('work-orders')
    const one = await route('work-orders/[id]')
    const status = await route('work-orders/[id]/status')
    const create = (body: Record<string, unknown>) =>
      call(list.POST, A.key, 'POST', '/work-orders', { body: { ...workOrderInput(), ...body } })

    // Totals are worked out, never taken; a line's total that isn't its hours × rate is refused.
    expect((await create({ totalAmount: 99 })).status).toBe(400)
    expect(
      (await create({ laborItems: [{ description: 'X', hours: 2, rate: 50, total: 120 }] })).status
    ).toBe(400)

    const made = await create({
      title: 'With lines',
      laborItems: [{ description: 'Diagnose', hours: 1.5, rate: 100 }],
      partItems: [{ name: 'Filter', quantity: 2, unitPrice: 12.5 }],
    })
    expect(made.status).toBe(201)
    const id = ((await made.json()) as { data: { id: string } }).data.id
    expect(await totalsOf(id)).toEqual({
      subtotal: 175,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 175,
    })

    const before = await audits('service.update')
    const renamed = await call(one.PATCH, A.key, 'PATCH', '/w', {
      params: { id },
      body: { title: 'With lines (renamed)' },
    })
    expect(renamed.status).toBe(200)
    expect(await totalsOf(id)).toMatchObject({ totalAmount: 175 })
    const discounted = await call(one.PATCH, A.key, 'PATCH', '/w', {
      params: { id },
      body: { discountType: 'fixed', discountValue: 25 },
    })
    expect(discounted.status).toBe(200)
    expect(await totalsOf(id)).toEqual({
      subtotal: 175,
      discountAmount: 25,
      taxAmount: 0,
      totalAmount: 150,
    })
    expect(await audits('service.update')).toBe(before + 2)

    const statusEvents = await audits('service.status')
    const moved = await call(status.POST, A.key, 'POST', '/s', {
      params: { id },
      body: { status: 'in-progress' },
    })
    expect(moved.status).toBe(200)
    expect((await db.serviceRecord.findUniqueOrThrow({ where: { id } })).status).toBe('in-progress')
    expect(await audits('service.status')).toBe(statusEvents + 1)

    const deletes = await audits('service.delete')
    const gone = await call(one.DELETE, A.key, 'DELETE', '/w', { params: { id } })
    expect(gone.status).toBe(200)
    expect(await db.serviceRecord.count({ where: { id } })).toBe(0)
    expect(await tombstones('work_order', id)).toBe(1)
    expect(await audits('service.delete')).toBe(deletes + 1)
  })

  it('refuses to complete a job without the vehicle’s required meter readings, naming the meters', async () => {
    resetKeyBudgets()
    const meter = await db.meterType.create({
      data: { organizationId: A.org, name: 'Hour meter', unit: 'h', required: true },
    })
    await db.vehicleMeter.create({
      data: { organizationId: A.org, vehicleId: A.ids.vehicle, meterTypeId: meter.id },
    })
    try {
      const list = await route('work-orders')
      const refused = await call(list.POST, A.key, 'POST', '/work-orders', {
        body: { ...workOrderInput(), title: 'Done at once', status: 'completed' },
      })
      expect(refused.status).toBe(400)
      const body = (await refused.json()) as {
        error: { code: string; details: { meters: { name: string }[] } }
      }
      expect(body.error.code).toBe('invalid_request')
      expect(body.error.details.meters.map((m) => m.name)).toEqual(['Hour meter'])
      expect(await db.serviceRecord.count({ where: { title: 'Done at once' } })).toBe(0)
    } finally {
      await db.meterType.delete({ where: { id: meter.id } })
    }
  })
})

describe('lines, one at a time', () => {
  it('moves the stock and the totals as the app does, and refuses a field the line’s kind doesn’t have', async () => {
    resetKeyBudgets()
    const id = await apiWorkOrder('Lines one at a time')
    const lines = await route('work-orders/[id]/lines')
    const line = await route('work-orders/[id]/lines/[lineId]')
    const part = await db.inventoryPart.create({
      data: { organizationId: A.org, userId: A.owner, name: 'Pad set', quantity: 10, unitCost: 20 },
    })
    const stock = async () =>
      (await db.inventoryPart.findUniqueOrThrow({ where: { id: part.id } })).quantity
    const add = async (body: Record<string, unknown>) => {
      const response = await call(lines.POST, A.key, 'POST', '/l', { params: { id }, body })
      expect(response.status).toBe(201)
      return ((await response.json()) as { data: { id: string } & Record<string, unknown> }).data
    }
    const change = (lineId: string, body: Record<string, unknown>) =>
      call(line.PATCH, A.key, 'PATCH', '/l', { params: { id, lineId }, body })

    const pads = await add({
      kind: 'part',
      description: 'Pad set',
      quantity: 2,
      unitPrice: 45,
      inventoryPartId: part.id,
    })
    expect(pads).toMatchObject({ kind: 'part', inventoryPartId: part.id, total: 90 })
    expect(await stock()).toBe(8)
    expect(
      await db.stockMovement.findMany({
        where: { inventoryPartId: part.id },
        select: { delta: true, reason: true, serviceRecordId: true },
      })
    ).toEqual([{ delta: -2, reason: 'service_record', serviceRecordId: id }])
    expect((await totalsOf(id)).subtotal).toBe(90)

    expect((await change(pads.id, { quantity: 3 })).status).toBe(200)
    expect(await stock()).toBe(7)
    expect((await totalsOf(id)).subtotal).toBe(135)
    expect((await change(pads.id, { hours: 2 })).status).toBe(400)

    const labor = await add({ kind: 'labor', description: 'Fit pads', hours: 1, rate: 80 })
    expect((await change(labor.id, { hours: 2 })).status).toBe(200)
    expect(
      await db.serviceLabor.findUniqueOrThrow({
        where: { id: labor.id },
        select: { hours: true, total: true },
      })
    ).toEqual({ hours: 2, total: 160 })
    expect((await change(labor.id, { quantity: 2 })).status).toBe(400)

    // A fee is the amount sent, not the workshop's shop fee priced again.
    const fee = await add({ kind: 'epa', description: 'Disposal', hours: 1, rate: 5 })
    expect(fee).toMatchObject({ kind: 'epa', pricingType: 'service', total: 5 })
    expect((await totalsOf(id)).subtotal).toBe(135 + 160 + 5)

    const removed = await call(line.DELETE, A.key, 'DELETE', '/l', {
      params: { id, lineId: pads.id },
    })
    expect(removed.status).toBe(200)
    expect(await stock()).toBe(10)
    expect(await tombstones('work_order_line', pads.id)).toBe(1)
    expect((await totalsOf(id)).subtotal).toBe(165)
  })
})

describe('jobs, quotes and payments', () => {
  it('groups lines under jobs: made, renamed and removed, each with its event and a tombstone', async () => {
    resetKeyBudgets()
    const id = await apiWorkOrder('Jobs')
    const jobs = await route('work-orders/[id]/jobs')
    const job = await route('work-orders/[id]/jobs/[jobId]')
    const counts = async () =>
      Promise.all(['job.create', 'job.update', 'job.delete'].map((action) => audits(action)))
    const before = await counts()
    const made = await call(jobs.POST, A.key, 'POST', '/j', {
      params: { id },
      body: { name: 'Brakes' },
    })
    expect(made.status).toBe(201)
    const jobId = ((await made.json()) as { data: { id: string } }).data.id
    const renamed = await call(job.PATCH, A.key, 'PATCH', '/j', {
      params: { id, jobId },
      body: { name: 'Front brakes' },
    })
    expect(((await renamed.json()) as { data: { name: string } }).data.name).toBe('Front brakes')
    expect((await call(job.DELETE, A.key, 'DELETE', '/j', { params: { id, jobId } })).status).toBe(
      200
    )
    expect(await db.workJob.count({ where: { id: jobId } })).toBe(0)
    expect(await tombstones('work_job', jobId)).toBe(1)
    expect(await counts()).toEqual(before.map((n) => n + 1))
  })

  it('makes a quote whose totals are its offered lines, changes it, and deletes it', async () => {
    resetKeyBudgets()
    const list = await route('quotes')
    const one = await route('quotes/[id]')
    const made = await call(list.POST, A.key, 'POST', '/quotes', {
      body: {
        title: 'Brake quote',
        vehicleId: A.ids.vehicle,
        partItems: [{ name: 'Rotor', quantity: 2, unitPrice: 80 }],
        laborItems: [{ description: 'Fit rotors', hours: 1, rate: 100, excluded: true }],
      },
    })
    expect(made.status).toBe(201)
    const id = ((await made.json()) as { data: { id: string } }).data.id
    expect(
      await db.quote.findUniqueOrThrow({
        where: { id },
        select: { subtotal: true, totalAmount: true },
      })
    ).toEqual({ subtotal: 160, totalAmount: 160 })
    const before = await Promise.all(['quote.update', 'quote.delete'].map((a) => audits(a)))
    expect(
      (await call(one.PATCH, A.key, 'PATCH', '/q', { params: { id }, body: { title: 'Rotors' } }))
        .status
    ).toBe(200)
    expect((await db.quote.findUniqueOrThrow({ where: { id } })).title).toBe('Rotors')
    expect((await call(one.DELETE, A.key, 'DELETE', '/q', { params: { id } })).status).toBe(200)
    expect(await db.quote.count({ where: { id } })).toBe(0)
    expect(await Promise.all(['quote.update', 'quote.delete'].map((a) => audits(a)))).toEqual(
      before.map((n) => n + 1)
    )
  })

  it('removes a payment, with its event', async () => {
    resetKeyBudgets()
    const id = await apiWorkOrder('Payment removed')
    const payments = await route('work-orders/[id]/payments')
    const payment = await route('work-orders/[id]/payments/[paymentId]')
    const made = await call(payments.POST, A.key, 'POST', '/p', {
      params: { id },
      body: { amount: 20, method: 'cash' },
    })
    const paymentId = ((await made.json()) as { data: { id: string } }).data.id
    const before = await audits('payment.delete')
    const gone = await call(payment.DELETE, A.key, 'DELETE', '/p', { params: { id, paymentId } })
    expect(gone.status).toBe(200)
    expect(await db.payment.count({ where: { id: paymentId } })).toBe(0)
    expect(await audits('payment.delete')).toBe(before + 1)
  })
})

describe('a part deleted from the inventory', () => {
  it('leaves the work orders, quotes and presets that used it saveable in the app, and another workshop’s part refused', async () => {
    const part = await db.inventoryPart.create({
      data: { organizationId: A.org, userId: A.owner, name: 'Old part', quantity: 5 },
    })
    const line = {
      name: 'Old part',
      quantity: 1,
      unitPrice: 10,
      total: 10,
      inventoryPartId: part.id,
    }
    const presetPart = { name: 'Old part', quantity: 1, unitPrice: 10, inventoryPartId: part.id }
    const presetItem = { description: 'Fit', hours: 1, rate: 50 }

    // A work order, a quote and a preset that used it, made in the app.
    const services = await import('@/features/vehicles/Actions/serviceActions')
    const quotes = await import('@/features/quotes/Actions/quoteActions')
    const presets = await import('@/features/labor-presets/Actions/laborPresetActions')
    const inventory = await import('@/features/inventory/Actions/inventoryActions')
    const workOrder = await services.createServiceRecord({
      ...workOrderInput(),
      title: 'Used the part',
      partItems: [line],
      subtotal: 10,
      totalAmount: 10,
    })
    const quote = await quotes.createQuote({
      title: 'Quoted the part',
      vehicleId: A.ids.vehicle,
      partItems: [line],
      subtotal: 10,
      totalAmount: 10,
    })
    const preset = await presets.createLaborPreset({
      name: 'Uses the part',
      items: [presetItem],
      parts: [presetPart],
    })
    expect([workOrder.success, quote.success, preset.success]).toEqual([true, true, true])
    const idOf = (result: { data?: unknown }) => (result.data as { id: string }).id

    // The part goes; the lines keep its id, and each page sends it back as it was.
    expect((await inventory.deleteInventoryPart(part.id)).success).toBe(true)
    const saved = await Promise.all([
      services.updateServiceRecord({ id: idOf(workOrder), title: 'Renamed', partItems: [line] }),
      quotes.updateQuote({ id: idOf(quote), title: 'Renamed', partItems: [line] }),
      presets.updateLaborPreset({
        id: idOf(preset),
        name: 'Renamed',
        items: [presetItem],
        parts: [presetPart],
      }),
    ])
    expect(saved.map((r) => [r.success, r.error ?? null])).toEqual([
      [true, null],
      [true, null],
      [true, null],
    ])

    // Another workshop's part is still not this workshop's to link.
    const theirs = await db.inventoryPart.create({
      data: { organizationId: B.org, userId: B.owner, name: 'Theirs', quantity: 1 },
    })
    const refused = await services.updateServiceRecord({
      id: idOf(workOrder),
      partItems: [{ ...line, inventoryPartId: theirs.id }],
    })
    expect(refused).toMatchObject({ success: false, error: 'Inventory part not found' })
  })
})
