/**
 * fork (A6, docs/fork/milestones/A6-hardening.md task 2) on a real PostgreSQL (`npm run test:db`): contract tests from
 * the OpenAPI document's own list of endpoints (`RESOURCES` in `Lib/openapi.ts`, what `openapi.json` is built from).
 * For every endpoint, property-based (fast-check) requests: query parameters made from its query schema (valid values
 * and junk), path ids (a real record of the workshop, or junk), and JSON bodies made from its body schema's field
 * names (valid-looking and junk values). Whatever is sent, nothing answers 500, and a success's `data` validates
 * against the endpoint's documented response. A key with full access; its own workshop, removed again. SYNTHETIC data.
 */
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
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
let resetKeyBudgets: () => void
let A: Shop

type Endpoint = import('@/features/public-api/Lib/openapi').EndpointSpec
let endpoints: Endpoint[] = []

/** Runs per endpoint: enough to wander, few enough for the suite. */
const RUNS = Number(process.env.CONTRACT_RUNS ?? 8)

/** A real record of the workshop for each path parameter, by the folder it follows. */
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

/** A JSON schema's view of a zod schema, as the request would be written (before transforms). */
function jsonSchemaOf(schema: z.ZodType | undefined): {
  properties?: Record<string, { enum?: unknown[]; type?: string; format?: string }>
} {
  if (!schema) return {}
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as never
  } catch {
    return {}
  }
}

/** A value for one field: what its schema allows, often, and junk, sometimes. */
function valueFor(prop: { enum?: unknown[]; type?: string; format?: string }) {
  const junk = fc.oneof(
    fc.string({ maxLength: 12 }),
    fc.integer({ min: -5, max: 1_000_000 }),
    fc.constant(''),
    fc.constant(null)
  )
  const fitting: fc.Arbitrary<unknown>[] = []
  if (prop.enum?.length) fitting.push(fc.constantFrom(...prop.enum))
  if (prop.format === 'date-time') {
    fitting.push(
      fc
        .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
        .map((d) => d.toISOString())
    )
  }
  if (prop.type === 'boolean') fitting.push(fc.boolean())
  if (prop.type === 'number' || prop.type === 'integer')
    fitting.push(fc.integer({ min: 0, max: 500 }))
  if (prop.type === 'string') fitting.push(fc.string({ minLength: 1, maxLength: 20 }))
  return fitting.length
    ? fc.oneof({ weight: 3, arbitrary: fc.oneof(...fitting) }, { weight: 1, arbitrary: junk })
    : junk
}

/** Query parameters from the endpoint's query schema: each one there or not; all as strings, as a URL has them. */
function queryFor(endpoint: Endpoint): fc.Arbitrary<Record<string, string>> {
  const props = jsonSchemaOf(endpoint.query).properties ?? {}
  const keys = Object.keys(props)
  if (keys.length === 0) return fc.constant({})
  return fc
    .record(Object.fromEntries(keys.map((k) => [k, valueFor(props[k])])), { requiredKeys: [] })
    .map((q) =>
      Object.fromEntries(
        Object.entries(q)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => [k, String(v)])
      )
    )
}

/** A JSON body with the endpoint's field names (and now and then one it doesn't know). */
function bodyFor(endpoint: Endpoint): fc.Arbitrary<unknown> {
  const props = jsonSchemaOf(endpoint.body).properties ?? {}
  const keys = Object.keys(props)
  const known = keys.length
    ? fc.record(Object.fromEntries(keys.map((k) => [k, valueFor(props[k])])), { requiredKeys: [] })
    : fc.constant({})
  return fc.oneof(
    { weight: 4, arbitrary: known },
    { weight: 1, arbitrary: fc.object({ maxDepth: 1 }) }
  )
}

/** Path ids: the workshop's own record (so successes happen), or junk. */
function idsFor(endpoint: Endpoint): fc.Arbitrary<Record<string, string>> {
  const segments = endpoint.path.split('/').filter(Boolean)
  const names: [string, string][] = []
  segments.forEach((segment, i) => {
    const m = /^\{(\w+)\}$/.exec(segment)
    if (m) names.push([m[1], ID_OF[segments[i - 1]] ?? ''])
  })
  if (names.length === 0) return fc.constant({})
  return fc.record(
    Object.fromEntries(
      names.map(([param, kind]) => [
        param,
        fc.oneof(
          { weight: 3, arbitrary: fc.constant(A.ids[kind] ?? 'none') },
          { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 30 }) }
        ),
      ])
    )
  )
}

/** The route module of an OpenAPI path: `/customers/{id}/contacts` → `customers/[id]/contacts`. */
const routeOf = (path: string) => path.replace(/^\//, '').replace(/\{(\w+)\}/g, '[$1]')

async function seed(shop: Shop) {
  const { org, owner, ids } = shop
  ids.customer = (
    await db.customer.create({
      data: { organizationId: org, userId: owner, name: 'Contract Customer' },
    })
  ).id
  ids.contact = (
    await db.customerContact.create({
      data: {
        organizationId: org,
        customerId: ids.customer,
        kind: 'email',
        value: 'c@example.com',
      },
    })
  ).id
  ids.vehicle = (
    await db.vehicle.create({
      data: {
        organizationId: org,
        userId: owner,
        customerId: ids.customer,
        make: 'M',
        model: 'N',
        year: 2020,
      },
    })
  ).id
  ids.technician = (await db.technician.create({ data: { organizationId: org, name: 'Tech' } })).id
  ids.workOrder = (
    await db.serviceRecord.create({
      data: {
        organizationId: org,
        title: 'Contract job',
        vehicleId: ids.vehicle,
        status: 'pending',
      },
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
        startedAt: new Date(Date.now() - 3_600_000),
        endedAt: new Date(),
        durationMinutes: 60,
        source: 'app',
      },
    })
  ).id
  ids.shift = (
    await db.technicianShift.create({
      data: {
        organizationId: org,
        technicianId: ids.technician,
        clockIn: new Date(Date.now() - 3_600_000),
      },
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
      data: { organizationId: org, name: 'Contract status', stage: 'pending' },
    })
  ).id
  const template = await db.inspectionTemplate.create({
    data: { organizationId: org, name: 'Template' },
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
  ;({ resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit'))
  endpoints = (await import('@/features/public-api/Lib/openapi')).RESOURCES.flat()
  A = await newShop('A6contract')
  await seed(A)
}, 120_000)

afterAll(async () => {
  await removeCreated()
})

describe('the API against its OpenAPI document', () => {
  it('has endpoints to test, each with a route module and its method', async () => {
    expect(endpoints.length).toBeGreaterThan(50)
    for (const e of endpoints) {
      const module = (await route(routeOf(e.path))) as Record<string, Handler | undefined>
      expect(module[e.method.toUpperCase()], `${e.method} ${e.path}`).toBeTypeOf('function')
    }
  })

  // Found by the property test below: an emptied login reached the database as a user id.
  it('takes an emptied technician login as no login', async () => {
    resetKeyBudgets()
    const { PATCH } = await route('technicians/[id]')
    const response = await call(PATCH, A.key, 'PATCH', `/technicians/${A.ids.technician}`, {
      params: { id: A.ids.technician },
      body: { userId: '' },
    })
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ userId: null })
  })

  it('takes an emptied customer invoice design as the default', async () => {
    resetKeyBudgets()
    const { POST } = await route('customers')
    const made = await call(POST, A.key, 'POST', '/customers', {
      body: { name: 'Design Default', invoiceDesignId: '' },
    })
    expect(made.status).toBe(201)
    const id = (await made.json()).data.id as string
    resetKeyBudgets()
    const { PATCH } = await route('customers/[id]')
    const changed = await call(PATCH, A.key, 'PATCH', `/customers/${id}`, {
      params: { id },
      body: { invoiceDesignId: '' },
    })
    expect(changed.status).toBe(200)
  })

  it('never answers 500, and every success matches its documented response', async () => {
    const problems: string[] = []
    let requests = 0
    const validated = new Set<string>()
    // Deletes last: until then, the records they'd remove are there for everything else.
    const ordered = [...endpoints].sort(
      (a, b) => Number(a.method === 'delete') - Number(b.method === 'delete')
    )
    for (const e of ordered) {
      // An upload is multipart (tested in the write tests); its JSON-only junk would only meet the 415/400 path.
      if (e.bodyContentType && e.bodyContentType !== 'application/json') continue
      const handler = ((await route(routeOf(e.path))) as Record<string, Handler>)[
        e.method.toUpperCase()
      ]
      const success = e.status ?? 200
      // A read asked plainly (the workshop's own records, no query) must succeed and match: so every read's schema is
      // checked, however few runs the random part gets.
      if (e.method === 'get' && !e.contentType) {
        resetKeyBudgets()
        const own: Record<string, string> = {}
        const segments = e.path.split('/').filter(Boolean)
        segments.forEach((segment, i) => {
          const m = /^\{(\w+)\}$/.exec(segment)
          if (m) own[m[1]] = A.ids[ID_OF[segments[i - 1]] ?? ''] ?? 'none'
        })
        const plain = await call(
          handler,
          A.key,
          'GET',
          e.path.replace(/\{(\w+)\}/g, (_, p: string) => own[p]),
          { params: own }
        )
        const json = plain.status === success ? ((await plain.json()) as { data: unknown }) : null
        const schema = e.paged ? z.array(e.response) : e.response
        if (json && schema.safeParse(json.data).success) validated.add(`${e.method} ${e.path}`)
        else
          problems.push(`${e.method} ${e.path}: asked plainly, ${plain.status} or not its schema`)
      }
      await fc.assert(
        fc.asyncProperty(idsFor(e), queryFor(e), bodyFor(e), async (params, query, body) => {
          resetKeyBudgets()
          requests++
          const pathname = e.path.replace(/\{(\w+)\}/g, (_, p: string) =>
            encodeURIComponent(params[p])
          )
          const search = new URLSearchParams(query).toString()
          const response = await call(
            handler,
            A.key,
            e.method.toUpperCase(),
            `${pathname}${search ? `?${search}` : ''}`,
            {
              params,
              ...(e.method === 'post' || e.method === 'patch' ? { body } : {}),
            }
          )
          if (response.status >= 500) {
            problems.push(
              `${e.method} ${e.path}: ${response.status} for ${JSON.stringify({ params, query, body })}`
            )
            return
          }
          if (response.status !== success || e.contentType) return
          const json = (await response.json()) as { data: unknown }
          const schema = e.paged ? z.array(e.response) : e.response
          const parsed = schema.safeParse(json.data)
          if (parsed.success) validated.add(`${e.method} ${e.path}`)
          if (!parsed.success) {
            problems.push(
              `${e.method} ${e.path}: the ${success} answer doesn't match its schema: ${parsed.error.issues
                .slice(0, 2)
                .map((i) => `${i.path.join('.')} ${i.message}`)
                .join('; ')}`
            )
          }
        }),
        { numRuns: RUNS }
      )
    }
    expect(problems).toEqual([])
    // It tested something: requests to every endpoint, and a success checked against its schema on every read.
    expect(requests).toBeGreaterThanOrEqual(endpoints.length * RUNS * 0.9)
    const reads = endpoints.filter((e) => e.method === 'get' && !e.contentType)
    expect(reads.filter((e) => !validated.has(`${e.method} ${e.path}`)).map((e) => e.path)).toEqual(
      []
    )
  }, 600_000)
})
