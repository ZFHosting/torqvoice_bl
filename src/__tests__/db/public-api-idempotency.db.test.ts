/**
 * fork: `Idempotency-Key` on the public API (docs/fork/API.md §3) on a real PostgreSQL, where the
 * unique index decides which of two requests with the same key runs. Its own workshop and key,
 * removed again.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

let db: typeof import('@/lib/db')['db']
let idem: typeof import('@/features/public-api/Lib/idempotency')
const scope = { organizationId: '', apiKeyId: '' }
const users: string[] = []

function post(key: string | null, body: string) {
  return new Request('http://localhost/api/v1/customers', {
    method: 'POST',
    headers: key ? { 'idempotency-key': key } : {},
    body,
  })
}

/** A handler that counts its runs and answers 201 with the run number. */
function counter() {
  let runs = 0
  return {
    get runs() {
      return runs
    },
    run: async () => {
      runs++
      return Response.json({ data: { run: runs } }, { status: 201 })
    },
  }
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  idem = await import('@/features/public-api/Lib/idempotency')
  const { createApiKey } = await import('@/features/public-api/Lib/keys.server')
  scope.organizationId = (await db.organization.create({ data: { name: `Idem ${stamp}` } })).id
  const owner = await db.user.create({
    data: { email: `idem-${stamp}@example.com`, name: 'Owner' },
  })
  users.push(owner.id)
  const role = await db.role.create({ data: { organizationId: scope.organizationId, name: 'API' } })
  const created = await createApiKey({
    organizationId: scope.organizationId,
    name: 'idempotency',
    roleId: role.id,
    createdById: owner.id,
  })
  scope.apiKeyId = created.id
  users.push((await db.apiKey.findUniqueOrThrow({ where: { id: created.id } })).serviceUserId)
})

afterAll(async () => {
  if (!db) return
  if (scope.organizationId) {
    await db.organization.deleteMany({ where: { id: scope.organizationId } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
})

describe('Idempotency-Key', () => {
  it('replays the first response to a repeat, without running it again', async () => {
    const handler = counter()
    const first = await idem.withIdempotency(post('k-1', '{"a":1}'), scope, '{"a":1}', handler.run)
    const again = await idem.withIdempotency(post('k-1', '{"a":1}'), scope, '{"a":1}', handler.run)
    expect(handler.runs).toBe(1)
    expect(first.status).toBe(201)
    expect(again.status).toBe(201)
    expect(await again.json()).toEqual({ data: { run: 1 } })
    expect(again.headers.get('Idempotent-Replayed')).toBe('true')
  })

  it('refuses the same key with a different body with 409 idempotency_conflict', async () => {
    const handler = counter()
    await idem.withIdempotency(post('k-2', '{"a":1}'), scope, '{"a":1}', handler.run)
    const other = await idem.withIdempotency(post('k-2', '{"a":2}'), scope, '{"a":2}', handler.run)
    expect(other.status).toBe(409)
    expect((await other.json()).error.code).toBe('idempotency_conflict')
    expect(handler.runs).toBe(1)
  })

  it('runs only one of two requests sent at once with the same key', async () => {
    const handler = counter()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = async () => {
      await gate
      return handler.run()
    }
    const first = idem.withIdempotency(post('k-3', '{}'), scope, '{}', slow)
    // Give the first request time to claim the key.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const second = await idem.withIdempotency(post('k-3', '{}'), scope, '{}', handler.run)
    release()
    expect((await first).status).toBe(201)
    expect(second.status).toBe(409)
    expect(handler.runs).toBe(1)
  })

  it('gives the key back when the request fails, so a retry runs', async () => {
    const failing = async () => Response.json({ error: { code: 'server_error' } }, { status: 500 })
    expect((await idem.withIdempotency(post('k-4', '{}'), scope, '{}', failing)).status).toBe(500)
    const handler = counter()
    expect((await idem.withIdempotency(post('k-4', '{}'), scope, '{}', handler.run)).status).toBe(
      201
    )
    expect(handler.runs).toBe(1)
  })

  it('frees a key whose request died mid-flight, once the claim is old enough', async () => {
    // What a crash leaves: a claim still in flight, never finished or given back.
    await db.apiIdempotencyKey.create({
      data: {
        organizationId: scope.organizationId,
        apiKeyId: scope.apiKeyId,
        key: 'k-6',
        requestHash: 'whatever',
        responseStatus: 0,
        responseBody: {},
        createdAt: new Date(Date.now() - idem.IN_FLIGHT_ABANDONED_MS - 60_000),
      },
    })
    const handler = counter()
    const retried = await idem.withIdempotency(post('k-6', '{}'), scope, '{}', handler.run)
    expect(retried.status).toBe(201)
    expect(handler.runs).toBe(1)
  })

  it('runs every request without a key', async () => {
    const handler = counter()
    await idem.withIdempotency(post(null, '{}'), scope, '{}', handler.run)
    await idem.withIdempotency(post(null, '{}'), scope, '{}', handler.run)
    expect(handler.runs).toBe(2)
  })

  it('forgets a response after 24 hours: the purge drops it and the key runs afresh', async () => {
    const handler = counter()
    await idem.withIdempotency(post('k-5', '{}'), scope, '{}', handler.run)
    // This test's own row made a day old, and the purge run at the real time: it never removes another test's
    // fresh rows from the shared database.
    await db.apiIdempotencyKey.updateMany({
      where: { apiKeyId: scope.apiKeyId, key: 'k-5' },
      data: { createdAt: new Date(Date.now() - idem.IDEMPOTENCY_TTL_MS - 60_000) },
    })
    expect(await idem.purgeExpiredIdempotencyKeys()).toBeGreaterThan(0)
    expect(
      await db.apiIdempotencyKey.count({ where: { apiKeyId: scope.apiKeyId, key: 'k-5' } })
    ).toBe(0)
    await idem.withIdempotency(post('k-5', '{}'), scope, '{}', handler.run)
    expect(handler.runs).toBe(2)
  })
})
