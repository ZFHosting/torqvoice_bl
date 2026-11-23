/**
 * fork: the files a load brings over, on a real PostgreSQL and a real disk (`npm run test:db`; M5 task 7). The
 * extract stages them with the real stager into a data folder of the test's own (the links answered by a fake
 * download); the load places them where the upload route keeps uploads and attaches them: the order's file, the
 * original invoice PDF (off the printed invoice), the inspection's photo. The staged copies are removed once
 * placed, and a second load attaches nothing twice. An inspection that changes later keeps its photo from uploads;
 * a file gone from both places is reported, downloaded again by the next extract, and attached by the next load.
 * SYNTHETIC fixtures.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let load: typeof import('@/integrations/shopmonkey/load/run')
let workshop: Awaited<ReturnType<typeof createWorkshop>>
let dataRoot = ''
let mock: ReturnType<typeof createMockShopmonkey>
let stager: import('@/integrations/shopmonkey/extract/files').FileStager
const previousDataRoot = process.env.DATA_ROOT

/** A download of a link: a few bytes of the type its extension says. */
function download(link: URL): Promise<IncomingMessage> {
  const type = link.pathname.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'
  const stream = Readable.from([
    Buffer.from(`bytes of ${link.pathname}`),
  ]) as unknown as IncomingMessage
  stream.statusCode = 200
  stream.headers = { 'content-type': type }
  return Promise.resolve(stream)
}

const run = () =>
  load.runLoad({
    organizationId: workshop.organizationId,
    connectionId: workshop.connectionId,
    runUserId: workshop.userId,
    now: NOW,
  })

/** A URL the upload route would hand out → the file on disk. */
const onDisk = (fileUrl: string) => {
  const prefix = `/api/protected/files/${workshop.organizationId}/services/`
  expect(fileUrl.startsWith(prefix), fileUrl).toBe(true)
  return path.join(
    dataRoot,
    'uploads',
    workshop.organizationId,
    'services',
    fileUrl.slice(prefix.length)
  )
}

async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await filesUnder(full)))
    else out.push(full)
  }
  return out
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  dataRoot = await mkdtemp(path.join(tmpdir(), 'shopmonkey-files-'))
  process.env.DATA_ROOT = dataRoot
  ;({ db } = await import('@/lib/db'))
  load = await import('@/integrations/shopmonkey/load/run')
  workshop = await createWorkshop('Files')
  const { createFileStager } = await import('@/integrations/shopmonkey/extract/files')
  stager = createFileStager({
    connectionId: workshop.connectionId,
    root: dataRoot,
    open: download,
    check: async () => ({ ok: true }),
  })
  mock = createMockShopmonkey()
  await extractInto(mock, workshop, stager)
})

afterAll(async () => {
  if (workshop) await workshop.remove()
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT
  else process.env.DATA_ROOT = previousDataRoot
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
})

describe('the files a load brings over', () => {
  it('places and attaches every staged file, and removes the staged copies', async () => {
    const stagingDir = path.join(dataRoot, 'shopmonkey-staging', workshop.connectionId)
    const staged = await filesUnder(stagingDir)
    expect(staged.length).toBeGreaterThan(0)

    const summary = await run()
    expect(summary.failures).toEqual([])

    const invoice = await db.serviceRecord.findFirstOrThrow({
      where: { organizationId: workshop.organizationId, invoiceNumber: '1003' },
      select: { attachments: true },
    })
    const printout = invoice.attachments.find((a) => a.fileName === 'alignment-printout.pdf')
    expect(printout).toMatchObject({ fileType: 'application/pdf', description: null })
    const original = invoice.attachments.find((a) => a.category === 'document')
    expect(original).toMatchObject({
      description: 'Original Shopmonkey invoice',
      includeInInvoice: false,
      fileType: 'application/pdf',
    })
    for (const a of invoice.attachments)
      expect(existsSync(onDisk(a.fileUrl)), a.fileName).toBe(true)

    const brakes = await db.inspectionItem.findFirstOrThrow({
      where: { inspection: { organizationId: workshop.organizationId }, name: 'Brakes' },
      select: { imageUrls: true },
    })
    expect(brakes.imageUrls).toHaveLength(1)
    expect(existsSync(onDisk(brakes.imageUrls[0]))).toBe(true)

    // Every staged copy that was placed is gone; what's left wasn't anyone's to place.
    const left = await filesUnder(stagingDir)
    expect(left.length).toBeLessThan(staged.length)
    const urls = [...invoice.attachments.map((a) => a.fileUrl), ...brakes.imageUrls]
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('attaches nothing twice on a second load, with the staged copies gone', async () => {
    const before = await db.serviceAttachment.count({
      where: { serviceRecord: { organizationId: workshop.organizationId } },
    })
    const uploads = await filesUnder(path.join(dataRoot, 'uploads'))
    const summary = await run()
    expect(summary.failures).toEqual([])
    expect(
      await db.serviceAttachment.count({
        where: { serviceRecord: { organizationId: workshop.organizationId } },
      })
    ).toBe(before)
    expect(await filesUnder(path.join(dataRoot, 'uploads'))).toHaveLength(uploads.length)
  })

  it('keeps an inspection’s photo when the inspection changes later, from the copy in uploads', async () => {
    const before = await db.inspectionItem.findFirstOrThrow({
      where: { inspection: { organizationId: workshop.organizationId }, name: 'Brakes' },
      select: { imageUrls: true },
    })
    mock.change('inspection', 'syn_ins_1', { note: 'Changed after the first load' })
    await extractInto(mock, workshop, stager)
    const summary = await run()
    expect(summary.failures).toEqual([])
    expect(summary.counts.inspection.updated).toBe(1)
    expect(summary.warnings.file_missing ?? 0).toBe(0)
    const after = await db.inspectionItem.findFirstOrThrow({
      where: { inspection: { organizationId: workshop.organizationId }, name: 'Brakes' },
      select: { imageUrls: true },
    })
    expect(after.imageUrls).toEqual(before.imageUrls)
    expect(existsSync(onDisk(after.imageUrls[0]))).toBe(true)
  })

  it('reports a file gone from disk, and attaches it again after the next extract downloads it', async () => {
    const { undoLoad } = await import('@/integrations/shopmonkey/load/undo')
    const runs = await db.importBatch.findMany({
      where: { organizationId: workshop.organizationId, status: 'completed' },
      select: { fileName: true },
    })
    for (const runId of new Set(
      runs.map((r) => r.fileName?.replace('Shopmonkey import ', '') ?? '')
    ))
      await undoLoad({ ...workshop, runId })
    // Whatever the undo left in uploads is gone too: neither copy of any file is left.
    await rm(path.join(dataRoot, 'uploads'), { recursive: true, force: true })

    const reload = await run()
    expect(reload.failures).toEqual([])
    expect(reload.warnings.file_missing).toBeGreaterThanOrEqual(3)
    const bare = await db.serviceRecord.findFirstOrThrow({
      where: { organizationId: workshop.organizationId, invoiceNumber: '1003' },
      select: { attachments: true },
    })
    expect(bare.attachments).toEqual([])
    const forgotten = await db.sourceRecord.findFirstOrThrow({
      where: {
        organizationId: workshop.organizationId,
        table: 'order_file',
        remoteId: 'syn_ofl_1',
      },
      select: { payloadHash: true },
    })
    expect(forgotten.payloadHash).toBe('')

    await extractInto(mock, workshop, stager)
    const again = await run()
    expect(again.failures).toEqual([])
    expect(again.warnings.file_missing ?? 0).toBe(0)
    const invoice = await db.serviceRecord.findFirstOrThrow({
      where: { organizationId: workshop.organizationId, invoiceNumber: '1003' },
      select: { attachments: true },
    })
    expect(invoice.attachments.map((a) => a.fileName).sort()).toEqual(
      ['Shopmonkey invoice syn_ord_1003.pdf', 'alignment-printout.pdf'].sort()
    )
    for (const a of invoice.attachments)
      expect(existsSync(onDisk(a.fileUrl)), a.fileName).toBe(true)
    const brakes = await db.inspectionItem.findFirstOrThrow({
      where: { inspection: { organizationId: workshop.organizationId }, name: 'Brakes' },
      select: { imageUrls: true },
    })
    expect(brakes.imageUrls).toHaveLength(1)
    expect(existsSync(onDisk(brakes.imageUrls[0]))).toBe(true)
  })
})
