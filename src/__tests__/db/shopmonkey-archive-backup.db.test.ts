/**
 * fork: the import archive in a backup, on a real PostgreSQL (`npm run test:db`; M3 acceptance).
 *
 * An archive larger than the data file a restore will read into memory is written to its own file and
 * restored from it; restoring the same backup twice leaves one row per source object; a backup from
 * before M3 (the archive inside data.json) still restores; and a backup that lost its archive file keeps
 * the workshop's archive instead of wiping it.
 *
 * Its own workshop, removed again; it empties nothing. SYNTHETIC payloads.
 */
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.E2E_DATABASE_URL ?? ''
const databaseName = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
if (url && !/test|e2e/.test(databaseName)) {
  throw new Error(
    `Refusing to use database "${databaseName}": its name must say test or e2e, like the rest of this suite.`
  )
}
process.env.DATABASE_URL = url
// The smallest data file the server will read: the archive below is larger than it.
process.env.BACKUP_MAX_DATA_FILE_MB = '16'

const stamp = randomUUID().slice(0, 8)
const ROWS = 9_000
const FILLER = 'x'.repeat(2_000)

let db: typeof import('@/lib/db')['db']
let importCore: typeof import('@/lib/backup/import')
let buildData: typeof import('@/lib/backup/build-data')
let archiveCore: typeof import('@/lib/backup/fork-archive')
let limits: typeof import('@/lib/backup/limits')
let organizationId = ''
let userId = ''
let folder = ''

async function seedArchive() {
  for (let start = 0; start < ROWS; start += 1_000) {
    await db.sourceRecord.createMany({
      data: Array.from({ length: Math.min(1_000, ROWS - start) }, (_, i) => {
        const n = start + i
        return {
          organizationId,
          connectionId: `conn-${stamp}`,
          source: 'shopmonkey',
          table: 'order',
          remoteId: `syn_ord_${stamp}_${n}`,
          payload: { id: `syn_ord_${stamp}_${n}`, number: String(n), note: FILLER },
          payloadHash: `hash-${n}`,
          childrenHash: n % 2 ? `hash-${n}` : null,
        }
      }),
    })
  }
}

/** A backup on disk, as the scheduled engine stages one: data.json and the archive beside it. */
async function stageBackup(dir: string) {
  const dataFile = path.join(dir, 'data.json')
  const archiveFile = path.join(dir, archiveCore.SOURCE_ARCHIVE_FILE)
  const data = createWriteStream(dataFile)
  await buildData.writeBackupData(
    organizationId,
    { ...buildData.DEFAULT_OPTIONS, files: false, includeSecrets: true },
    data
  )
  data.end()
  await finished(data)
  const lines = createWriteStream(archiveFile)
  const { rows: written } = await archiveCore.writeSourceArchive(organizationId, () => lines)
  lines.end()
  await finished(lines)
  return { dataFile, archiveFile, written }
}

const archiveCount = () => db.sourceRecord.count({ where: { organizationId } })

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  importCore = await import('@/lib/backup/import')
  buildData = await import('@/lib/backup/build-data')
  archiveCore = await import('@/lib/backup/fork-archive')
  limits = await import('@/lib/backup/limits')

  organizationId = (await db.organization.create({ data: { name: `Archive ${stamp}` } })).id
  const owner = await db.user.create({
    data: { email: `archive-owner-${stamp}@example.com`, name: 'Owner' },
  })
  userId = owner.id
  await db.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
  await seedArchive()
  folder = await mkdtemp(path.join(tmpdir(), `archive-${stamp}-`))
})

afterAll(async () => {
  if (folder) await rm(folder, { recursive: true, force: true })
  if (!db) return
  if (organizationId) await db.organization.deleteMany({ where: { id: organizationId } })
  if (userId) await db.user.deleteMany({ where: { id: userId } })
})

describe('a workshop whose import archive is larger than the data file a restore reads', () => {
  it('backs it up in its own file and restores every row from it, twice over', async () => {
    const { dataFile, archiveFile, written } = await stageBackup(folder)
    expect(written).toBe(ROWS)
    // The data file stays small enough to restore; the archive alone is over the limit.
    expect((await stat(dataFile)).size).toBeLessThan(limits.maxDataFileBytes())
    expect((await stat(archiveFile)).size).toBeGreaterThan(limits.maxDataFileBytes())

    const before = await db.sourceRecord.findFirst({
      where: { organizationId, remoteId: `syn_ord_${stamp}_7` },
    })
    for (let i = 0; i < 2; i++) {
      await importCore.restoreFromDisk(
        { organizationId, userId },
        { dataFile, filesDir: null, archiveFile }
      )
      expect(await archiveCount()).toBe(ROWS)
    }
    const after = await db.sourceRecord.findFirst({
      where: { organizationId, remoteId: `syn_ord_${stamp}_7` },
    })
    expect(after).toMatchObject({
      id: before?.id,
      payload: before?.payload,
      payloadHash: before?.payloadHash,
      childrenHash: before?.childrenHash,
      connectionId: `conn-${stamp}`,
    })
  })

  it('keeps the workshop’s archive when the backup came without its archive file', async () => {
    const dir = await mkdtemp(path.join(folder, 'no-archive-'))
    const { dataFile } = await stageBackup(dir)
    await db.sourceRecord.deleteMany({ where: { organizationId, remoteId: `syn_ord_${stamp}_0` } })
    await importCore.restoreFromDisk({ organizationId, userId }, { dataFile, filesDir: null })
    expect(await archiveCount()).toBe(ROWS - 1)
  })

  it('still restores a backup from before M3, with the archive inside data.json', async () => {
    const dir = await mkdtemp(path.join(folder, 'old-'))
    const rows = await db.sourceRecord.findMany({
      where: { organizationId },
      take: 3,
      orderBy: { id: 'asc' },
    })
    const { dataFile } = await stageBackup(dir)
    const { readJsonFile } = await import('@/lib/backup/zip-file')
    const backup = await readJsonFile<{ data: Record<string, unknown> }>(dataFile)
    backup.data.sourceRecords = rows
    const oldFile = path.join(dir, 'old-data.json')
    await writeFile(oldFile, JSON.stringify(backup))
    await importCore.restoreFromDisk(
      { organizationId, userId },
      { dataFile: oldFile, filesDir: null }
    )
    expect(await archiveCount()).toBe(3)
  })
})
