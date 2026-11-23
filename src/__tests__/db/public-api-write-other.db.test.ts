/**
 * fork: the public API's other writes on a real PostgreSQL (`npm run test:db`; docs/fork/milestones/A4-write-endpoints.md):
 * technicians, appointments, time entries (and the clock), shifts, inventory (and stock adjustments), labor presets,
 * findings, webhooks and work order attachments, through the real route handlers, keys and services.
 *
 * Each write leaves the rows and the audit event the app's own action leaves; a change keeps what it doesn't send;
 * the workshop's clock (Pacific/Auckland here, far from UTC) is the one times are typed on; and another workshop's
 * ids are not found. Its own workshops and upload folder, removed again. SYNTHETIC data.
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  call,
  eventsOf,
  guardTestDatabase,
  type Handler,
  newShop,
  removeCreated,
  route,
  type Shop,
} from './publicApiHarness'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}))
// A webhook's URL is checked by resolving its host; this one is made up, and no request leaves the test.
vi.mock('@/features/webhooks/Lib/ssrf', async (original) => ({
  ...(await original<typeof import('@/features/webhooks/Lib/ssrf')>()),
  checkWebhookUrl: async () => ({ ok: true }),
}))
/** A plan's photo limit for a workshop, where a test sets one; the plan's own elsewhere. */
const photoLimit = vi.hoisted(() => new Map<string, number>())
vi.mock('@/lib/features', async (original) => {
  const real = await original<typeof import('@/lib/features')>()
  return {
    ...real,
    getFeatures: async (organizationId: string) => {
      const features = await real.getFeatures(organizationId)
      const limit = photoLimit.get(organizationId)
      return limit === undefined ? features : { ...features, maxImagesPerService: limit }
    },
  }
})

const url = guardTestDatabase()
const previousDataRoot = process.env.DATA_ROOT
let dataRoot = ''
let db: typeof import('@/lib/db')['db']
let resetKeyBudgets: typeof import('@/features/public-api/Lib/rateLimit')['resetKeyBudgets']
let A: Shop
let B: Shop

type Json = { data: Record<string, unknown> & { id: string } }
const json = async (response: Response) => (await response.json()) as Json

async function seed(shop: Shop) {
  const { org, owner } = shop
  shop.ids.customer = (
    await db.customer.create({ data: { organizationId: org, userId: owner, name: 'Owner' } })
  ).id
  shop.ids.vehicle = (
    await db.vehicle.create({
      data: {
        organizationId: org,
        userId: owner,
        customerId: shop.ids.customer,
        make: 'Make',
        model: 'Model',
        year: 2020,
      },
    })
  ).id
  shop.ids.technician = (
    await db.technician.create({ data: { organizationId: org, name: 'Tech' } })
  ).id
  shop.ids.workOrder = (
    await db.serviceRecord.create({
      data: {
        organizationId: org,
        title: 'Job one',
        vehicleId: shop.ids.vehicle,
        status: 'pending',
      },
    })
  ).id
  shop.ids.workOrder2 = (
    await db.serviceRecord.create({
      data: {
        organizationId: org,
        title: 'Job two',
        vehicleId: shop.ids.vehicle,
        status: 'pending',
      },
    })
  ).id
  shop.ids.part = (
    await db.inventoryPart.create({
      data: { organizationId: org, userId: owner, name: 'Filter', quantity: 4 },
    })
  ).id
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  dataRoot = await mkdtemp(path.join(tmpdir(), 'api-write-'))
  process.env.DATA_ROOT = dataRoot
  ;({ db } = await import('@/lib/db'))
  ;({ resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit'))
  A = await newShop('OtherAlpha')
  B = await newShop('OtherBravo')
  await seed(A)
  await seed(B)
  await db.appSetting.create({
    data: {
      organizationId: A.org,
      userId: A.owner,
      key: 'workshop.timezone',
      value: 'Pacific/Auckland',
    },
  })
})

afterAll(async () => {
  if (db) await removeCreated()
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT
  else process.env.DATA_ROOT = previousDataRoot
})

const auditCount = async (org: string, action: string) =>
  db.auditLog.count({ where: { organizationId: org, action } })

describe('technicians', () => {
  it('are made, changed one field at a time, and deactivated, each with its audit event', async () => {
    resetKeyBudgets()
    const list = await route('technicians')
    const one = await route('technicians/[id]')
    const made = await call(list.POST, A.key, 'POST', '/technicians', {
      body: { name: 'Ana', color: '#ff0000' },
    })
    expect(made.status).toBe(201)
    const tech = (await json(made)).data
    expect(tech).toMatchObject({ name: 'Ana', color: '#ff0000', isActive: true })

    const changed = await call(one.PATCH, A.key, 'PATCH', '/t', {
      params: { id: tech.id },
      body: { dailyCapacity: 240 },
    })
    expect(changed.status).toBe(200)
    expect((await json(changed)).data).toMatchObject({
      name: 'Ana',
      color: '#ff0000',
      dailyCapacity: 240,
    })

    // Another workshop's login can't be linked; nothing changes.
    const theirs = await call(one.PATCH, A.key, 'PATCH', '/t', {
      params: { id: tech.id },
      body: { userId: B.owner },
    })
    expect(theirs.status).toBe(404)
    expect((await db.technician.findUniqueOrThrow({ where: { id: tech.id } })).userId).toBeNull()

    const gone = await call(one.DELETE, A.key, 'DELETE', '/t', { params: { id: tech.id } })
    expect(gone.status).toBe(200)
    expect(await gone.json()).toEqual({ data: { id: tech.id, deleted: true } })
    expect((await db.technician.findUniqueOrThrow({ where: { id: tech.id } })).isActive).toBe(false)

    await eventsOf(A.org, 'technician.create')
    expect(await auditCount(A.org, 'technician.create')).toBe(1)
    expect(await auditCount(A.org, 'technician.update')).toBe(1)
    expect(await auditCount(A.org, 'technician.delete')).toBe(1)
  })
})

describe('appointments', () => {
  it('are booked on the workshop’s clock, keep what a change doesn’t send, and leave a tombstone', async () => {
    resetKeyBudgets()
    const list = await route('appointments')
    const one = await route('appointments/[id]')
    const made = await call(list.POST, A.key, 'POST', '/appointments', {
      body: {
        title: 'Drop-off',
        vehicleId: A.ids.vehicle,
        startDate: '2026-12-01',
        startTime: '09:30',
        endDate: '2026-12-01',
        endTime: '10:00',
        notifications: [{ channel: 'in_app', amount: 1, unit: 'hours' }],
      },
    })
    expect(made.status).toBe(201)
    const appointment = (await json(made)).data
    // 09:30 on 1 December in Auckland (UTC+13 in summer) is 20:30 UTC the day before.
    expect(new Date(appointment.startAt as string).toISOString()).toBe('2026-11-30T20:30:00.000Z')
    expect(appointment).toMatchObject({ vehicleId: A.ids.vehicle, customerId: A.ids.customer })

    const changed = await call(one.PATCH, A.key, 'PATCH', '/a', {
      params: { id: appointment.id },
      body: { title: 'Drop-off, early' },
    })
    expect(changed.status).toBe(200)
    expect((await json(changed)).data).toMatchObject({
      title: 'Drop-off, early',
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      vehicleId: A.ids.vehicle,
    })
    expect(
      await db.appointmentNotification.count({ where: { appointmentId: appointment.id } })
    ).toBe(1)

    const theirs = await call(one.PATCH, A.key, 'PATCH', '/a', {
      params: { id: appointment.id },
      body: { vehicleId: null, customerId: B.ids.customer },
    })
    expect(theirs.status).toBe(404)

    const unknown = await call(list.POST, A.key, 'POST', '/appointments', {
      body: {
        title: 'X',
        startDate: '2026-12-01',
        startTime: '09:30',
        endDate: '2026-12-01',
        endTime: '10:00',
        kind: 'workOrder',
      },
    })
    expect(unknown.status).toBe(400)

    const gone = await call(one.DELETE, A.key, 'DELETE', '/a', { params: { id: appointment.id } })
    expect(gone.status).toBe(200)
    expect(
      await db.deletedRecord.count({
        where: { entityType: 'appointment', entityId: appointment.id },
      })
    ).toBe(1)
    expect(await auditCount(A.org, 'appointment.create')).toBe(1)
    expect(await auditCount(A.org, 'appointment.update')).toBe(1)
    expect(await auditCount(A.org, 'appointment.delete')).toBe(1)
  })
})

describe('time entries and the clock', () => {
  it('records a stretch typed on the workshop’s clock, and a change of the note keeps the clocked times', async () => {
    resetKeyBudgets()
    const list = await route('time-entries')
    const one = await route('time-entries/[id]')
    const made = await call(list.POST, A.key, 'POST', '/time-entries', {
      body: {
        technicianId: A.ids.technician,
        workOrderId: A.ids.workOrder,
        startedAt: '2026-11-20T08:00',
        endedAt: '2026-11-20T09:15',
        note: 'Diagnosis',
      },
    })
    expect(made.status).toBe(201)
    const entry = (await json(made)).data
    expect(entry).toMatchObject({
      workOrderId: A.ids.workOrder,
      durationMinutes: 75,
      note: 'Diagnosis',
    })
    expect(new Date(entry.startedAt as string).toISOString()).toBe('2026-11-19T19:00:00.000Z')

    // Clocked to the second by the app; a note added later leaves that alone.
    const clocked = await db.timeEntry.create({
      data: {
        organizationId: A.org,
        technicianId: A.ids.technician,
        serviceRecordId: A.ids.workOrder,
        startedAt: new Date('2026-11-20T01:02:03.456Z'),
        endedAt: new Date('2026-11-20T02:04:05.678Z'),
        durationMinutes: 62,
        source: 'app',
      },
    })
    const noted = await call(one.PATCH, A.key, 'PATCH', '/e', {
      params: { id: clocked.id },
      body: { note: 'Checked' },
    })
    expect(noted.status).toBe(200)
    const after = await db.timeEntry.findUniqueOrThrow({ where: { id: clocked.id } })
    expect(after.startedAt.toISOString()).toBe('2026-11-20T01:02:03.456Z')
    expect(after.endedAt?.toISOString()).toBe('2026-11-20T02:04:05.678Z')
    expect(after.note).toBe('Checked')

    // Another workshop's technician or job is not found.
    for (const body of [
      { technicianId: B.ids.technician, workOrderId: A.ids.workOrder },
      { technicianId: A.ids.technician, workOrderId: B.ids.workOrder },
    ]) {
      const theirs = await call(list.POST, A.key, 'POST', '/time-entries', {
        body: { ...body, startedAt: '2026-11-20T08:00', endedAt: '2026-11-20T09:00' },
      })
      expect(theirs.status).toBe(404)
    }
    expect(await auditCount(A.org, 'timeEntry.create')).toBe(1)
    expect(await auditCount(A.org, 'timeEntry.update')).toBe(1)
  })

  it('runs one clock a technician, as the technician app does', async () => {
    resetKeyBudgets()
    const start = await route('time-entries/start')
    const stop = await route('time-entries/[id]/stop')
    const begin = (workOrderId: string, technicianId = A.ids.technician) =>
      call(start.POST, A.key, 'POST', '/time-entries/start', {
        body: { technicianId, workOrderId },
      })

    const first = await begin(A.ids.workOrder)
    expect(first.status).toBe(201)
    const running = (await json(first)).data
    expect(running).toMatchObject({ workOrderId: A.ids.workOrder, endedAt: null, source: 'api' })
    expect(
      (await db.serviceRecord.findUniqueOrThrow({ where: { id: A.ids.workOrder } })).status
    ).toBe('in-progress')

    // The same job again changes nothing.
    const again = await begin(A.ids.workOrder)
    expect(again.status).toBe(200)
    expect((await json(again)).data.id).toBe(running.id)

    // Another job stops the first.
    const second = await begin(A.ids.workOrder2)
    expect(second.status).toBe(201)
    const moved = (await json(second)).data
    expect(
      (await db.timeEntry.findUniqueOrThrow({ where: { id: running.id } })).endedAt
    ).not.toBeNull()

    const stopped = await call(stop.POST, A.key, 'POST', '/stop', { params: { id: moved.id } })
    expect(stopped.status).toBe(200)
    expect((await json(stopped)).data.endedAt).not.toBeNull()
    const twice = await call(stop.POST, A.key, 'POST', '/stop', { params: { id: moved.id } })
    expect(twice.status).toBe(400)

    expect((await begin(A.ids.workOrder, B.ids.technician)).status).toBe(404)
    expect((await begin(B.ids.workOrder)).status).toBe(404)
    const theirEntry = await db.timeEntry.create({
      data: {
        organizationId: B.org,
        technicianId: B.ids.technician,
        serviceRecordId: B.ids.workOrder,
        startedAt: new Date(),
        source: 'app',
      },
    })
    expect(
      (await call(stop.POST, A.key, 'POST', '/stop', { params: { id: theirEntry.id } })).status
    ).toBe(404)
    expect(
      (await db.timeEntry.findUniqueOrThrow({ where: { id: theirEntry.id } })).endedAt
    ).toBeNull()

    expect(await auditCount(A.org, 'time_entry.start')).toBe(2)
  })
})

describe('shifts', () => {
  it('are clocked in and out, changed one field at a time, and removed with a tombstone', async () => {
    resetKeyBudgets()
    const list = await route('shifts')
    const one = await route('shifts/[id]')
    const made = await call(list.POST, A.key, 'POST', '/shifts', {
      body: {
        technicianId: A.ids.technician,
        clockIn: '2026-11-20T07:00:00Z',
        clockOut: '2026-11-20T15:30:00Z',
      },
    })
    expect(made.status).toBe(201)
    const shift = (await json(made)).data
    expect(shift).toMatchObject({ durationMinutes: 510, source: 'api' })
    const noted = await call(one.PATCH, A.key, 'PATCH', '/s', {
      params: { id: shift.id },
      body: { note: 'Covered Saturday' },
    })
    expect((await json(noted)).data).toMatchObject({
      durationMinutes: 510,
      note: 'Covered Saturday',
    })
    const theirs = await call(list.POST, A.key, 'POST', '/shifts', {
      body: { technicianId: B.ids.technician, clockIn: '2026-11-20T07:00:00Z' },
    })
    expect(theirs.status).toBe(404)
    expect(
      (await call(one.DELETE, A.key, 'DELETE', '/s', { params: { id: shift.id } })).status
    ).toBe(200)
    expect(
      await db.deletedRecord.count({
        where: { entityType: 'technician_shift', entityId: shift.id },
      })
    ).toBe(1)
  })
})

describe('inventory', () => {
  it('keeps the count a change doesn’t send, and an adjustment is a line in the stock history', async () => {
    resetKeyBudgets()
    const list = await route('inventory-parts')
    const one = await route('inventory-parts/[id]')
    const adjust = await route('inventory-parts/[id]/adjust')
    const made = await call(list.POST, A.key, 'POST', '/inventory-parts', {
      body: { name: 'Brake pads', partNumber: 'BP-1', quantity: 10, unitCost: 40, sellPrice: 80 },
    })
    expect(made.status).toBe(201)
    const part = (await json(made)).data
    expect(part).toMatchObject({ quantity: 10, sellPrice: 80 })

    const renamed = await call(one.PATCH, A.key, 'PATCH', '/p', {
      params: { id: part.id },
      body: { name: 'Brake pads (front)' },
    })
    expect(renamed.status).toBe(200)
    expect((await json(renamed)).data).toMatchObject({
      name: 'Brake pads (front)',
      quantity: 10,
      sellPrice: 80,
      unitCost: 40,
    })

    const counted = await call(adjust.POST, A.key, 'POST', '/adjust', {
      params: { id: part.id },
      body: { delta: -3, note: 'Counted' },
    })
    expect(counted.status).toBe(200)
    expect((await json(counted)).data.quantity).toBe(7)
    expect(
      await db.stockMovement.findMany({
        where: { inventoryPartId: part.id },
        select: { delta: true, quantityAfter: true, reason: true, note: true },
      })
    ).toEqual([{ delta: -3, quantityAfter: 7, reason: 'manual_adjustment', note: 'Counted' }])

    const nothing = await call(adjust.POST, A.key, 'POST', '/adjust', {
      params: { id: part.id },
      body: { delta: 0 },
    })
    expect(nothing.status).toBe(400)
    const theirs = await call(adjust.POST, A.key, 'POST', '/adjust', {
      params: { id: B.ids.part },
      body: { delta: 1 },
    })
    expect(theirs.status).toBe(404)
    expect((await db.inventoryPart.findUniqueOrThrow({ where: { id: B.ids.part } })).quantity).toBe(
      4
    )

    const events = await eventsOf(A.org, 'inventory.create')
    expect(events.audits).toHaveLength(1)
    expect(events.deliveries).toBe(1)
    // The rename only; an adjustment records no event, as the app's scan doesn't.
    expect(await auditCount(A.org, 'inventory.update')).toBe(1)
  })
})

describe('labor presets', () => {
  it('keep their items and parts when only the name changes, and link only this workshop’s parts', async () => {
    resetKeyBudgets()
    const list = await route('labor-presets')
    const one = await route('labor-presets/[id]')
    const made = await call(list.POST, A.key, 'POST', '/labor-presets', {
      body: {
        name: 'Filter service',
        items: [{ description: 'Replace filter', hours: 0.5, rate: 100 }],
        parts: [{ name: 'Filter', quantity: 1, unitPrice: 20, inventoryPartId: A.ids.part }],
      },
    })
    expect(made.status).toBe(201)
    const preset = (await json(made)).data
    const renamed = await call(one.PATCH, A.key, 'PATCH', '/l', {
      params: { id: preset.id },
      body: { name: 'Filter service (oil)' },
    })
    expect(renamed.status).toBe(200)
    const data = (await json(renamed)).data as unknown as {
      items: unknown[]
      parts: unknown[]
      name: string
    }
    expect(data.name).toBe('Filter service (oil)')
    expect(data.items).toHaveLength(1)
    expect(data.parts).toHaveLength(1)

    const theirs = await call(list.POST, A.key, 'POST', '/labor-presets', {
      body: {
        items: [{ description: 'X', hours: 1, rate: 1 }],
        parts: [{ name: 'Theirs', quantity: 1, unitPrice: 1, inventoryPartId: B.ids.part }],
      },
    })
    expect(theirs.status).toBe(404)
    expect(await auditCount(A.org, 'labor_preset.create')).toBe(1)
    expect(await auditCount(A.org, 'labor_preset.update')).toBe(1)
  })
})

describe('findings', () => {
  it('are recorded on a work order, keep their severity, resolve, and refuse another workshop’s ids', async () => {
    resetKeyBudgets()
    const list = await route('findings')
    const one = await route('findings/[id]')
    const resolve = await route('findings/[id]/resolve')
    const made = await call(list.POST, A.key, 'POST', '/findings', {
      body: {
        vehicleId: A.ids.vehicle,
        description: 'Wiper blades worn',
        severity: 'monitor',
        workOrderId: A.ids.workOrder,
      },
    })
    expect(made.status).toBe(201)
    const finding = (await json(made)).data
    expect(finding).toMatchObject({
      workOrderId: A.ids.workOrder,
      severity: 'monitor',
      status: 'open',
    })

    const noted = await call(one.PATCH, A.key, 'PATCH', '/f', {
      params: { id: finding.id },
      body: { notes: 'Rear one too' },
    })
    expect((await json(noted)).data).toMatchObject({ severity: 'monitor', notes: 'Rear one too' })

    for (const body of [{ workOrderId: B.ids.workOrder }, { vehicleId: B.ids.vehicle }]) {
      const theirs = await call(one.PATCH, A.key, 'PATCH', '/f', {
        params: { id: finding.id },
        body,
      })
      expect(theirs.status).toBe(404)
    }
    const theirJob = await call(list.POST, A.key, 'POST', '/findings', {
      body: { vehicleId: A.ids.vehicle, description: 'X', workOrderId: B.ids.workOrder },
    })
    expect(theirJob.status).toBe(404)
    const theirFix = await call(resolve.POST, A.key, 'POST', '/r', {
      params: { id: finding.id },
      body: { workOrderId: B.ids.workOrder },
    })
    expect(theirFix.status).toBe(404)
    expect(
      await db.vehicleFinding.findUniqueOrThrow({
        where: { id: finding.id },
        select: { vehicleId: true, serviceRecordId: true, status: true },
      })
    ).toEqual({ vehicleId: A.ids.vehicle, serviceRecordId: A.ids.workOrder, status: 'open' })

    const fixed = await call(resolve.POST, A.key, 'POST', '/r', {
      params: { id: finding.id },
      body: { workOrderId: A.ids.workOrder2 },
    })
    expect((await json(fixed)).data).toMatchObject({
      status: 'resolved',
      resolvedWorkOrderId: A.ids.workOrder2,
    })
    expect(
      (await call(one.DELETE, A.key, 'DELETE', '/f', { params: { id: finding.id } })).status
    ).toBe(200)
    for (const action of [
      'finding.create',
      'finding.update',
      'finding.resolve',
      'finding.delete',
    ]) {
      const events = await eventsOf(A.org, action)
      expect(events.audits).toHaveLength(1)
      expect(events.deliveries).toBe(1)
    }
  })
})

describe('webhooks', () => {
  it('answer with the secret once, keep what a change doesn’t send, and are removed', async () => {
    resetKeyBudgets()
    const list = await route('webhooks')
    const one = await route('webhooks/[id]')
    const made = await call(list.POST, A.key, 'POST', '/webhooks', {
      body: { name: 'Sync', url: 'https://hooks.example.test/sync', events: ['customer.create'] },
    })
    expect(made.status).toBe(201)
    const hook = (await json(made)).data
    expect(typeof hook.secret).toBe('string')
    expect((hook.secret as string).length).toBeGreaterThan(20)
    const read = (await json(await call(one.GET, A.key, 'GET', '/w', { params: { id: hook.id } })))
      .data
    expect(read).not.toHaveProperty('secret')

    const renamed = await call(one.PATCH, A.key, 'PATCH', '/w', {
      params: { id: hook.id },
      body: { name: 'Sync (CRM)' },
    })
    expect(renamed.status).toBe(200)
    expect((await json(renamed)).data).toMatchObject({
      name: 'Sync (CRM)',
      url: 'https://hooks.example.test/sync',
      events: ['customer.create'],
      isActive: true,
    })
    expect(
      (await call(one.DELETE, A.key, 'DELETE', '/w', { params: { id: hook.id } })).status
    ).toBe(200)
    expect(await auditCount(A.org, 'webhook.create')).toBe(1)
    expect(await auditCount(A.org, 'webhook.update')).toBe(1)
    expect(await auditCount(A.org, 'webhook.delete')).toBe(1)
  })
})

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

function upload(
  handler: Handler,
  key: string,
  workOrderId: string,
  file: File,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {}
) {
  const form = new FormData()
  form.append('file', file)
  for (const [name, value] of Object.entries(fields)) form.append(name, value)
  return handler(
    new Request(`http://localhost/api/v1/work-orders/${workOrderId}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'x-real-ip': '203.0.113.21', ...headers },
      body: form,
    }),
    { params: Promise.resolve({ id: workOrderId }) }
  )
}

describe('work order attachments', () => {
  it('are uploaded as multipart, read back, replayed by Idempotency-Key, and removed with their file', async () => {
    resetKeyBudgets()
    const list = await route('work-orders/[id]/attachments')
    const one = await route('work-orders/[id]/attachments/[attachmentId]')
    const content = await route('work-orders/[id]/attachments/[attachmentId]/content')
    const photo = () => new File([PNG], 'bay.png', { type: 'image/png' })

    const sent = await upload(
      list.POST,
      A.key,
      A.ids.workOrder,
      photo(),
      { description: 'Before' },
      {
        'idempotency-key': 'photo-1',
      }
    )
    expect(sent.status).toBe(201)
    const attachment = (await json(sent)).data
    expect(attachment).toMatchObject({
      fileName: 'bay.png',
      fileType: 'image/png',
      description: 'Before',
    })
    const row = await db.serviceAttachment.findUniqueOrThrow({ where: { id: attachment.id } })
    expect(row).toMatchObject({
      category: 'image',
      includeInInvoice: true,
      fileSize: PNG.byteLength,
    })
    const stored = path.join(dataRoot, 'uploads', A.org, 'services', path.basename(row.fileUrl))
    expect(existsSync(stored)).toBe(true)

    // Sent again (a new multipart boundary), the same answer, and still one file.
    const replayed = await upload(
      list.POST,
      A.key,
      A.ids.workOrder,
      photo(),
      { description: 'Before' },
      {
        'idempotency-key': 'photo-1',
      }
    )
    expect(replayed.status).toBe(201)
    expect(replayed.headers.get('Idempotent-Replayed')).toBe('true')
    expect(await db.serviceAttachment.count({ where: { serviceRecordId: A.ids.workOrder } })).toBe(
      1
    )

    const bytes = await call(content.GET, A.key, 'GET', '/c', {
      params: { id: A.ids.workOrder, attachmentId: attachment.id },
    })
    expect(bytes.status).toBe(200)
    expect(Buffer.from(await bytes.arrayBuffer()).equals(PNG)).toBe(true)

    const zip = await upload(
      list.POST,
      A.key,
      A.ids.workOrder,
      new File([PNG], 'x.zip', { type: 'application/zip' })
    )
    expect(zip.status).toBe(400)
    const fake = await upload(
      list.POST,
      A.key,
      A.ids.workOrder,
      new File([PNG], 'x.pdf', { type: 'application/pdf' })
    )
    expect(fake.status).toBe(400)
    expect((await upload(list.POST, A.key, B.ids.workOrder, photo())).status).toBe(404)
    expect(await db.serviceAttachment.count({ where: { serviceRecordId: B.ids.workOrder } })).toBe(
      0
    )

    // Another workshop's key can't remove it, nor reach it through its own work order's id.
    for (const workOrderId of [A.ids.workOrder, B.ids.workOrder]) {
      const theirs = await call(one.DELETE, B.key, 'DELETE', '/a', {
        params: { id: workOrderId, attachmentId: attachment.id },
      })
      expect(theirs.status).toBe(404)
    }
    const gone = await call(one.DELETE, A.key, 'DELETE', '/a', {
      params: { id: A.ids.workOrder, attachmentId: attachment.id },
    })
    expect(gone.status).toBe(200)
    expect(await db.serviceAttachment.count({ where: { id: attachment.id } })).toBe(0)
    expect(existsSync(stored)).toBe(false)
    expect(
      await db.deletedRecord.count({ where: { entityType: 'attachment', entityId: attachment.id } })
    ).toBe(1)
  })

  it('takes a refused upload’s file away with it', async () => {
    resetKeyBudgets()
    const list = await route('work-orders/[id]/attachments')
    const folder = path.join(dataRoot, 'uploads', A.org, 'services')
    const photo = () => new File([PNG], 'bay.png', { type: 'image/png' })
    photoLimit.set(A.org, 1)
    try {
      expect((await upload(list.POST, A.key, A.ids.workOrder2, photo())).status).toBe(201)
      const files = readdirSync(folder).length
      // Past the plan's limit: the app's own refusal, and the file just written is gone again.
      const refused = await upload(list.POST, A.key, A.ids.workOrder2, photo())
      expect(refused.status).toBe(400)
      expect(readdirSync(folder)).toHaveLength(files)
      expect(
        await db.serviceAttachment.count({ where: { serviceRecordId: A.ids.workOrder2 } })
      ).toBe(1)
    } finally {
      photoLimit.delete(A.org)
    }
  })

  it('refuses a file that isn’t the type it says it is', async () => {
    resetKeyBudgets()
    const list = await route('work-orders/[id]/attachments')
    for (const file of [
      new File([Buffer.from('not a picture')], 'x.jpg', { type: 'image/jpeg' }),
      new File([PNG], 'x.webp', { type: 'image/webp' }),
      new File([Buffer.from([0x61, 0x00, 0x62])], 'x.txt', { type: 'text/plain' }),
    ]) {
      expect((await upload(list.POST, A.key, A.ids.workOrder2, file)).status).toBe(400)
    }
  })
})
