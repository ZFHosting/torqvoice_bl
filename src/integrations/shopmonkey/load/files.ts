/**
 * Files an import brings over (M5 task 7): staged files (M3) placed where the upload route keeps uploads,
 * `uploadsRoot()/<org>/services/<uuid>.<ext>` (names the file manager's `isGeneratedName` accepts, so the orphan
 * sweep looks after them), and attached: order files and original invoice PDFs as `ServiceAttachment`s,
 * inspection photos in their item's `imageUrls`.
 *
 * A file is copied into uploads inside its record's transaction and the staged copy removed only after the run,
 * so a record that rolls back still has its file next time. A dry run copies nothing.
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
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
}

/** The staged file on a file record, when it was downloaded (`_staged` without `skipped`). */
export function stagedFile(payload: Row): StagedFileInfo | null {
  const s = payload._staged as Row | undefined
  if (!s || typeof s.path !== 'string' || typeof s.contentType !== 'string') return null
  return {
    path: s.path,
    bytes: typeof s.bytes === 'number' ? s.bytes : 0,
    contentType: s.contentType,
  }
}

/**
 * Staged copies a unit placed: kept for removal (`LoadContext.placedFiles`) only once the unit committed, so a
 * record that rolled back still finds its staged file next time.
 */
export type Placed = string[]

/** A staged file copied into the workshop's uploads; its URL as the upload route would return it. */
export async function placeFile(
  lc: LoadContext,
  file: StagedFileInfo,
  placed: Placed
): Promise<string> {
  const ext = EXTENSIONS[file.contentType] ?? 'bin'
  const name = `${randomUUID()}.${ext}`
  const url = `/api/protected/files/${lc.scope.organizationId}/services/${name}`
  if (lc.dryTx) return url
  const source = path.join(dataRoot(), ...file.path.split('/'))
  // The staged path is ours (files.ts), but a restored archive could carry anything: keep it under data/.
  if (!path.resolve(source).startsWith(path.resolve(dataRoot()) + path.sep)) {
    throw new Error('A staged file path leaves the data folder')
  }
  const folder = path.join(uploadsRoot(), lc.scope.organizationId, 'services')
  await mkdir(folder, { recursive: true })
  await copyFile(source, path.join(folder, name))
  placed.push(source)
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
    const fileUrl = await placeFile(lc, file, placed)
    const isPdf = record.table === 'invoice_pdf'
    const attachment = await tx.serviceAttachment.create({
      data: {
        serviceRecordId,
        fileUrl,
        fileName: isPdf
          ? `Shopmonkey invoice ${orderId}.pdf`
          : typeof payload.fileName === 'string' && payload.fileName
            ? payload.fileName
            : `${record.remoteId}`,
        fileType: file.contentType,
        fileSize: file.bytes,
        category: isPdf ? 'document' : 'diagnostic',
        // MAPPING §3: the original PDF keeps the exact historical document, off the printed invoice.
        description: isPdf ? 'Original Shopmonkey invoice' : null,
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
