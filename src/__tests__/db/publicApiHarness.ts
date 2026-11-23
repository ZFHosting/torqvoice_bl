/**
 * fork: what the public API's write tests on PostgreSQL share (A4): workshops with an owner, keys with a role, a
 * catch-all webhook, and calling a route handler with a key the way a client would. SYNTHETIC data.
 */
import { randomUUID } from 'node:crypto'

export const stamp = randomUUID().slice(0, 8)

export function guardTestDatabase() {
  const url = process.env.E2E_DATABASE_URL ?? ''
  const name = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
  if (url && !/test|e2e/.test(name)) {
    throw new Error(
      `Refusing to use database "${name}": its name must say test or e2e, like the rest of this suite.`
    )
  }
  process.env.DATABASE_URL = url
  process.env.API_KEY_PEPPER = 'db-test-pepper-that-is-long-enough'
  return url
}

export type Handler = (
  request: Request,
  ctx: { params: Promise<Record<string, string>> }
) => Promise<Response>

export interface Shop {
  org: string
  owner: string
  key: string
  ids: Record<string, string>
}

export const created = { orgs: [] as string[], users: [] as string[] }

/** Every subject the write endpoints ask for, each with every action. */
export const ALL_SUBJECTS = [
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

async function db() {
  return (await import('@/lib/db')).db
}

export async function newKey(
  org: string,
  owner: string,
  permissions: { action: string; subject: string }[]
): Promise<string> {
  const store = await db()
  const keys = await import('@/features/public-api/Lib/keys.server')
  const role = await store.role.create({
    data: {
      organizationId: org,
      name: `Role ${randomUUID().slice(0, 6)}`,
      permissions: { create: permissions },
    },
  })
  const made = await keys.createApiKey({
    organizationId: org,
    name: `key ${randomUUID().slice(0, 6)}`,
    roleId: role.id,
    createdById: owner,
  })
  const row = await store.apiKey.findUniqueOrThrow({ where: { id: made.id } })
  created.users.push(row.serviceUserId)
  return made.key
}

export const everything = () =>
  ALL_SUBJECTS.flatMap((subject) =>
    ['create', 'read', 'update', 'delete'].map((action) => ({ action, subject }))
  )

/** A workshop with an owner, a full-access key, and a webhook that takes every event. */
export async function newShop(name: string): Promise<Shop> {
  const store = await db()
  const org = (await store.organization.create({ data: { name: `${name} ${stamp}` } })).id
  const owner = (
    await store.user.create({
      data: { email: `${name.toLowerCase()}-${stamp}@example.com`, name: `Owner ${name}` },
    })
  ).id
  created.orgs.push(org)
  created.users.push(owner)
  await store.organizationMember.create({
    data: { organizationId: org, userId: owner, role: 'owner' },
  })
  await store.webhook.create({
    data: {
      organizationId: org,
      createdById: owner,
      name: 'Everything',
      url: 'https://hooks.example.test/all',
      secret: 'x'.repeat(32),
      events: JSON.stringify(['*']),
      isActive: true,
    },
  })
  const key = await newKey(org, owner, everything())
  return { org, owner, key, ids: {} }
}

export async function removeCreated() {
  const store = await db()
  if (created.orgs.length)
    await store.organization.deleteMany({ where: { id: { in: created.orgs } } })
  if (created.users.length) await store.user.deleteMany({ where: { id: { in: created.users } } })
}

export function request(
  key: string,
  method: string,
  pathAndQuery: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  return new Request(`http://localhost/api/v1${pathAndQuery}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'x-real-ip': '203.0.113.21',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
}

export async function call(
  handler: Handler,
  key: string,
  method: string,
  path: string,
  options: {
    params?: Record<string, string>
    body?: unknown
    headers?: Record<string, string>
  } = {}
) {
  return handler(request(key, method, path, options.body, options.headers), {
    params: Promise.resolve(options.params ?? {}),
  })
}

/** The route module of a path under src/app/api/v1. */
export async function route(path: string) {
  return (await import(`@/app/api/v1/${path}/route`)) as Record<
    'GET' | 'POST' | 'PATCH' | 'DELETE',
    Handler
  >
}

/** Audit events and webhook deliveries of a workshop with this action, after the dispatcher has had a moment. */
export async function eventsOf(org: string, action: string) {
  const store = await db()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const audits = await store.auditLog.findMany({
    where: { organizationId: org, action },
    select: { entity: true, entityId: true, userId: true },
  })
  const deliveries = await store.webhookDelivery.count({
    where: { webhook: { organizationId: org }, event: action },
  })
  return { audits, deliveries }
}
