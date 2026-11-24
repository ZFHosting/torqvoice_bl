/**
 * fork: the public API's customer and vehicle writes on a real PostgreSQL (`npm run test:db`;
 * docs/fork/milestones/A4-write-endpoints.md, Acceptance), through the real route handlers, keys and services.
 *
 * Creating a customer through the API gives the same row, audit event and webhook delivery as the app's own
 * action. A PATCH changes only what it sends and honours `If-Match`; a DELETE leaves a tombstone; a POST with an
 * Idempotency-Key replays rather than repeats; and nothing reaches another workshop's records, a vehicle moved
 * onto another workshop's customer included. Its own workshops, removed again. SYNTHETIC data.
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

/** Who is signed in when the app's own action runs, for the parity check. */
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

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  ;({ resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit'))
  A = await newShop('WriteAlpha')
  B = await newShop('WriteBravo')
  B.ids.customer = (
    await db.customer.create({ data: { organizationId: B.org, userId: B.owner, name: 'Theirs' } })
  ).id
  B.ids.vehicle = (
    await db.vehicle.create({
      data: { organizationId: B.org, userId: B.owner, make: 'M', model: 'N', year: 2019 },
    })
  ).id
})

afterAll(async () => {
  if (db) await removeCreated()
})

const customerFields = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+15555550111',
  company: 'Analytical Engines',
  notes: 'Prefers mornings',
}

describe('creating a customer', () => {
  it('makes the same customer, audit event and webhook delivery as the app’s own action', async () => {
    resetKeyBudgets()
    const { POST } = await route('customers')
    const response = await call(POST, A.key, 'POST', '/customers', { body: customerFields })
    expect(response.status).toBe(201)
    expect(response.headers.get('ETag')).toMatch(/^"/)
    const { data } = (await response.json()) as { data: { id: string; name: string } }
    const { customerSchema } = await import('@/features/public-api/Schema/customers')
    expect(customerSchema.parse(data)).toEqual(data)

    const viaApi = await db.customer.findUniqueOrThrow({ where: { id: data.id } })
    const apiEvents = await eventsOf(A.org, 'customer.create')

    // The same input through the app, signed in as the owner.
    who.userId = A.owner
    who.organizationId = A.org
    const { createCustomer } = await import('@/features/customers/Actions/customerActions')
    const viaApp = await createCustomer({ ...customerFields, name: 'Ada Lovelace (app)' })
    expect(viaApp.success).toBe(true)
    const appRow = await db.customer.findUniqueOrThrow({
      where: { id: (viaApp.data as { id: string }).id },
    })
    const fields = (row: typeof viaApi) => ({
      email: row.email,
      phone: row.phone,
      company: row.company,
      notes: row.notes,
      taxExempt: row.taxExempt,
      reminderOptOut: row.reminderOptOut,
      organizationId: row.organizationId,
    })
    expect(fields(viaApi)).toEqual(fields(appRow))

    const all = await eventsOf(A.org, 'customer.create')
    expect(all.audits).toHaveLength(2)
    expect(all.audits.map((a) => a.entity)).toEqual(['Customer', 'Customer'])
    expect(apiEvents.audits[0]).toMatchObject({ entity: 'Customer', entityId: data.id })
    // One delivery each to the workshop's catch-all webhook, as from the UI.
    expect(apiEvents.deliveries).toBe(1)
    expect(all.deliveries).toBe(2)
  })

  it('says which field is wrong, and creates nothing', async () => {
    resetKeyBudgets()
    const before = await db.customer.count({ where: { organizationId: A.org } })
    const { POST } = await route('customers')
    const response = await call(POST, A.key, 'POST', '/customers', { body: { email: 'x' } })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; details: { path: string }[] } }
    expect(body.error.code).toBe('invalid_request')
    expect(body.error.details.map((d) => d.path)).toContain('name')
    expect(await db.customer.count({ where: { organizationId: A.org } })).toBe(before)
  })
})

describe('changing and deleting a customer', () => {
  it('changes only the fields sent, and refuses a stale If-Match with 412', async () => {
    resetKeyBudgets()
    const { POST } = await route('customers')
    const made = (await (
      await call(POST, A.key, 'POST', '/customers', { body: customerFields })
    ).json()) as { data: { id: string } }
    const id = made.data.id
    const one = await route('customers/[id]')
    const read = await call(one.GET, A.key, 'GET', `/customers/${id}`, { params: { id } })
    const etag = read.headers.get('ETag') as string

    const changed = await call(one.PATCH, A.key, 'PATCH', `/customers/${id}`, {
      params: { id },
      body: { phone: '+15555550199' },
      headers: { 'if-match': etag },
    })
    expect(changed.status).toBe(200)
    const after = (await changed.json()) as { data: Record<string, unknown> }
    expect(after.data).toMatchObject({
      phone: '+15555550199',
      name: customerFields.name,
      email: customerFields.email,
      company: customerFields.company,
    })
    expect((await eventsOf(A.org, 'customer.update')).audits.map((a) => a.entityId)).toContain(id)

    // The tag read before the change is stale now.
    const stale = await call(one.PATCH, A.key, 'PATCH', `/customers/${id}`, {
      params: { id },
      body: { phone: '+15555550100' },
      headers: { 'if-match': etag },
    })
    expect(stale.status).toBe(412)
    expect((await db.customer.findUniqueOrThrow({ where: { id } })).phone).toBe('+15555550199')
  })

  it('deletes with a tombstone, and the record is gone', async () => {
    resetKeyBudgets()
    const { POST } = await route('customers')
    const made = (await (
      await call(POST, A.key, 'POST', '/customers', { body: { name: 'Short lived' } })
    ).json()) as { data: { id: string } }
    const id = made.data.id
    const one = await route('customers/[id]')
    const response = await call(one.DELETE, A.key, 'DELETE', `/customers/${id}`, { params: { id } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { id, deleted: true } })
    expect(await db.customer.count({ where: { id } })).toBe(0)
    expect(await db.deletedRecord.count({ where: { organizationId: A.org, entityId: id } })).toBe(1)
    expect((await eventsOf(A.org, 'customer.delete')).audits.map((a) => a.entityId)).toContain(id)
  })
})

describe('an Idempotency-Key on POST', () => {
  it('replays the first answer for the same request, and refuses a different one with 409', async () => {
    resetKeyBudgets()
    const { POST } = await route('customers')
    const before = await db.customer.count({ where: { organizationId: A.org } })
    const headers = { 'idempotency-key': `create-once-${Date.now()}` }
    const body = { name: 'Only once' }
    const first = await call(POST, A.key, 'POST', '/customers', { body, headers })
    const again = await call(POST, A.key, 'POST', '/customers', { body, headers })
    expect(first.status).toBe(201)
    expect(again.status).toBe(201)
    expect(again.headers.get('Idempotent-Replayed')).toBe('true')
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(
      ((await first.json()) as { data: { id: string } }).data.id
    )
    expect(await db.customer.count({ where: { organizationId: A.org } })).toBe(before + 1)
    const other = await call(POST, A.key, 'POST', '/customers', {
      body: { name: 'Something else' },
      headers,
    })
    expect(other.status).toBe(409)
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe(
      'idempotency_conflict'
    )
  })
})

describe('another workshop’s records', () => {
  it('can’t be changed or deleted: 404, and they stay as they were', async () => {
    resetKeyBudgets()
    const customer = await route('customers/[id]')
    const vehicle = await route('vehicles/[id]')
    const id = B.ids.customer
    expect(
      (
        await call(customer.PATCH, A.key, 'PATCH', `/customers/${id}`, {
          params: { id },
          body: { name: 'Hijacked' },
        })
      ).status
    ).toBe(404)
    expect(
      (await call(customer.DELETE, A.key, 'DELETE', `/customers/${id}`, { params: { id } })).status
    ).toBe(404)
    const vid = B.ids.vehicle
    expect(
      (
        await call(vehicle.PATCH, A.key, 'PATCH', `/vehicles/${vid}`, {
          params: { id: vid },
          body: { color: 'Black' },
        })
      ).status
    ).toBe(404)
    expect(
      (await call(vehicle.DELETE, A.key, 'DELETE', `/vehicles/${vid}`, { params: { id: vid } }))
        .status
    ).toBe(404)
    expect((await db.customer.findUniqueOrThrow({ where: { id } })).name).toBe('Theirs')
    expect(await db.vehicle.count({ where: { id: vid } })).toBe(1)
  })

  it('can’t own a vehicle: filing one under another workshop’s customer is a 404', async () => {
    resetKeyBudgets()
    const { POST } = await route('vehicles')
    const before = await db.vehicle.count({ where: { organizationId: A.org } })
    const made = await call(POST, A.key, 'POST', '/vehicles', {
      body: { make: 'Make', model: 'Model', year: 2021, customerId: B.ids.customer },
    })
    expect(made.status).toBe(404)
    expect(await db.vehicle.count({ where: { organizationId: A.org } })).toBe(before)

    // And moving one of ours onto their customer.
    const ours = (await (
      await call(POST, A.key, 'POST', '/vehicles', {
        body: { make: 'Make', model: 'Model', year: 2021, mileage: 12000 },
      })
    ).json()) as { data: { id: string } }
    const one = await route('vehicles/[id]')
    const moved = await call(one.PATCH, A.key, 'PATCH', `/vehicles/${ours.data.id}`, {
      params: { id: ours.data.id },
      body: { customerId: B.ids.customer },
    })
    expect(moved.status).toBe(404)
    const row = await db.vehicle.findUniqueOrThrow({ where: { id: ours.data.id } })
    expect(row.customerId).toBeNull()
    // A PATCH that changes the colour leaves the reading as it was.
    const painted = await call(one.PATCH, A.key, 'PATCH', `/vehicles/${ours.data.id}`, {
      params: { id: ours.data.id },
      body: { color: 'Red' },
    })
    expect(painted.status).toBe(200)
    expect(await db.vehicle.findUniqueOrThrow({ where: { id: ours.data.id } })).toMatchObject({
      color: 'Red',
      mileage: 12000,
    })
  })
})

describe('a customer’s other emails and phones', () => {
  it('are added, changed and removed (with a tombstone), each with its audit event', async () => {
    resetKeyBudgets()
    const customer = (
      await db.customer.create({
        data: { organizationId: A.org, userId: A.owner, name: 'Contacts' },
      })
    ).id
    const list = await route('customers/[id]/contacts')
    const one = await route('customers/[id]/contacts/[contactId]')
    const made = await call(list.POST, A.key, 'POST', `/customers/${customer}/contacts`, {
      params: { id: customer },
      body: { kind: 'email', value: 'second@example.com', label: 'Work' },
    })
    expect(made.status).toBe(201)
    const contact = ((await made.json()) as { data: { id: string; value: string } }).data
    expect(contact.value).toBe('second@example.com')

    const changed = await call(one.PATCH, A.key, 'PATCH', '/contact', {
      params: { id: customer, contactId: contact.id },
      body: { label: 'Home' },
    })
    expect(changed.status).toBe(200)
    expect(await db.customerContact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject(
      {
        label: 'Home',
        value: 'second@example.com',
        kind: 'email',
      }
    )

    const gone = await call(one.DELETE, A.key, 'DELETE', '/contact', {
      params: { id: customer, contactId: contact.id },
    })
    expect(gone.status).toBe(200)
    expect(await db.customerContact.count({ where: { id: contact.id } })).toBe(0)
    expect(
      await db.deletedRecord.count({
        where: { organizationId: A.org, entityType: 'customer_contact', entityId: contact.id },
      })
    ).toBe(1)
    for (const action of ['contact.create', 'contact.update', 'contact.delete']) {
      expect(
        (await eventsOf(A.org, action)).audits.map((a) => a.entityId),
        action
      ).toContain(contact.id)
    }
  })

  it('refuse a bad email, and another workshop’s customer or contact with 404', async () => {
    resetKeyBudgets()
    const list = await route('customers/[id]/contacts')
    const one = await route('customers/[id]/contacts/[contactId]')
    const ours = (
      await db.customer.create({ data: { organizationId: A.org, userId: A.owner, name: 'Ours' } })
    ).id
    const bad = await call(list.POST, A.key, 'POST', '/contacts', {
      params: { id: ours },
      body: { kind: 'email', value: 'not an email' },
    })
    expect(bad.status).toBe(400)
    const theirs = await call(list.POST, A.key, 'POST', '/contacts', {
      params: { id: B.ids.customer },
      body: { kind: 'phone', value: '+15555550123' },
    })
    expect(theirs.status).toBe(404)
    expect(await db.customerContact.count({ where: { customerId: B.ids.customer } })).toBe(0)
    const theirContact = await db.customerContact.create({
      data: { organizationId: B.org, customerId: B.ids.customer, kind: 'phone', value: '+1555' },
    })
    expect(
      (
        await call(one.PATCH, A.key, 'PATCH', '/c', {
          params: { id: B.ids.customer, contactId: theirContact.id },
          body: { value: '+1999' },
        })
      ).status
    ).toBe(404)
    // Their contact under our customer's id: still not found.
    expect(
      (
        await call(one.DELETE, A.key, 'DELETE', '/c', {
          params: { id: ours, contactId: theirContact.id },
        })
      ).status
    ).toBe(404)
    expect(
      (await db.customerContact.findUniqueOrThrow({ where: { id: theirContact.id } })).value
    ).toBe('+1555')
  })
})

describe('a JSON body past the limit (A6, SECURITY-REVIEW.md item 7)', () => {
  it('is a 413 and writes nothing, with or without a Content-Length', async () => {
    resetKeyBudgets()
    const { POST } = await route('customers')
    const { MAX_JSON_BYTES } = await import('@/features/public-api/Lib/writeRoute')
    const before = await db.customer.count({ where: { organizationId: A.org } })
    const big = JSON.stringify({ name: 'Too long', notes: 'x'.repeat(MAX_JSON_BYTES) })
    const said = await POST(
      new Request('http://localhost/api/v1/customers', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${A.key}`,
          'content-type': 'application/json',
          'content-length': String(big.length),
        },
        body: big,
      }),
      { params: Promise.resolve({}) }
    )
    expect(said.status).toBe(413)
    const streamed = await POST(
      new Request('http://localhost/api/v1/customers', {
        method: 'POST',
        headers: { authorization: `Bearer ${A.key}`, 'content-type': 'application/json' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big))
            controller.close()
          },
        }),
        duplex: 'half',
      } as RequestInit),
      { params: Promise.resolve({}) }
    )
    expect(streamed.status).toBe(413)
    expect(await db.customer.count({ where: { organizationId: A.org } })).toBe(before)
  })
})

