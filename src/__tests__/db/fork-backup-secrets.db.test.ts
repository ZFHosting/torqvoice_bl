/**
 * fork: a backup never carries a public API key's hash or a stored API response, on a real
 * PostgreSQL (`npm run test:db`). The unit test (lib/backup/fork-backup.test.ts) checks the export
 * code never asks for them; this checks the file it writes, with every option on and secrets
 * included, so a nested include that reached them would fail here.
 *
 * Its own workshop, removed again; it empties nothing.
 */
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.E2E_DATABASE_URL ?? ''
const databaseName = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
if (url && !/test|e2e/.test(databaseName)) {
  throw new Error(
    `Refusing to use database "${databaseName}": its name must say test or e2e, like the rest of this suite.`
  )
}
process.env.DATABASE_URL = url

const stamp = randomUUID().slice(0, 8)
const HASH_SENTINEL = `${'ab'.repeat(24)}${stamp}${stamp}`
const RESPONSE_SENTINEL = `stored-response-${stamp}`
const SERVICE_EMAIL = `api+sentinel${stamp}@invalid.local`

let db: typeof import('@/lib/db')['db']
let buildData: typeof import('@/lib/backup/build-data')
let organizationId = ''
const users: string[] = []

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  buildData = await import('@/lib/backup/build-data')

  organizationId = (await db.organization.create({ data: { name: `Secrets ${stamp}` } })).id
  const owner = await db.user.create({
    data: { email: `secrets-owner-${stamp}@example.com`, name: 'Owner' },
  })
  const service = await db.user.create({ data: { email: SERVICE_EMAIL, name: 'API: sentinel' } })
  users.push(owner.id, service.id)
  const role = await db.role.create({ data: { organizationId, name: 'API role' } })
  await db.organizationMember.createMany({
    data: [
      { organizationId, userId: owner.id, role: 'owner' },
      { organizationId, userId: service.id, role: 'member', roleId: role.id },
    ],
  })
  const key = await db.apiKey.create({
    data: {
      organizationId,
      name: 'sentinel',
      prefix: stamp,
      keyHash: HASH_SENTINEL,
      serviceUserId: service.id,
      createdById: owner.id,
    },
  })
  await db.apiIdempotencyKey.create({
    data: {
      organizationId,
      apiKeyId: key.id,
      key: `idem-${stamp}`,
      requestHash: 'x',
      responseStatus: 201,
      responseBody: { data: { note: RESPONSE_SENTINEL } },
    },
  })
})

afterAll(async () => {
  if (!db) return
  if (organizationId) await db.organization.deleteMany({ where: { id: organizationId } })
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
})

describe('a backup with everything ticked and secrets included', () => {
  it('carries no API key hash and no stored API response', async () => {
    const options = { ...buildData.DEFAULT_OPTIONS }
    for (const option of Object.keys(options) as (keyof typeof options)[]) {
      ;(options as Record<string, boolean>)[option] = true
    }
    const chunks: string[] = []
    const out = new PassThrough()
    out.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()))
    const written = await buildData.writeBackupData(
      organizationId,
      { ...options, includeSecrets: true },
      out
    )
    out.end()
    const text = chunks.join('')

    // The export ran to the end and wrote this workshop's data: the file parses, its role is in it.
    expect(() => JSON.parse(text)).not.toThrow()
    expect(written.rows).toBeGreaterThan(0)
    expect(text).toContain('"API role"')
    expect(text).not.toContain(HASH_SENTINEL)
    expect(text).not.toContain(RESPONSE_SENTINEL)
    expect(text).not.toContain('keyHash')
  })
})
