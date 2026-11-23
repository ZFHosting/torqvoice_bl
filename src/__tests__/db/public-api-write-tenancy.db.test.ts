/**
 * fork: tenant isolation over every public API write endpoint, on a real PostgreSQL (`npm run test:db`;
 * docs/fork/milestones/A4-write-endpoints.md, Acceptance; docs/fork/API.md §7). A key of workshop A, sent with
 * workshop B's ids (in the path, or in the body for what a new record points at), gets 404 from every write, and
 * neither workshop has a row changed or an audit event more afterwards. A key with full access, so a refusal is the
 * workshop's and not the permission's. Its own workshops, removed again. SYNTHETIC data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  call,
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

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let resetKeyBudgets: typeof import('@/features/public-api/Lib/rateLimit')['resetKeyBudgets']
let A: Shop
let B: Shop

/** Every kind of record a write can name, one of each, in B. */
async function seed(shop: Shop) {
  const { org, owner, ids } = shop
  ids.customer = (
    await db.customer.create({ data: { organizationId: org, userId: owner, name: 'Owner' } })
  ).id
  ids.contact = (
    await db.customerContact.create({
      data: {
        organizationId: org,
        customerId: ids.customer,
        kind: 'email',
        value: 'x@example.com',
      },
    })
  ).id
  ids.vehicle = (
    await db.vehicle.create({
      data: {
        organizationId: org,
        userId: owner,
        customerId: ids.customer,
        make: 'Make',
        model: 'Model',
        year: 2020,
      },
    })
  ).id
  ids.technician = (await db.technician.create({ data: { organizationId: org, name: 'Tech' } })).id
  ids.workOrder = (
    await db.serviceRecord.create({
      data: { organizationId: org, title: 'Theirs', vehicleId: ids.vehicle, status: 'pending' },
    })
  ).id
  ids.job = (
    await db.workJob.create({
      data: { organizationId: org, serviceRecordId: ids.workOrder, name: 'Job' },
    })
  ).id
  ids.line = (
    await db.serviceLabor.create({
      data: { serviceRecordId: ids.workOrder, description: 'Labor', hours: 1, rate: 1, total: 1 },
    })
  ).id
  ids.payment = (
    await db.payment.create({
      data: { serviceRecordId: ids.workOrder, amount: 1, method: 'cash' },
    })
  ).id
  ids.attachment = (
    await db.serviceAttachment.create({
      data: {
        serviceRecordId: ids.workOrder,
        fileName: 'x.png',
        fileUrl: `/api/protected/files/${org}/services/x.png`,
        fileType: 'image/png',
        fileSize: 1,
      },
    })
  ).id
  ids.quote = (
    await db.quote.create({
      data: { organizationId: org, userId: owner, title: 'Quote', vehicleId: ids.vehicle },
    })
  ).id
  ids.appointment = (
    await db.appointment.create({
      data: {
        organizationId: org,
        title: 'Appointment',
        startAt: new Date('2026-12-01T09:00:00Z'),
        endAt: new Date('2026-12-01T10:00:00Z'),
      },
    })
  ).id
  ids.timeEntry = (
    await db.timeEntry.create({
      data: {
        organizationId: org,
        technicianId: ids.technician,
        serviceRecordId: ids.workOrder,
        startedAt: new Date(),
        source: 'app',
      },
    })
  ).id
  ids.shift = (
    await db.technicianShift.create({
      data: { organizationId: org, technicianId: ids.technician, clockIn: new Date() },
    })
  ).id
  ids.part = (
    await db.inventoryPart.create({
      data: { organizationId: org, userId: owner, name: 'Part', quantity: 3 },
    })
  ).id
  ids.preset = (
    await db.laborPreset.create({ data: { organizationId: org, userId: owner, name: 'Preset' } })
  ).id
  ids.finding = (
    await db.vehicleFinding.create({ data: { vehicleId: ids.vehicle, description: 'Finding' } })
  ).id
  ids.webhook = (
    await db.webhook.findFirstOrThrow({ where: { organizationId: org }, select: { id: true } })
  ).id
}

/** What the workshops hold: every seeded row of B as it is, and each workshop's audit log size. */
async function snapshot() {
  const b = B.ids
  const rows = await Promise.all([
    db.customer.findUnique({ where: { id: b.customer } }),
    db.customerContact.findUnique({ where: { id: b.contact } }),
    db.vehicle.findUnique({ where: { id: b.vehicle } }),
    db.technician.findUnique({ where: { id: b.technician } }),
    db.serviceRecord.findUnique({ where: { id: b.workOrder } }),
    db.workJob.findUnique({ where: { id: b.job } }),
    db.serviceLabor.findUnique({ where: { id: b.line } }),
    db.payment.findUnique({ where: { id: b.payment } }),
    db.serviceAttachment.findUnique({ where: { id: b.attachment } }),
    db.quote.findUnique({ where: { id: b.quote } }),
    db.appointment.findUnique({ where: { id: b.appointment } }),
    db.timeEntry.findUnique({ where: { id: b.timeEntry } }),
    db.technicianShift.findUnique({ where: { id: b.shift } }),
    db.inventoryPart.findUnique({ where: { id: b.part } }),
    db.laborPreset.findUnique({ where: { id: b.preset } }),
    db.vehicleFinding.findUnique({ where: { id: b.finding } }),
    db.webhook.findUnique({ where: { id: b.webhook } }),
  ])
  const counts = await Promise.all(
    [A.org, B.org].flatMap((organizationId) => [
      db.auditLog.count({ where: { organizationId } }),
      db.serviceRecord.count({ where: { organizationId } }),
      db.timeEntry.count({ where: { organizationId } }),
      db.deletedRecord.count({ where: { organizationId } }),
    ])
  )
  return JSON.stringify({ rows, counts })
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  ;({ resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit'))
  A = await newShop('TenancyAlpha')
  B = await newShop('TenancyBravo')
  await seed(B)
  A.ids.customer = (
    await db.customer.create({ data: { organizationId: A.org, userId: A.owner, name: 'Mine' } })
  ).id
  A.ids.vehicle = (
    await db.vehicle.create({
      data: {
        organizationId: A.org,
        userId: A.owner,
        customerId: A.ids.customer,
        make: 'M',
        model: 'M',
        year: 2020,
      },
    })
  ).id
})

afterAll(async () => {
  if (db) await removeCreated()
})

type Case = {
  name: string
  path: string
  method: 'POST' | 'PATCH' | 'DELETE'
  params?: () => Record<string, string>
  body?: () => unknown
}

const b = () => B.ids
const CASES: Case[] = [
  // Customers and their contacts
  {
    name: 'change a customer',
    path: 'customers/[id]',
    method: 'PATCH',
    params: () => ({ id: b().customer }),
    body: () => ({ name: 'Mine' }),
  },
  {
    name: 'delete a customer',
    path: 'customers/[id]',
    method: 'DELETE',
    params: () => ({ id: b().customer }),
  },
  {
    name: 'add a contact',
    path: 'customers/[id]/contacts',
    method: 'POST',
    params: () => ({ id: b().customer }),
    body: () => ({ kind: 'phone', value: '+15550100' }),
  },
  {
    name: 'change a contact',
    path: 'customers/[id]/contacts/[contactId]',
    method: 'PATCH',
    params: () => ({ id: b().customer, contactId: b().contact }),
    body: () => ({ value: 'y@example.com' }),
  },
  {
    name: 'delete a contact',
    path: 'customers/[id]/contacts/[contactId]',
    method: 'DELETE',
    params: () => ({ id: b().customer, contactId: b().contact }),
  },
  // Vehicles
  {
    name: 'add a vehicle for their customer',
    path: 'vehicles',
    method: 'POST',
    body: () => ({ make: 'M', model: 'M', year: 2020, customerId: b().customer }),
  },
  {
    name: 'change a vehicle',
    path: 'vehicles/[id]',
    method: 'PATCH',
    params: () => ({ id: b().vehicle }),
    body: () => ({ model: 'Mine' }),
  },
  {
    name: 'move my vehicle to their customer',
    path: 'vehicles/[id]',
    method: 'PATCH',
    params: () => ({ id: A.ids.vehicle }),
    body: () => ({ customerId: b().customer }),
  },
  {
    name: 'delete a vehicle',
    path: 'vehicles/[id]',
    method: 'DELETE',
    params: () => ({ id: b().vehicle }),
  },
  // Work orders and what hangs off them
  {
    name: 'open a work order on their vehicle',
    path: 'work-orders',
    method: 'POST',
    body: () => ({ vehicleId: b().vehicle, title: 'Mine' }),
  },
  {
    name: 'change a work order',
    path: 'work-orders/[id]',
    method: 'PATCH',
    params: () => ({ id: b().workOrder }),
    body: () => ({ title: 'Mine' }),
  },
  {
    name: 'delete a work order',
    path: 'work-orders/[id]',
    method: 'DELETE',
    params: () => ({ id: b().workOrder }),
  },
  {
    name: 'move a work order',
    path: 'work-orders/[id]/status',
    method: 'POST',
    params: () => ({ id: b().workOrder }),
    body: () => ({ status: 'completed' }),
  },
  {
    name: 'add a line',
    path: 'work-orders/[id]/lines',
    method: 'POST',
    params: () => ({ id: b().workOrder }),
    body: () => ({ kind: 'labor', description: 'X', hours: 1, rate: 1 }),
  },
  {
    name: 'change a line',
    path: 'work-orders/[id]/lines/[lineId]',
    method: 'PATCH',
    params: () => ({ id: b().workOrder, lineId: b().line }),
    body: () => ({ hours: 9 }),
  },
  {
    name: 'remove a line',
    path: 'work-orders/[id]/lines/[lineId]',
    method: 'DELETE',
    params: () => ({ id: b().workOrder, lineId: b().line }),
  },
  {
    name: 'add a job',
    path: 'work-orders/[id]/jobs',
    method: 'POST',
    params: () => ({ id: b().workOrder }),
    body: () => ({ name: 'Mine' }),
  },
  {
    name: 'change a job',
    path: 'work-orders/[id]/jobs/[jobId]',
    method: 'PATCH',
    params: () => ({ id: b().workOrder, jobId: b().job }),
    body: () => ({ name: 'Mine' }),
  },
  {
    name: 'remove a job',
    path: 'work-orders/[id]/jobs/[jobId]',
    method: 'DELETE',
    params: () => ({ id: b().workOrder, jobId: b().job }),
  },
  {
    name: 'record a payment',
    path: 'work-orders/[id]/payments',
    method: 'POST',
    params: () => ({ id: b().workOrder }),
    body: () => ({ amount: 1 }),
  },
  {
    name: 'remove a payment',
    path: 'work-orders/[id]/payments/[paymentId]',
    method: 'DELETE',
    params: () => ({ id: b().workOrder, paymentId: b().payment }),
  },
  {
    name: 'remove an attachment',
    path: 'work-orders/[id]/attachments/[attachmentId]',
    method: 'DELETE',
    params: () => ({ id: b().workOrder, attachmentId: b().attachment }),
  },
  // Quotes
  {
    name: 'quote their vehicle',
    path: 'quotes',
    method: 'POST',
    body: () => ({ title: 'Mine', vehicleId: b().vehicle }),
  },
  {
    name: 'quote for their customer',
    path: 'quotes',
    method: 'POST',
    body: () => ({ title: 'Mine', customerId: b().customer }),
  },
  {
    name: 'change a quote',
    path: 'quotes/[id]',
    method: 'PATCH',
    params: () => ({ id: b().quote }),
    body: () => ({ title: 'Mine' }),
  },
  {
    name: 'delete a quote',
    path: 'quotes/[id]',
    method: 'DELETE',
    params: () => ({ id: b().quote }),
  },
  {
    name: 'convert a quote',
    path: 'quotes/[id]/convert',
    method: 'POST',
    params: () => ({ id: b().quote }),
    body: () => ({}),
  },
  // Appointments
  {
    name: 'book their customer',
    path: 'appointments',
    method: 'POST',
    body: () => ({
      title: 'Mine',
      customerId: b().customer,
      startDate: '2026-12-01',
      startTime: '09:00',
      endDate: '2026-12-01',
      endTime: '10:00',
    }),
  },
  {
    name: 'change an appointment',
    path: 'appointments/[id]',
    method: 'PATCH',
    params: () => ({ id: b().appointment }),
    body: () => ({ title: 'Mine' }),
  },
  {
    name: 'delete an appointment',
    path: 'appointments/[id]',
    method: 'DELETE',
    params: () => ({ id: b().appointment }),
  },
  // Technicians, time and shifts
  {
    name: 'link their login',
    path: 'technicians',
    method: 'POST',
    body: () => ({ name: 'Mine', userId: B.owner }),
  },
  {
    name: 'change a technician',
    path: 'technicians/[id]',
    method: 'PATCH',
    params: () => ({ id: b().technician }),
    body: () => ({ name: 'Mine' }),
  },
  {
    name: 'deactivate a technician',
    path: 'technicians/[id]',
    method: 'DELETE',
    params: () => ({ id: b().technician }),
  },
  {
    name: 'clock time on their job',
    path: 'time-entries',
    method: 'POST',
    body: () => ({
      technicianId: b().technician,
      workOrderId: b().workOrder,
      startedAt: '2026-11-20T08:00',
      endedAt: '2026-11-20T09:00',
    }),
  },
  {
    name: 'change a time entry',
    path: 'time-entries/[id]',
    method: 'PATCH',
    params: () => ({ id: b().timeEntry }),
    body: () => ({ note: 'Mine' }),
  },
  {
    name: 'delete a time entry',
    path: 'time-entries/[id]',
    method: 'DELETE',
    params: () => ({ id: b().timeEntry }),
  },
  {
    name: 'start their clock',
    path: 'time-entries/start',
    method: 'POST',
    body: () => ({ technicianId: b().technician, workOrderId: b().workOrder }),
  },
  {
    name: 'stop their clock',
    path: 'time-entries/[id]/stop',
    method: 'POST',
    params: () => ({ id: b().timeEntry }),
    body: () => ({}),
  },
  {
    name: 'clock in their technician',
    path: 'shifts',
    method: 'POST',
    body: () => ({ technicianId: b().technician, clockIn: '2026-11-20T07:00:00Z' }),
  },
  {
    name: 'change a shift',
    path: 'shifts/[id]',
    method: 'PATCH',
    params: () => ({ id: b().shift }),
    body: () => ({ note: 'Mine' }),
  },
  {
    name: 'delete a shift',
    path: 'shifts/[id]',
    method: 'DELETE',
    params: () => ({ id: b().shift }),
  },
  // Inventory and presets
  {
    name: 'change a part',
    path: 'inventory-parts/[id]',
    method: 'PATCH',
    params: () => ({ id: b().part }),
    body: () => ({ name: 'Mine' }),
  },
  {
    name: 'delete a part',
    path: 'inventory-parts/[id]',
    method: 'DELETE',
    params: () => ({ id: b().part }),
  },
  {
    name: 'adjust a part’s stock',
    path: 'inventory-parts/[id]/adjust',
    method: 'POST',
    params: () => ({ id: b().part }),
    body: () => ({ delta: 1 }),
  },
  {
    name: 'a preset of their part',
    path: 'labor-presets',
    method: 'POST',
    body: () => ({
      items: [{ description: 'X', hours: 1, rate: 1 }],
      parts: [{ name: 'X', quantity: 1, unitPrice: 1, inventoryPartId: b().part }],
    }),
  },
  {
    name: 'change a preset',
    path: 'labor-presets/[id]',
    method: 'PATCH',
    params: () => ({ id: b().preset }),
    body: () => ({ name: 'Mine' }),
  },
  {
    name: 'delete a preset',
    path: 'labor-presets/[id]',
    method: 'DELETE',
    params: () => ({ id: b().preset }),
  },
  // Findings and webhooks
  {
    name: 'a finding on their vehicle',
    path: 'findings',
    method: 'POST',
    body: () => ({ vehicleId: b().vehicle, description: 'Mine' }),
  },
  {
    name: 'change a finding',
    path: 'findings/[id]',
    method: 'PATCH',
    params: () => ({ id: b().finding }),
    body: () => ({ notes: 'Mine' }),
  },
  {
    name: 'resolve a finding',
    path: 'findings/[id]/resolve',
    method: 'POST',
    params: () => ({ id: b().finding }),
    body: () => ({}),
  },
  {
    name: 'delete a finding',
    path: 'findings/[id]',
    method: 'DELETE',
    params: () => ({ id: b().finding }),
  },
  {
    name: 'change a webhook',
    path: 'webhooks/[id]',
    method: 'PATCH',
    params: () => ({ id: b().webhook }),
    body: () => ({ name: 'Mine' }),
  },
  {
    name: 'delete a webhook',
    path: 'webhooks/[id]',
    method: 'DELETE',
    params: () => ({ id: b().webhook }),
  },
]

/** An upload to their work order, multipart like any upload. */
async function uploadToTheirs(handler: Handler) {
  const form = new FormData()
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }))
  return handler(
    new Request(`http://localhost/api/v1/work-orders/${B.ids.workOrder}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${A.key}`, 'x-real-ip': '203.0.113.21' },
      body: form,
    }),
    { params: Promise.resolve({ id: B.ids.workOrder }) }
  )
}

describe('another workshop’s records, through every write endpoint', () => {
  it('are not found, and nothing changes in either workshop', async () => {
    const before = await snapshot()
    const answers: Record<string, number> = {}
    for (const c of CASES) {
      resetKeyBudgets()
      const handler = (await route(c.path))[c.method]
      expect(handler, `${c.method} ${c.path}`).toBeTypeOf('function')
      const response = await call(handler, A.key, c.method, `/${c.path}`, {
        params: c.params?.(),
        body: c.method === 'DELETE' ? undefined : c.body?.(),
      })
      answers[c.name] = response.status
    }
    resetKeyBudgets()
    answers['upload an attachment'] = (
      await uploadToTheirs((await route('work-orders/[id]/attachments')).POST)
    ).status
    expect(answers).toEqual(Object.fromEntries(Object.keys(answers).map((name) => [name, 404])))
    // The audit log is written as the API answers; give the webhook dispatcher its moment too.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await snapshot()).toEqual(before)
  })

  it('covers every write the API serves', async () => {
    // Every write handler under src/app/api/v1 (but the technician app's) is in the table above.
    const { readdirSync, readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const root = path.join(process.cwd(), 'src/app/api/v1')
    const served: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === 'route.ts') {
          const rel = path.relative(root, dir).split(path.sep).join('/')
          if (/^(tech|cron)(\/|$)/.test(rel)) continue
          const text = readFileSync(full, 'utf8')
          if (!text.includes('public-api/Writes/')) continue
          for (const m of text.matchAll(/export const (POST|PATCH|DELETE) =/g)) {
            served.push(`${m[1]} ${rel}`)
          }
        }
      }
    }
    walk(root)
    const tested = new Set([
      ...CASES.map((c) => `${c.method} ${c.path}`),
      'POST work-orders/[id]/attachments',
    ])
    // Creating a customer, an inventory part or a webhook names nothing of another workshop's: what it makes is the
    // key's own (each one's own test checks the row).
    const nothingToName = new Set(['POST customers', 'POST inventory-parts', 'POST webhooks'])
    expect([...new Set(served)].sort()).toEqual([...new Set([...tested, ...nothingToName])].sort())
  })
})
