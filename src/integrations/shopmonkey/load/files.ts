/**
 * Files an import brings over (M5 task 7): staged files (M3) placed where the upload route keeps uploads,
 * `uploadsRoot()/<org>/services/<uuid>.<ext>` (names the file manager's `isGeneratedName` accepts, so the orphan
 * sweep looks after them), and attached: order files and original invoice PDFs as `ServiceAttachment`s,
 * inspection photos in their item's `imageUrls`.
 *
 * A file is copied into uploads inside its record's transaction and the staged copy removed only after the run,
 * so a record that rolls back still has its file next time. A dry run copies nothing.
 *
 * A placed file's name comes from the workshop, the file's record and its content, so placing it again (an
 * inspection that changed rewrites its items) finds the copy already in uploads instead of the staged copy, which
 * is gone by then. A file with neither (removed by an undo, or by hand) is reported (`file_missing`) and forgotten
 * by the archive, so the next extract downloads it again and the next load attaches it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { dataRoot, uploadsRoot } from '@/lib/upload-root'
import { SOURCE } from '../extract/stage'
import type { Row } from '../transform/types'
import { clientOf, type LoadContext, type Tx } from './context'
import { findLoaded, markLoaded } from './links'

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

export interface StagedFileInfo {
  path: string
  bytes: number
  contentType: string
  sha256: string | null
}

/** The staged file on a file record, when it was downloaded (`_staged` without `skipped`). */
export function stagedFile(payload: Row): StagedFileInfo | null {
  const s = payload._staged as Row | undefined
  if (!s || typeof s.path !== 'string' || typeof s.contentType !== 'string') return null
  return {
    path: s.path,
    bytes: typeof s.bytes === 'number' ? s.bytes : 0,
    contentType: s.contentType,
    sha256: typeof s.sha256 === 'string' ? s.sha256 : null,
  }
}

/**
 * Staged copies a unit placed: kept for removal (`LoadContext.placedFiles`) only once the unit committed, so a
 * record that rolled back still finds its staged file next time.
 */
export type Placed = string[]

/** A staged file record: its table (`order_file`, `invoice_pdf`, `inspection_file`), id and payload. */
export interface FileRecord {
  table: string
  remoteId: string
  payload: Row
}

/** The placed file's name (without extension), UUID-shaped as `isGeneratedName` wants: the same for the same file. */
export function placedId(organizationId: string, record: FileRecord, file: StagedFileInfo): string {
  const h = createHash('sha256')
    .update(
      [
        organizationId,
        record.table,
        record.remoteId,
        file.sha256 ?? `${file.path}:${file.bytes}`,
      ].join('\u0000')
    )
    .digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** The record a file came with: the next extract fetches its files again (`childrenHash` cleared). */
function parentOf(record: FileRecord): { table: string; remoteId: string } | null {
  if (record.table === 'invoice_pdf') {
    return typeof record.payload.orderId === 'string'
      ? { table: 'order', remoteId: record.payload.orderId }
      : null
  }
  const parent = record.payload._parent as Row | undefined
  return typeof parent?.table === 'string' && typeof parent.remoteId === 'string'
    ? { table: parent.table, remoteId: parent.remoteId }
    : null
}

/** The archive forgets it has this file, so the next extract downloads it again. */
async function forgetFile(tx: Tx, lc: LoadContext, record: FileRecord): Promise<void> {
  const scope = { organizationId: lc.scope.organizationId, source: SOURCE }
  await tx.sourceRecord.updateMany({
    where: { ...scope, table: record.table, remoteId: record.remoteId },
    data: { payloadHash: '' },
  })
  const parent = parentOf(record)
  if (parent) {
    await tx.sourceRecord.updateMany({
      where: { ...scope, table: parent.table, remoteId: parent.remoteId },
      data: { childrenHash: null },
    })
  }
}

/**
 * A staged file in the workshop's uploads; its URL as the upload route would return it. Null when the record has
 * no staged file (skipped by the extract), or the file is gone from both places (reported and forgotten).
 */
export async function placeFile(
  tx: Tx,
  lc: LoadContext,
  record: FileRecord,
  placed: Placed
): Promise<string | null> {
  const file = stagedFile(record.payload)
  if (!file) return null
  const ext = EXTENSIONS[file.contentType] ?? 'bin'
  const name = `${placedId(lc.scope.organizationId, record, file)}.${ext}`
  const url = `/api/protected/files/${lc.scope.organizationId}/services/${name}`
  const source = path.join(dataRoot(), ...file.path.split('/'))
  // The staged path is ours (files.ts), but a restored archive could carry anything: keep it under data/.
  if (!path.resolve(source).startsWith(path.resolve(dataRoot()) + path.sep)) {
    throw new Error('A staged file path leaves the data folder')
  }
  const folder = path.join(uploadsRoot(), lc.scope.organizationId, 'services')
  const target = path.join(folder, name)
  const staged = existsSync(source)
  const inUploads = existsSync(target)
  if (!staged && !inUploads) {
    lc.warnings.push({
      code: 'file_missing',
      table: record.table,
      remoteId: record.remoteId,
      message: 'The staged file is gone; the next extract downloads it again.',
    })
    await forgetFile(tx, lc, record)
    return null
  }
  if (staged) placed.push(source)
  if (lc.dryTx || inUploads) return url
  await mkdir(folder, { recursive: true })
  // Whole or not at all: a copy cut short must not pass for the placed file next time.
  const part = `${target}.${randomUUID()}.part`
  await copyFile(source, part)
  await rename(part, target)
  return url
}

/** Removes the staged copies of files that loaded. */
export async function removePlaced(placed: Placed): Promise<void> {
  for (const file of placed) await rm(file, { force: true })
}

/** Every order's file records, by order id, built once (a JSON-path lookup per order would scan the table each time). */
export async function indexOrderFiles(lc: LoadContext): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  let cursor: string | undefined
  for (;;) {
    const page = await clientOf(lc).sourceRecord.findMany({
      where: {
        organizationId: lc.scope.organizationId,
        source: SOURCE,
        table: 'order_file',
        remoteDeletedAt: null,
      },
      orderBy: { id: 'asc' },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, remoteId: true, payload: true },
    })
    for (const r of page) {
      const parent = ((r.payload as Row)._parent as Row | undefined)?.remoteId
      if (typeof parent === 'string') out.set(parent, [...(out.get(parent) ?? []), r.remoteId])
    }
    if (page.length < 1000) return out
    cursor = page[page.length - 1].id
  }
}

/**
 * Attaches an order's staged files to its work order (MAPPING §3): order files as they are, the original invoice
 * PDF as a document kept off the printed invoice. Each once (linked), whatever reloads.
 */
export async function attachOrderFiles(
  tx: Tx,
  lc: LoadContext,
  orderId: string,
  fileIds: string[],
  serviceRecordId: string,
  placed: Placed
): Promise<number> {
  const scope = { organizationId: lc.scope.organizationId, source: SOURCE }
  const files = fileIds.length
    ? await tx.sourceRecord.findMany({
        where: { ...scope, table: 'order_file', remoteId: { in: fileIds } },
        select: { remoteId: true, payload: true, payloadHash: true },
      })
    : []
  const pdf = await tx.sourceRecord.findFirst({
    where: { ...scope, table: 'invoice_pdf', remoteId: orderId },
    select: { remoteId: true, payload: true, payloadHash: true },
  })
  let attached = 0
  const records = [
    ...files.map((f) => ({ ...f, table: 'order_file' as const })),
    ...(pdf ? [{ ...pdf, table: 'invoice_pdf' as const }] : []),
  ]
  for (const record of records) {
    const payload = record.payload as Row
    const file = stagedFile(payload)
    if (!file) continue
    if (await findLoaded(tx, lc.scope, record.table, 'ServiceAttachment', record.remoteId)) continue
    const fileUrl = await placeFile(tx, lc, { ...record, payload }, placed)
    if (!fileUrl) continue
    const isPdf = record.table === 'invoice_pdf'
    const attachment = await tx.serviceAttachment.create({
      data: {
        serviceRecordId,
        fileUrl,
        fileName: isPdf
          ? lc.label('Shopmonkey invoice {id}.pdf', { id: orderId })
          : typeof payload.fileName === 'string' && payload.fileName
            ? payload.fileName
            : `${record.remoteId}`,
        fileType: file.contentType,
        fileSize: file.bytes,
        category: isPdf ? 'document' : 'diagnostic',
        // MAPPING §3: the original PDF keeps the exact historical document, off the printed invoice.
        description: isPdf ? lc.label('Original Shopmonkey invoice') : null,
        includeInInvoice: !isPdf,
      },
      select: { id: true },
    })
    await markLoaded(tx, lc.scope, {
      table: record.table,
      model: 'ServiceAttachment',
      remoteId: record.remoteId,
      localId: attachment.id,
      hash: record.payloadHash,
      created: true,
    })
    attached++
  }
  return attached
}
