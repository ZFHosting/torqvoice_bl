/**
 * @vitest-environment node
 *
 * fork: the import archive's own backup file (M3): written page by page, one row per line; restored in
 * batches, stamped with the restoring workshop, refusing another workshop's ids and a damaged line; and
 * a backup without the file never clears the workshop's archive. The database round trip is in
 * src/__tests__/db/shopmonkey-archive-backup.db.test.ts.
 */
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

import {
  archiveInZip,
  restoreSourceArchive,
  SOURCE_ARCHIVE_FILE,
  settleArchiveKey,
  writeSourceArchive,
} from '@/lib/backup/fork-archive'
import { RestoreRefusedError } from '@/lib/backup/tenancy'

const row = (n: number, organizationId = 'org-old') => ({
  id: `sr_${String(n).padStart(5, '0')}`,
  organizationId,
  connectionId: 'conn-1',
  source: 'shopmonkey',
  table: 'order',
  remoteId: `syn_ord_${n}`,
  payload: { id: `syn_ord_${n}` },
  payloadHash: `h${n}`,
  childrenHash: null,
  remoteUpdatedAt: '2025-01-01T00:00:00.000Z',
  remoteDeletedAt: null,
  fetchedAt: '2025-01-02T00:00:00.000Z',
  createdAt: '2025-01-02T00:00:00.000Z',
  updatedAt: '2025-01-02T00:00:00.000Z',
})

function txWith(foreign: string[] = []) {
  const created: Record<string, unknown>[][] = []
  const tx = {
    sourceRecord: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => foreign.includes(id)).map((id) => ({ id }))
      ),
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        created.push(data)
        return { count: data.length }
      }),
    },
  }
  return { tx, created }
}

const lines = (text: string) => ({ open: async () => Readable.from([text]) })

describe('writing the archive', () => {
  it('writes every row of the workshop, one JSON line each, a page at a time', async () => {
    const all = Array.from({ length: 1_203 }, (_, i) => row(i))
    const findMany = vi.fn(
      async (args: {
        where: { organizationId: string }
        take: number
        cursor?: { id: string }
      }) => {
        const start = args.cursor ? all.findIndex((r) => r.id === args.cursor?.id) + 1 : 0
        return all.slice(start, start + args.take)
      }
    )
    const out = new PassThrough()
    let text = ''
    out.on('data', (chunk) => {
      text += chunk.toString()
    })
    const { rows: written } = await writeSourceArchive('org-1', () => out, {
      sourceRecord: { findMany },
    } as never)
    out.end()
    expect(written).toBe(1_203)
    expect(findMany).toHaveBeenCalledTimes(3)
    expect(findMany.mock.calls.every(([a]) => a.where.organizationId === 'org-1')).toBe(true)
    const parsed = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(parsed.map((r) => r.id)).toEqual(all.map((r) => r.id))
  })
})

describe('a workshop with no archive', () => {
  it('gets no archive file at all', async () => {
    const open = vi.fn(() => new PassThrough())
    const findMany = vi.fn(async () => [])
    expect(
      await writeSourceArchive('org-1', open, { sourceRecord: { findMany } } as never)
    ).toEqual({
      rows: 0,
      out: null,
    })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('restoring the archive', () => {
  it('inserts the rows in batches, as the restoring workshop’s', async () => {
    const { tx, created } = txWith()
    const text = `${Array.from({ length: 1_100 }, (_, i) => JSON.stringify(row(i))).join('\n')}\n\n`
    expect(await restoreSourceArchive(tx as never, lines(text), 'org-new')).toBe(1_100)
    expect(created.map((batch) => batch.length)).toEqual([500, 500, 100])
    expect(created.flat().every((r) => r.organizationId === 'org-new')).toBe(true)
    expect(created[0][0]).toMatchObject({
      id: 'sr_00000',
      remoteId: 'syn_ord_0',
      payload: { id: 'syn_ord_0' },
      remoteUpdatedAt: new Date('2025-01-01T00:00:00.000Z'),
    })
  })

  it('leaves out a line that isn’t a source record', async () => {
    const { tx, created } = txWith()
    const text = [JSON.stringify(row(1)), JSON.stringify({ id: 'x' }), '42'].join('\n')
    expect(await restoreSourceArchive(tx as never, lines(text), 'org-new')).toBe(1)
    expect(created.flat()).toHaveLength(1)
  })

  it('refuses the whole restore when a row’s id belongs to another workshop', async () => {
    const { tx } = txWith(['sr_00002'])
    const text = [1, 2, 3].map((n) => JSON.stringify(row(n))).join('\n')
    await expect(restoreSourceArchive(tx as never, lines(text), 'org-new')).rejects.toBeInstanceOf(
      RestoreRefusedError
    )
    expect(tx.sourceRecord.createMany).not.toHaveBeenCalled()
  })

  it('refuses a damaged file, naming the line', async () => {
    const { tx } = txWith()
    const text = `${JSON.stringify(row(1))}\n{"id": "sr_2", "pay`
    await expect(restoreSourceArchive(tx as never, lines(text), 'org-new')).rejects.toThrow(
      'line 2'
    )
  })
})

describe('a backup without the archive file', () => {
  it('says nothing about the archive, so the restore neither clears nor refills it', () => {
    const data: Record<string, unknown> = { sourceRecords: [] }
    settleArchiveKey(data, null)
    expect('sourceRecords' in data).toBe(false)
  })

  it('keeps the key when the file is there, or when the rows are in data.json (an older backup)', () => {
    const withFile: Record<string, unknown> = { sourceRecords: [] }
    settleArchiveKey(withFile, lines(''))
    expect(withFile.sourceRecords).toEqual([])
    const older: Record<string, unknown> = { sourceRecords: [row(1)] }
    settleArchiveKey(older, null)
    expect(older.sourceRecords).toHaveLength(1)
  })

  it('finds the archive in an uploaded zip only when it is there', () => {
    const entry = { name: SOURCE_ARCHIVE_FILE }
    const zip = {
      find: (name: string) => (name === SOURCE_ARCHIVE_FILE ? entry : undefined),
      open: vi.fn(),
    }
    expect(archiveInZip(zip as never)).not.toBeNull()
    expect(archiveInZip({ ...zip, find: () => undefined } as never)).toBeNull()
    expect(archiveInZip(null)).toBeNull()
  })
})
