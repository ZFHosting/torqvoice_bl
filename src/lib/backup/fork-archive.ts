/**
 * fork: the import archive (`SourceRecord`, docs/fork/MAPPING.md X1) in a backup, in a file of its own
 * (M3, "Backups stay restorable with the archive in them").
 *
 * A Shopmonkey history of 50,000 orders is hundreds of megabytes of payloads, and a restore reads
 * `data.json` into memory whole and refuses one over 128 MiB (`limits.ts`). So the archive goes beside
 * it as `source-archive.ndjson`, one row per line, written page by page and restored line by line in
 * batches inside the restore's transaction: its size never counts against the data file's.
 *
 * `data.json` still carries `"sourceRecords": []` when the archive option is on: the restore clears
 * only the tables whose keys a backup carries (`clearPlanFor`), so the marker is what clears the
 * workshop's archive before the file refills it. A backup with the marker but no file (the workshop had
 * no archive, or the file was taken out by hand) says nothing about the archive, and the workshop's is
 * kept.
 */
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { Prisma } from '@/generated/prisma/client'
import { db, type TxClient } from '@/lib/db'
import { sourceRecordRow } from './fork-restore'
import { assertNoForeignRows } from './tenancy'
import type { OpenedZip } from './zip-file'

export const SOURCE_ARCHIVE_FILE = 'source-archive.ndjson'
const BATCH = 500

/**
 * The workshop's archive, one JSON row per line, in id order. The output is opened only once there is a
 * row to write, so a workshop that never imported anything gets no archive file (and a backup without
 * one never touches the archive on restore). Returns the rows written and the stream, which the caller
 * ends.
 */
export async function writeSourceArchive(
  organizationId: string,
  open: () => NodeJS.WritableStream,
  client: Pick<typeof db, 'sourceRecord'> = db
): Promise<{ rows: number; out: NodeJS.WritableStream | null }> {
  let cursor: string | undefined
  let rows = 0
  let out: NodeJS.WritableStream | null = null
  for (;;) {
    const page = await client.sourceRecord.findMany({
      where: { organizationId },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (page.length > 0) out ??= open()
    for (const row of page) {
      if (out && !out.write(`${JSON.stringify(row)}\n`)) {
        await once(out as NodeJS.EventEmitter, 'drain')
      }
      rows++
    }
    if (page.length < BATCH) return { rows, out }
    cursor = page[page.length - 1].id
  }
}

/** Where a backup's archive file is read from: a restored folder, or the uploaded zip. */
export interface SourceArchive {
  open(): Promise<Readable>
}

export function archiveFile(file: string): SourceArchive {
  return { open: async () => createReadStream(file) }
}

export function archiveInZip(zip: OpenedZip | null): SourceArchive | null {
  const entry = zip?.find(SOURCE_ARCHIVE_FILE)
  return zip && entry ? { open: () => zip.open(entry) } : null
}

/**
 * A backup whose `data.json` marks the archive as carried (an empty `sourceRecords`) but that came
 * without the file: the key is dropped, so the restore neither clears nor refills the archive.
 */
export function settleArchiveKey(data: Record<string, unknown>, archive: SourceArchive | null) {
  if (!archive && Array.isArray(data.sourceRecords) && data.sourceRecords.length === 0) {
    delete data.sourceRecords
  }
}

/**
 * The archive file's rows into the workshop, in batches, inside the restore's transaction (after the
 * clear, so restoring twice leaves one row per source object). Every row is stamped with the restoring
 * workshop, and an id that belongs to another workshop's row refuses the whole restore, as the rest of
 * the restore does (tenancy.ts). Returns the rows restored.
 */
export async function restoreSourceArchive(
  tx: TxClient,
  archive: SourceArchive,
  organizationId: string
): Promise<number> {
  const lines = createInterface({
    input: await archive.open(),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  let batch: Prisma.SourceRecordCreateManyInput[] = []
  let total = 0
  const flush = async () => {
    if (batch.length === 0) return
    const ids = new Set(batch.map((row) => row.id as string))
    await assertNoForeignRows(tx, organizationId, new Map([['SourceRecord', ids]]))
    await tx.sourceRecord.createMany({ data: batch })
    total += batch.length
    batch = []
  }
  let lineNumber = 0
  for await (const line of lines) {
    lineNumber++
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`The import archive in this backup is damaged (line ${lineNumber})`)
    }
    if (!parsed || typeof parsed !== 'object') continue
    const row = sourceRecordRow(parsed as Record<string, unknown>, organizationId)
    if (row) batch.push(row)
    if (batch.length >= BATCH) await flush()
  }
  await flush()
  return total
}
