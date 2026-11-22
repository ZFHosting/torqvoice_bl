/**
 * @vitest-environment node
 *
 * fork: how the BlueLabel fork's tables travel in a workshop backup (docs/fork/milestones/M1). The
 * round trip on a real database (src/__tests__/db/backup-round-trip.db.test.ts) seeds and compares
 * every column of these tables; this file pins the decisions around them: which tables a backup
 * carries, and that an API key, and so its hash, never reaches a backup file.
 */
import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findMany, apiKeyFindMany } = vi.hoisted(() => ({
  findMany: vi.fn().mockResolvedValue([]),
  apiKeyFindMany: vi.fn().mockResolvedValue([
    {
      id: 'key1',
      organizationId: 'org1',
      keyHash: 'hash-that-must-never-leave',
      prefix: 'abcd1234',
    },
  ]),
}))

vi.mock('@/lib/db', () => ({
  db: new Proxy(
    {},
    {
      get: (_target, model: string) => ({
        findMany: model === 'apiKey' || model === 'apiIdempotencyKey' ? apiKeyFindMany : findMany,
      }),
    }
  ),
}))

import { PassThrough } from 'node:stream'
import { BACKUP_DATASET_KEYS, DEFAULT_OPTIONS, writeBackupData } from '@/lib/backup/build-data'
import { BACKUP_ENTITIES, EXCLUDED_MODELS } from '@/lib/backup/manifest'

const FORK_BACKED_UP = [
  'SourceRecord',
  'WorkJob',
  'CustomerContact',
  'ServiceRecordMeta',
  'TechnicianShift',
  'DeletedRecord',
]

describe('the fork tables in a backup', () => {
  beforeEach(() => {
    findMany.mockClear()
    apiKeyFindMany.mockClear()
  })

  it('carries the import archive, jobs, contacts, order facts, shifts and tombstones', () => {
    const backedUp = new Set(BACKUP_ENTITIES.map((e) => e.model))
    for (const model of FORK_BACKED_UP) expect(backedUp.has(model), model).toBe(true)
    // A job belongs to a work order or a quote, and travels with whichever it is on.
    const jobParents = BACKUP_ENTITIES.filter((e) => e.model === 'WorkJob').map(
      (e) => e.nestedUnder
    )
    expect(jobParents.sort()).toEqual(['Quote', 'ServiceRecord'])
    expect(BACKUP_DATASET_KEYS).toEqual(expect.arrayContaining(['sourceRecords', 'deletedRecords']))
  })

  it('leaves API keys and idempotency records out, with a reason', () => {
    expect(EXCLUDED_MODELS.ApiKey).toMatch(/credential/i)
    expect(EXCLUDED_MODELS.ApiIdempotencyKey).toBeTruthy()
    const backedUp = new Set(BACKUP_ENTITIES.map((e) => e.model))
    expect(backedUp.has('ApiKey')).toBe(false)
    expect(backedUp.has('ApiIdempotencyKey')).toBe(false)
    expect(BACKUP_DATASET_KEYS.some((key) => /api/i.test(key))).toBe(false)
  })

  it('never reads an API key while writing a backup, so its hash cannot be in the file', async () => {
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on('data', (c) => chunks.push(Buffer.from(c)))
    await writeBackupData('org1', { ...DEFAULT_OPTIONS, includeSecrets: true }, out)
    const file = Buffer.concat(chunks).toString('utf-8')
    expect(apiKeyFindMany).not.toHaveBeenCalled()
    expect(file).not.toContain('hash-that-must-never-leave')
    expect(file).not.toContain('keyHash')
    const exportSource = fs.readFileSync('src/lib/backup/build-data.ts', 'utf-8')
    expect(exportSource).not.toMatch(/db\.apiKey|db\.apiIdempotencyKey/)
  })
})
