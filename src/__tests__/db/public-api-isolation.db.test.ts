/**
 * fork (A6, docs/fork/milestones/A6-hardening.md task 3) on a real PostgreSQL (`npm run test:db`): one sweep over every
 * public API route that names a record. Workshop A's key, sent with workshop B's ids, gets 404 from every method of
 * every one of them, read or write, exactly as for an id that doesn't exist; and B's records are as they were. The
 * routes are found on disk (`src/app/api/v1`), so a new one is swept without being listed here. A key with full
 * access, so a refusal is the workshop's and not the permission's. Its own workshops, removed again. SYNTHETIC data.
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
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
let A: Shop
let B: Shop

const ROOT = path.join(process.cwd(), 'src', 'app', 'api', 'v1')
/** Not the public API's: the technician app, the cron, the health check. */
const NOT_PUBLIC = new Set(['tech', 'cron', 'health'])

/** Every public API route folder with a `[param]` in it, as `customers/[id]/contacts/[contactId]`. */
function routesWithIds(dir = ROOT, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (!statSync(full).isDirectory()) continue
    if (!prefix && NOT_PUBLIC.has(name)) continue
    const rel = prefix ? `${prefix}/${name}` : name
    if (readdirSync(full).includes('route.ts') && rel.includes('[')) out.push(rel)
    out.push(...routesWithIds(full, rel))
  }
  return out
}

/** Which of B's ids a path's parameter takes: by the folder it follows. */
const ID_OF: Record<string, string> = {
  customers: 'customer',
  contacts: 'contact',
  vehicles: 'vehicle',
  findings: 'finding',
  'work-orders': 'workOrder',
  jobs: 'job',
  lines: 'line',
  payments: 'payment',
  attachments: 'attachment',
  quotes: 'quote',
  'inventory-parts': 'part',
  'labor-presets': 'preset',
  appointments: 'appointment',
  'time-entries': 'timeEntry',
  shifts: 'shift',
  technicians: 'technician',
  webhooks: 'webhook',
  'work-order-statuses': 'status',
  inspections: 'inspection',
}

/** The table each of B's seeded records is in, so the sweep can show that none of them changed. */
const MODEL_OF: Record<string, string> = {
  customer: 'customer',
  contact: 'customerContact',
  vehicle: 'vehicle',
  technician: 'technician',
  workOrder: 'serviceRecord',
  job: 'workJob',
  line: 'serviceLabor',
  payment: 'payment',
  attachment: 'serviceAttachment',
  quote: 'quote',
  appointment: 'appointment',
  timeEntry: 'timeEntry',
  shift: 'technicianShift',
  part: 'inventoryPart',
  preset: 'laborPreset',
  finding: 'vehicleFinding',
  webhook: 'webhook',
  status: 'workOrderStatus',
  inspection: 'inspection',
}

type Finder = { findUnique: (args: { where: { id: string } }) => Promise<unknown> }

/** Every record of B's the sweep has an id for, as it is now. */
async function snapshotOf(ids: Record<string, string>) {
  const out: Record<string, unknown> = {}
  for (const [kind, id] of Object.entries(ids)) {
    const model = MODEL_OF[kind]
    if (!model) throw new Error(`No table for B's ${kind}`)
    out[kind] = await (db as unknown as Record<string, Finder>)[model].findUnique({ where: { id } })
  }
  return out
}

function paramsFor(rel: string, ids: Record<string, string>) {
  const segments = rel.split('/')
  const params: Record<string, string> = {}
  segments.forEach((segment, i) => {
    const m = /^\[(\w+)\]$/.exec(segment)
    if (!m) return
    const kind = ID_OF[segments[i - 1]]
    if (!kind || !ids[kind]) throw new Error(`No id of workshop B for ${rel} (${segments[i - 1]})`)
    params[m[1]] = ids[kind]
  })
  return params
}

/** One record of every kind a route can name, in a workshop. */
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
    await db.payment.create({ data: { serviceRecordId: ids.workOrder, amount: 1, method: 'cash' } })
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
  ids.status = (
    await db.workOrderStatus.create({
      data: { organizationId: org, name: 'Theirs status', stage: 'pending' },
    })
  ).id
  const template = await db.inspectionTemplate.create({
    data: { organizationId: org, name: 'Theirs template' },
  })
  ids.inspection = (
    await db.inspection.create({
      data: { organizationId: org, vehicleId: ids.vehicle, templateId: template.id },
    })
  ).id
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  A = await newShop('A6isoA')
  B = await newShop('A6isoB')
  await seed(B)
}, 120_000)

afterAll(async () => {
  await removeCreated()
})

const METHODS = ['GET', 'PATCH', 'PUT', 'POST', 'DELETE'] as const

/**
 * A valid body for the routes that check it before they look the parent up (a 400 there says nothing of another
 * workshop's records, but the sweep is about the 404): what each would create, under B's parent.
 */
const BODY_OF: Record<string, unknown> = {
  'POST customers/[id]/contacts': { kind: 'email', value: 'swept@example.com' },
  'POST work-orders/[id]/jobs': { name: 'Swept job' },
  'POST work-orders/[id]/lines': { kind: 'labor', description: 'Swept', hours: 1, rate: 1 },
  'POST work-orders/[id]/payments': { amount: 1, method: 'cash' },
  'POST work-orders/[id]/status': { status: 'completed' },
}

/** An upload, as multipart (the attachments route takes nothing else). */
function upload(handler: Handler, key: string, pathname: string, params: Record<string, string>) {
  const form = new FormData()
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }))
  return handler(
    new Request(`http://localhost/api/v1${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'x-real-ip': '203.0.113.21' },
      body: form,
    }),
    { params: Promise.resolve(params) }
  )
}

describe('the isolation sweep', () => {
  it('finds the routes it sweeps on disk', () => {
    const routes = routesWithIds()
    expect(routes.length).toBeGreaterThan(20)
    expect(routes).toContain('customers/[id]')
    expect(routes).toContain('work-orders/[id]/lines/[lineId]')
  })

  it('answers 404 to every method of every route, for workshop A’s key and workshop B’s ids', async () => {
    const before = await snapshotOf(B.ids)
    const wrong: string[] = []
    let calls = 0
    for (const rel of routesWithIds()) {
      const module = (await route(rel)) as Partial<Record<(typeof METHODS)[number], Handler>>
      const params = paramsFor(rel, B.ids)
      for (const method of METHODS) {
        const handler = module[method]
        if (!handler) continue
        calls++
        const pathname = `/${rel.replace(/\[(\w+)\]/g, (_, p: string) => params[p])}`
        const name = `${method} ${rel}`
        const response =
          name === 'POST work-orders/[id]/attachments'
            ? await upload(handler, A.key, pathname, params)
            : await call(handler, A.key, method, pathname, {
                params,
                ...(method === 'GET' || method === 'DELETE' ? {} : { body: BODY_OF[name] ?? {} }),
              })
        if (response.status !== 404) wrong.push(`${name}: ${response.status}`)
      }
    }
    expect(calls).toBeGreaterThan(40)
    expect(wrong).toEqual([])
    // And nothing of B's changed: every record the sweep aimed at is there, as it was.
    const after = await snapshotOf(B.ids)
    for (const [kind, row] of Object.entries(before)) expect(row, kind).not.toBeNull()
    expect(after).toEqual(before)
  })
})
