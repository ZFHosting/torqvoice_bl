/**
 * fork: the public API's read endpoints on a real PostgreSQL (`npm run test:db`; docs/fork/milestones/A3-read-endpoints.md,
 * Acceptance), through the real route handlers and real keys.
 *
 * Two workshops, each with one of everything. Table by table: a key lists and gets its own workshop's records,
 * in their published shape, and never another's (404, as if it didn't exist); the nested reads and the attachment
 * download the same. Then paging over 500 records while some change, `updatedSince`, and a role without the READ
 * permission. It makes its own workshops and removes them again.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'

const url = process.env.E2E_DATABASE_URL ?? ''
const databaseName = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
if (url && !/test|e2e/.test(databaseName)) {
  throw new Error(
    `Refusing to use database "${databaseName}": its name must say test or e2e, like the rest of this suite.`
  )
}
process.env.DATABASE_URL = url
process.env.API_KEY_PEPPER = 'db-test-pepper-that-is-long-enough'

const stamp = randomUUID().slice(0, 8)
const previousDataRoot = process.env.DATA_ROOT
let dataRoot = ''

let db: typeof import('@/lib/db')['db']
let keys: typeof import('@/features/public-api/Lib/keys.server')
let resetKeyBudgets: typeof import('@/features/public-api/Lib/rateLimit')['resetKeyBudgets']

type Handler = (
  request: Request,
  ctx: { params: Promise<Record<string, string>> }
) => Promise<Response>

interface Shop {
  org: string
  owner: string
  key: string
  ids: Record<string, string>
}
const A = {} as Shop
const B = {} as Shop
const created = { orgs: [] as string[], users: [] as string[] }

/** Every subject a read endpoint asks READ of. */
const SUBJECTS = [
  'customers',
  'vehicles',
  'services',
  'quotes',
  'inspections',
  'work_board',
  'labor_presets',
  'inventory',
  'time_tracking',
  'billing',
  'settings',
]

function request(key: string, pathAndQuery: string) {
  return new Request(`http://localhost/api/v1${pathAndQuery}`, {
    headers: { authorization: `Bearer ${key}`, 'x-real-ip': '203.0.113.9' },
  })
}

async function call(handler: Handler, key: string, pathAndQuery: string, params = {}) {
  return handler(request(key, pathAndQuery), { params: Promise.resolve(params) })
}

async function newKey(org: string, owner: string, subjects: string[]) {
  const role = await db.role.create({
    data: {
      organizationId: org,
      name: `Reads ${subjects.length} ${randomUUID().slice(0, 4)}`,
      permissions: { create: subjects.map((subject) => ({ action: 'read', subject })) },
    },
  })
  const made = await keys.createApiKey({
    organizationId: org,
    name: `key ${randomUUID().slice(0, 6)}`,
    roleId: role.id,
    createdById: owner,
  })
  const row = await db.apiKey.findUniqueOrThrow({ where: { id: made.id } })
  created.users.push(row.serviceUserId)
  return made.key
}

/** One of everything a read endpoint serves, in a workshop of its own. */
async function seed(shop: Shop, name: string) {
  shop.org = (await db.organization.create({ data: { name: `Read ${name} ${stamp}` } })).id
  shop.owner = (
    await db.user.create({
      data: { email: `read-${name.toLowerCase()}-${stamp}@example.com`, name: `Owner ${name}` },
    })
  ).id
  created.orgs.push(shop.org)
  created.users.push(shop.owner)
  await db.organizationMember.create({
    data: { organizationId: shop.org, userId: shop.owner, role: 'owner' },
  })
  const org = shop.org
  const user = shop.owner
  if (name === 'Alpha') {
    // Far from UTC (+14), so a calendar day can't come out right by accident.
    await db.appSetting.create({
      data: {
        organizationId: org,
        userId: user,
        key: 'workshop.timezone',
        value: 'Pacific/Kiritimati',
      },
    })
  }
  const customer = await db.customer.create({
    data: {
      organizationId: org,
      userId: user,
      name: `Customer ${name}`,
      email: `c-${name}@example.com`,
    },
  })
  const contact = await db.customerContact.create({
    data: { organizationId: org, customerId: customer.id, kind: 'phone', value: '+15555550100' },
  })
  const field = await db.customFieldDefinition.create({
    data: {
      organizationId: org,
      userId: user,
      name: 'po',
      label: 'PO',
      fieldType: 'text',
      entityType: 'customer',
    },
  })
  await db.customFieldValue.create({
    data: { fieldId: field.id, entityId: customer.id, entityType: 'customer', value: `PO-${name}` },
  })
  const vehicle = await db.vehicle.create({
    data: {
      organizationId: org,
      userId: user,
      customerId: customer.id,
      make: 'Make',
      model: 'Model',
      year: 2020,
      vin: `VINTEST${name}${stamp}`.slice(0, 17),
    },
  })
  await db.note.create({ data: { vehicleId: vehicle.id, title: 'Note', content: 'Text' } })
  const technician = await db.technician.create({
    data: { organizationId: org, name: `Tech ${name}` },
  })
  const status = await db.workOrderStatus.create({
    data: { organizationId: org, name: `Waiting ${name}`, stage: 'in-progress' },
  })
  const workOrder = await db.serviceRecord.create({
    data: {
      organizationId: org,
      title: `Job ${name}`,
      vehicleId: vehicle.id,
      technicianId: technician.id,
      customStatusId: status.id,
      invoiceNumber: `INV-${name}-${stamp}`,
      // 11:00 UTC: the 14th in UTC, the 15th in Kiritimati.
      invoiceDate: new Date('2025-03-14T11:00:00.000Z'),
      invoiceDueDate: new Date('2025-03-28T11:00:00.000Z'),
      startDateTime: new Date(),
      subtotal: 100,
      totalAmount: 108.25,
      taxRate: 8.25,
      taxAmount: 8.25,
    },
  })
  const job = await db.workJob.create({
    data: { organizationId: org, serviceRecordId: workOrder.id, name: 'Brakes' },
  })
  await db.serviceLabor.create({
    data: {
      serviceRecordId: workOrder.id,
      description: 'Replace pads',
      hours: 1,
      rate: 100,
      total: 100,
      jobId: job.id,
      technicianId: technician.id,
      lineKind: 'labor',
      sourceExtra: { remoteId: 'lab_1', costTotalCents: 'not a number' },
    },
  })
  await db.servicePart.create({
    data: { serviceRecordId: workOrder.id, name: 'Pads', quantity: 1, unitPrice: 50, total: 50 },
  })
  await db.serviceConcern.create({ data: { serviceRecordId: workOrder.id, description: 'Noise' } })
  const payment = await db.payment.create({
    data: { serviceRecordId: workOrder.id, amount: 50, date: new Date(), method: 'card' },
  })
  const fileName = `${randomUUID()}.txt`
  await mkdir(path.join(dataRoot, 'uploads', org, 'services'), { recursive: true })
  await writeFile(path.join(dataRoot, 'uploads', org, 'services', fileName), `file of ${name}`)
  const attachment = await db.serviceAttachment.create({
    data: {
      serviceRecordId: workOrder.id,
      fileName: 'report.txt',
      fileUrl: `/api/protected/files/${org}/services/${fileName}`,
      fileType: 'text/plain',
      fileSize: 10,
      category: 'diagnostic',
    },
  })
  await db.serviceRecordMeta.create({
    data: { organizationId: org, serviceRecordId: workOrder.id, labels: ['vip'] },
  })
  const timeEntry = await db.timeEntry.create({
    data: {
      organizationId: org,
      technicianId: technician.id,
      serviceRecordId: workOrder.id,
      startedAt: new Date(Date.now() - 3_600_000),
      endedAt: new Date(),
      durationMinutes: 60,
    },
  })
  const quote = await db.quote.create({
    data: {
      organizationId: org,
      userId: user,
      title: `Quote ${name}`,
      vehicleId: vehicle.id,
      validUntil: new Date('2025-04-01T11:00:00.000Z'),
    },
  })
  await db.quotePart.create({
    data: {
      quoteId: quote.id,
      name: 'Rotor',
      quantity: 2,
      unitPrice: 80,
      total: 160,
      excluded: true,
    },
  })
  const template = await db.inspectionTemplate.create({
    data: { organizationId: org, name: `Template ${name}` },
  })
  const inspection = await db.inspection.create({
    data: { organizationId: org, vehicleId: vehicle.id, templateId: template.id },
  })
  await db.inspectionItem.create({
    data: { inspectionId: inspection.id, name: 'Brakes', section: 'Under', condition: 'fail' },
  })
  const preset = await db.laborPreset.create({
    data: {
      organizationId: org,
      userId: user,
      name: `Preset ${name}`,
      items: { create: [{ description: 'Labor', hours: 1, rate: 90 }] },
      parts: { create: [{ name: 'Filter', quantity: 1, unitPrice: 12 }] },
    },
  })
  const part = await db.inventoryPart.create({
    data: { organizationId: org, userId: user, name: `Part ${name}`, quantity: 4, sellPrice: 9.99 },
  })
  const appointment = await db.appointment.create({
    data: {
      organizationId: org,
      title: `Visit ${name}`,
      startAt: new Date(),
      endAt: new Date(Date.now() + 3_600_000),
    },
  })
  const shift = await db.technicianShift.create({
    data: { organizationId: org, technicianId: technician.id, clockIn: new Date() },
  })
  const finding = await db.vehicleFinding.create({
    data: { vehicleId: vehicle.id, description: 'Worn tyres', serviceRecordId: workOrder.id },
  })
  const webhook = await db.webhook.create({
    data: {
      organizationId: org,
      createdById: user,
      name: `Hook ${name}`,
      url: 'https://hooks.example.test/a',
      secret: `whsec_sentinel_${stamp}`,
      events: JSON.stringify(['service.update']),
    },
  })
  shop.ids = {
    customer: customer.id,
    contact: contact.id,
    vehicle: vehicle.id,
    technician: technician.id,
    status: status.id,
    workOrder: workOrder.id,
    job: job.id,
    payment: payment.id,
    attachment: attachment.id,
    timeEntry: timeEntry.id,
    quote: quote.id,
    inspection: inspection.id,
    preset: preset.id,
    part: part.id,
    appointment: appointment.id,
    shift: shift.id,
    finding: finding.id,
    webhook: webhook.id,
  }
  shop.key = await newKey(org, user, SUBJECTS)
}

interface Resource {
  path: string
  id: keyof Shop['ids'] | string
  include?: string
  list: Handler
  get: Handler
  schema: z.ZodType
}
let RESOURCES: Resource[] = []

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  dataRoot = await mkdtemp(path.join(tmpdir(), 'api-read-'))
  process.env.DATA_ROOT = dataRoot
  ;({ db } = await import('@/lib/db'))
  keys = await import('@/features/public-api/Lib/keys.server')
  ;({ resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit'))
  const route = async (p: string) => (await import(`@/app/api/v1/${p}/route`)) as { GET: Handler }
  const s = {
    customers: await import('@/features/public-api/Schema/customers'),
    vehicles: await import('@/features/public-api/Schema/vehicles'),
    workOrders: await import('@/features/public-api/Schema/workOrders'),
    quotes: await import('@/features/public-api/Schema/quotes'),
    inspections: await import('@/features/public-api/Schema/inspections'),
    staff: await import('@/features/public-api/Schema/staff'),
    catalog: await import('@/features/public-api/Schema/catalog'),
    schedule: await import('@/features/public-api/Schema/schedule'),
    records: await import('@/features/public-api/Schema/records'),
  }
  const r = async (
    p: string,
    id: string,
    schema: z.ZodType,
    include?: string
  ): Promise<Resource> => ({
    path: p,
    id,
    include,
    schema,
    list: (await route(p)).GET,
    get: (await route(`${p}/[id]`)).GET,
  })
  RESOURCES = [
    await r('customers', 'customer', s.customers.customerSchema, 'contacts,customFields'),
    await r('vehicles', 'vehicle', s.vehicles.vehicleSchema, 'notes,customFields'),
    await r(
      'work-orders',
      'workOrder',
      s.workOrders.workOrderSchema,
      'jobs,lines,concerns,payments,attachments,timeEntries,meta,customFields'
    ),
    await r('quotes', 'quote', s.quotes.quoteSchema, 'jobs,lines,customFields'),
    await r('inspections', 'inspection', s.inspections.inspectionSchema, 'items'),
    await r('technicians', 'technician', s.staff.technicianSchema),
    await r('work-order-statuses', 'status', s.staff.workOrderStatusSchema),
    await r('labor-presets', 'preset', s.catalog.laborPresetSchema),
    await r('inventory-parts', 'part', s.catalog.inventoryPartSchema),
    await r('appointments', 'appointment', s.schedule.appointmentSchema),
    await r('time-entries', 'timeEntry', s.schedule.timeEntrySchema),
    await r('shifts', 'shift', s.schedule.shiftSchema),
    await r('payments', 'payment', s.records.paymentSchema),
    await r('findings', 'finding', s.records.findingSchema),
    await r('webhooks', 'webhook', s.records.webhookSchema),
  ]
  await seed(A, 'Alpha')
  await seed(B, 'Bravo')
})

beforeEach(() => resetKeyBudgets())

afterAll(async () => {
  if (db) {
    if (created.orgs.length)
      await db.organization.deleteMany({ where: { id: { in: created.orgs } } })
    if (created.users.length) await db.user.deleteMany({ where: { id: { in: created.users } } })
  }
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT
  else process.env.DATA_ROOT = previousDataRoot
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
})

describe('every list and get, for a key of each workshop', () => {
  it('serves its own workshop’s records in their published shape, and another’s as not found', async () => {
    expect(RESOURCES).toHaveLength(15)
    for (const res of RESOURCES) {
      for (const [me, other] of [
        [A, B],
        [B, A],
      ] as const) {
        const include = res.include ? `?include=${res.include}` : ''
        const list = await call(res.list, me.key, `/${res.path}${include}`)
        expect(list.status, `${res.path} list`).toBe(200)
        const body = (await list.json()) as { data: { id: string }[]; meta: unknown }
        const ids = body.data.map((d) => d.id)
        expect(ids, res.path).toContain(me.ids[res.id])
        expect(ids, res.path).not.toContain(other.ids[res.id])
        for (const item of body.data) expect(res.schema.parse(item), res.path).toEqual(item)
        expect(body.meta).toEqual({ hasMore: false, nextCursor: null })

        const own = await call(res.get, me.key, `/${res.path}/${me.ids[res.id]}${include}`, {
          id: me.ids[res.id],
        })
        expect(own.status, `${res.path} get`).toBe(200)
        expect(own.headers.get('ETag')).toMatch(/^"[\w-]+"$/)
        const one = (await own.json()) as { data: unknown }
        expect(res.schema.parse(one.data)).toEqual(one.data)

        const theirs = await call(res.get, me.key, `/${res.path}/${other.ids[res.id]}`, {
          id: other.ids[res.id],
        })
        expect(theirs.status, `${res.path} other workshop`).toBe(404)
      }
    }
  })

  it('never sends a webhook’s secret or a share token', async () => {
    for (const res of RESOURCES) {
      const include = res.include ? `?include=${res.include}` : ''
      const text = await (await call(res.list, A.key, `/${res.path}${include}`)).text()
      expect(text, res.path).not.toContain('whsec_sentinel')
      expect(text, res.path).not.toContain('publicToken')
    }
  })

  it('serves the includes asked for, and refuses one it doesn’t know', async () => {
    const workOrders = RESOURCES.find((r) => r.path === 'work-orders') as Resource
    const body = (await (
      await call(
        workOrders.get,
        A.key,
        `/work-orders/${A.ids.workOrder}?include=lines,customFields`,
        {
          id: A.ids.workOrder,
        }
      )
    ).json()) as { data: Record<string, unknown> }
    const lines = body.data.lines as { kind: string; sourceExtra: unknown }[]
    expect(lines.map((l) => l.kind).sort()).toEqual(['labor', 'part'])
    // One malformed key in sourceExtra costs that key, not the line's whole record.
    expect(lines.find((l) => l.kind === 'labor')?.sourceExtra).toEqual({ remoteId: 'lab_1' })
    expect(body.data).not.toHaveProperty('payments')
    const unknown = await call(workOrders.list, A.key, '/work-orders?include=everything')
    expect(unknown.status).toBe(400)
  })
})

describe('filters and dates', () => {
  it('finds a customer’s work orders and quotes on their vehicle, not only those billed to them', async () => {
    const workOrders = RESOURCES.find((r) => r.path === 'work-orders') as Resource
    const quotes = RESOURCES.find((r) => r.path === 'quotes') as Resource
    // Seeded on the customer's vehicle, with no customer of their own (as the app writes them).
    expect(await db.serviceRecord.count({ where: { id: A.ids.workOrder, customerId: null } })).toBe(
      1
    )
    const ids = async (res: Resource, customerId: string) =>
      (
        (await (await call(res.list, A.key, `/${res.path}?customerId=${customerId}`)).json()) as {
          data: { id: string }[]
        }
      ).data.map((d) => d.id)
    expect(await ids(workOrders, A.ids.customer)).toEqual([A.ids.workOrder])
    expect(await ids(quotes, A.ids.customer)).toEqual([A.ids.quote])
    // Another workshop's customer: nothing of ours, nothing of theirs.
    expect(await ids(workOrders, B.ids.customer)).toEqual([])
  })

  it('gives calendar days on the workshop’s own clock, far from UTC', async () => {
    const workOrders = RESOURCES.find((r) => r.path === 'work-orders') as Resource
    const quotes = RESOURCES.find((r) => r.path === 'quotes') as Resource
    const get = async (res: Resource, shop: Shop, id: string) =>
      (
        (await (await call(res.get, shop.key, `/${res.path}/${id}`, { id })).json()) as {
          data: Record<string, unknown>
        }
      ).data
    expect(await get(workOrders, A, A.ids.workOrder)).toMatchObject({
      invoiceDate: '2025-03-14T11:00:00.000Z',
      invoiceDay: '2025-03-15',
      invoiceDueDay: '2025-03-29',
    })
    expect(await get(quotes, A, A.ids.quote)).toMatchObject({ validUntilDay: '2025-04-02' })
    // The same instants in a workshop on UTC are the 14th and the 28th.
    expect(await get(workOrders, B, B.ids.workOrder)).toMatchObject({
      invoiceDay: '2025-03-14',
      invoiceDueDay: '2025-03-28',
    })
  })

  it('refuses a parameter it doesn’t know, rather than ignoring it and listing everything', async () => {
    const appointments = RESOURCES.find((r) => r.path === 'appointments') as Resource
    const response = await call(appointments.list, A.key, '/appointments?technicianId=x')
    expect(response.status).toBe(400)
  })
})

describe('nested reads and the attachment download', () => {
  const nested = (p: string) => import(`@/app/api/v1/${p}/route`) as Promise<{ GET: Handler }>

  it('answer for the key’s own workshop in their published shape, and not found for another’s', async () => {
    const common = await import('@/features/public-api/Schema/common')
    const customers = await import('@/features/public-api/Schema/customers')
    const records = await import('@/features/public-api/Schema/records')
    const workOrders = await import('@/features/public-api/Schema/workOrders')
    const cases: [string, keyof Shop['ids'], z.ZodType][] = [
      ['customers/[id]/contacts', 'customer', customers.customerContactSchema],
      ['work-orders/[id]/jobs', 'workOrder', common.jobSchema],
      ['work-orders/[id]/lines', 'workOrder', common.lineSchema],
      ['work-orders/[id]/payments', 'workOrder', records.paymentSchema],
      ['work-orders/[id]/attachments', 'workOrder', workOrders.attachmentSchema],
    ]
    for (const [p, id, schema] of cases) {
      const { GET } = await nested(p)
      const own = await call(GET, A.key, `/${p}`, { id: A.ids[id] })
      expect(own.status, p).toBe(200)
      const items = ((await own.json()) as { data: unknown[] }).data
      expect(items.length, p).toBeGreaterThan(0)
      for (const item of items) expect(schema.parse(item), p).toEqual(item)
      expect((await call(GET, A.key, `/${p}`, { id: B.ids[id] })).status, p).toBe(404)
    }
  })

  it('streams an attachment’s file only from its own work order in its own workshop', async () => {
    const { GET } = await nested('work-orders/[id]/attachments/[attachmentId]/content')
    const own = await call(GET, A.key, '/content', {
      id: A.ids.workOrder,
      attachmentId: A.ids.attachment,
    })
    expect(own.status).toBe(200)
    expect(own.headers.get('Content-Type')).toBe('text/plain')
    expect(own.headers.get('Content-Disposition')).toContain('report.txt')
    expect(await own.text()).toBe('file of Alpha')
    const theirs = await call(GET, A.key, '/content', {
      id: B.ids.workOrder,
      attachmentId: B.ids.attachment,
    })
    expect(theirs.status).toBe(404)
    // Their attachment under our work order's id: still not found.
    const mixed = await call(GET, A.key, '/content', {
      id: A.ids.workOrder,
      attachmentId: B.ids.attachment,
    })
    expect(mixed.status).toBe(404)
  })
})

describe('permissions', () => {
  it('refuse a key whose role can’t read the subject, with 403', async () => {
    const key = await newKey(A.org, A.owner, ['vehicles'])
    const customers = RESOURCES.find((r) => r.path === 'customers') as Resource
    const vehicles = RESOURCES.find((r) => r.path === 'vehicles') as Resource
    expect((await call(customers.list, key, '/customers')).status).toBe(403)
    expect((await call(vehicles.list, key, '/vehicles')).status).toBe(200)
  })

  it('apply to every endpoint: a key that may read none of them is refused by all', async () => {
    const key = await newKey(A.org, A.owner, ['dashboard'])
    for (const res of RESOURCES) {
      expect((await call(res.list, key, `/${res.path}`)).status, `${res.path} list`).toBe(403)
      const id = A.ids[res.id]
      expect((await call(res.get, key, `/${res.path}/${id}`, { id })).status, res.path).toBe(403)
    }
    const nestedCases: [string, Record<string, string>][] = [
      ['customers/[id]/contacts', { id: A.ids.customer }],
      ['work-orders/[id]/jobs', { id: A.ids.workOrder }],
      ['work-orders/[id]/lines', { id: A.ids.workOrder }],
      ['work-orders/[id]/payments', { id: A.ids.workOrder }],
      ['work-orders/[id]/attachments', { id: A.ids.workOrder }],
      [
        'work-orders/[id]/attachments/[attachmentId]/content',
        { id: A.ids.workOrder, attachmentId: A.ids.attachment },
      ],
    ]
    for (const [p, params] of nestedCases) {
      const { GET } = (await import(`@/app/api/v1/${p}/route`)) as { GET: Handler }
      expect((await call(GET, key, `/${p}`, params)).status, p).toBe(403)
    }
  })
})

describe('paging and sync', () => {
  it('walks 500 records, each one once unless it changed during the walk, then again with its new state', async () => {
    const shop = { org: '', owner: '' }
    shop.org = (await db.organization.create({ data: { name: `Paging ${stamp}` } })).id
    shop.owner = (
      await db.user.create({ data: { email: `paging-${stamp}@example.com`, name: 'Owner' } })
    ).id
    created.orgs.push(shop.org)
    created.users.push(shop.owner)
    await db.organizationMember.create({
      data: { organizationId: shop.org, userId: shop.owner, role: 'owner' },
    })
    await db.customer.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({
        organizationId: shop.org,
        userId: shop.owner,
        name: `Paged ${String(i).padStart(3, '0')}`,
      })),
    })
    const all = await db.customer.findMany({
      where: { organizationId: shop.org },
      select: { id: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    })
    const key = await newKey(shop.org, shop.owner, ['customers'])
    const customers = RESOURCES.find((r) => r.path === 'customers') as Resource
    const seen: string[] = []
    const names = new Map<string, string>()
    const changed = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 40; page++) {
      const query = `/customers?limit=37${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const body = (await (await call(customers.list, key, query)).json()) as {
        data: { id: string; name: string }[]
        meta: { hasMore: boolean; nextCursor: string | null }
      }
      for (const c of body.data) {
        seen.push(c.id)
        names.set(c.id, c.name)
      }
      // During the walk, one record already read and one not yet read change.
      if (page === 2) {
        for (const id of [all[5].id, all[400].id]) {
          await db.customer.update({ where: { id }, data: { name: `Changed ${id}` } })
          changed.add(id)
        }
      }
      if (!body.meta.hasMore) break
      cursor = body.meta.nextCursor
    }
    const counts = new Map<string, number>()
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1)
    expect(counts.size).toBe(500)
    for (const [id, n] of counts) if (!changed.has(id)) expect(n, id).toBe(1)
    // API.md §3: the one already read comes round again with its new state; the one not yet read is read once.
    expect(counts.get(all[5].id)).toBe(2)
    expect(counts.get(all[400].id)).toBe(1)
    for (const id of changed) expect(names.get(id)).toBe(`Changed ${id}`)
  })

  it('lists only what changed since a moment with updatedSince', async () => {
    const vehicles = RESOURCES.find((r) => r.path === 'vehicles') as Resource
    // A vehicle that doesn't change: without the filter, it would be listed too.
    const unchanged = await db.vehicle.create({
      data: { organizationId: A.org, userId: A.owner, make: 'Still', model: 'Same', year: 2001 },
    })
    const since = new Date(Date.now() + 1000)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await db.vehicle.update({ where: { id: A.ids.vehicle }, data: { color: 'Red' } })
    const body = (await (
      await call(vehicles.list, A.key, `/vehicles?updatedSince=${since.toISOString()}`)
    ).json()) as { data: { id: string; color: string }[] }
    expect(body.data.map((v) => v.id)).toEqual([A.ids.vehicle])
    expect(body.data.map((v) => v.id)).not.toContain(unchanged.id)
    expect(body.data[0].color).toBe('Red')
  })
})
