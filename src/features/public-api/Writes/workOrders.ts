/**
 * Work order writes (docs/fork/API.md §4): the work order itself (the services the actions run, A2), its status
 * (`POST /work-orders/{id}/status`, the work board's own path), and one line, one job or one payment at a time.
 * Each with the action's audit event; a line or a job changed is the work order changed (`service.update`).
 */
import 'server-only'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { jobEvent } from '@/features/fork-records/Lib/forkRecordAuditEvents'
import {
  createJobService,
  deleteJobService,
  updateJobService,
} from '@/features/fork-records/Lib/forkRecordServices.server'
import {
  createLineService,
  deleteLineService,
  lineChangedEvent,
  updateLineService,
} from '@/features/fork-records/Lib/lineService.server'
import { createPaymentEvent, deletePaymentEvent } from '@/features/payments/Lib/paymentAuditEvents'
import {
  createPaymentService,
  deletePaymentService,
} from '@/features/payments/Lib/paymentService.server'
import {
  createServiceRecordEvent,
  deleteServiceRecordEvent,
  updateServiceRecordEvent,
  updateServiceStatusEvent,
} from '@/features/vehicles/Lib/serviceRecordAuditEvents'
import {
  createServiceRecordService,
  deleteServiceAttachmentService,
  deleteServiceRecordService,
  updateServiceRecordService,
  updateServiceStatusService,
} from '@/features/vehicles/Lib/serviceRecordService.server'
import { retotalServiceRecord } from '@/features/vehicles/Lib/retotalServiceRecord'
import { addServiceAttachmentService } from '@/features/vehicles/Lib/serviceAttachmentService.server'
import { isRestoring, RestoreInProgressError } from '@/lib/backup/freeze'
import { db } from '@/lib/db'
import { discardUnsavedUpload } from '@/lib/files/manager'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { uploadsRoot } from '@/lib/upload-root'
import { queueVideoDownscale } from '@/lib/video-downscale'
import { isDeclaredVideo, NOT_A_VIDEO_MESSAGE, sniffDeclaredVideo } from '@/lib/video-sniff'
import { z } from 'zod'
import { publicApiError } from '../Lib/errors'
import { etagFor } from '../Lib/etag'
import { serializeContext } from '../Lib/serializeContext'
import { writeRoute } from '../Lib/writeRoute'
import { workOrdersResource } from '../Resources/workOrders'
import {
  LABOR_LINE_SELECT,
  PART_LINE_SELECT,
  serializeJob,
  serializeLaborLine,
  serializePartLine,
  JOB_SELECT,
} from '../Serializers/common'
import { PAYMENT_SELECT, serializePayment } from '../Serializers/records'
import { ATTACHMENT_SELECT, serializeAttachment } from '../Serializers/workOrders'
import { workOrderStatusBodySchema } from '../Schema/workOrders'
import { answerWith, deleted, withId } from './common'
import { documentBody, touchesMoney } from './documentBody'

const services = PermissionSubject.SERVICES
const update = { action: PermissionAction.UPDATE, subject: services }

/** The work order as it is now in the key's workshop: what `If-Match` on it, and on its children, is checked against. */
const currentWorkOrder = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.serviceRecord.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

/* ---------- the work order ---------- */

export const createWorkOrderPOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject: services },
  // Totals from the lines (documentBody.ts): a shop fee line the workshop adds counts too.
  run: async (svc, body) => {
    const result = await createServiceRecordService(svc, documentBody(body))
    await retotalServiceRecord(result.id)
    return result
  },
  audit: (result) => createServiceRecordEvent(result),
  respond: async (result, ctx) =>
    answerWith(workOrdersResource, ctx.organizationId, result.id, 201),
})

export const updateWorkOrderPATCH = writeRoute('PATCH', {
  permission: update,
  current: currentWorkOrder,
  // Re-totalled only when the lines, discount or tax change: an imported invoice's total is Shopmonkey's, and a
  // change of its title leaves it so.
  run: async (svc, body, { id }) => {
    const result = await updateServiceRecordService(svc, withId(documentBody(body), id))
    if (touchesMoney(body)) await retotalServiceRecord(id)
    return result
  },
  audit: (result) => updateServiceRecordEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(workOrdersResource, ctx.organizationId, id),
})

export const deleteWorkOrderDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.DELETE, subject: services },
  current: currentWorkOrder,
  run: (svc, _body, { id }) => deleteServiceRecordService(svc, id),
  audit: (result) => deleteServiceRecordEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})

export const workOrderStatusPOST = writeRoute('POST', {
  permission: update,
  run: async (svc, body, { id }: { id: string }) => {
    const { status, customStatusId } = workOrderStatusBodySchema.parse(body)
    return updateServiceStatusService(svc, id, status, customStatusId ?? null)
  },
  audit: (result) => updateServiceStatusEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(workOrdersResource, ctx.organizationId, id),
})

/* ---------- lines ---------- */

async function answerLine(
  organizationId: string,
  serviceRecordId: string,
  lineId: string,
  status = 200
) {
  const where = { id: lineId, serviceRecordId, serviceRecord: { organizationId } }
  const labor = await db.serviceLabor.findFirst({
    where,
    select: LABOR_LINE_SELECT,
  })
  if (labor) return Response.json({ data: serializeLaborLine(labor) }, { status })
  const part = await db.servicePart.findFirst({
    where,
    select: PART_LINE_SELECT,
  })
  if (part) return Response.json({ data: serializePartLine(part) }, { status })
  return publicApiError(404, 'not_found', 'Not found.')
}

export const createLinePOST = writeRoute('POST', {
  permission: update,
  run: (svc, body, { id }: { id: string }) => createLineService(svc, id, body),
  audit: (result) => lineChangedEvent(result),
  respond: async (result, ctx) =>
    answerLine(ctx.organizationId, result.serviceRecordId, result.id, 201),
})

export const updateLinePATCH = writeRoute('PATCH', {
  permission: update,
  current: currentWorkOrder,
  run: (svc, body, p: { id: string; lineId: string }) =>
    updateLineService(svc, p.id, p.lineId, body),
  audit: (result) => lineChangedEvent(result),
  respond: async (result, ctx) => answerLine(ctx.organizationId, result.serviceRecordId, result.id),
})

export const deleteLineDELETE = writeRoute('DELETE', {
  permission: update,
  current: currentWorkOrder,
  run: (svc, _body, p: { id: string; lineId: string }) => deleteLineService(svc, p.id, p.lineId),
  audit: (result) => lineChangedEvent(result),
  respond: async (result) => deleted(result.id),
})

/* ---------- jobs ---------- */

async function answerJob(organizationId: string, jobId: string, status = 200) {
  const job = await db.workJob.findFirst({
    where: { id: jobId, organizationId },
    select: JOB_SELECT,
  })
  if (!job) return publicApiError(404, 'not_found', 'Not found.')
  return Response.json({ data: serializeJob(job) }, { status, headers: { ETag: etagFor(job) } })
}

const currentJob = (ctx: { organizationId: string }, p: { id: string; jobId: string }) =>
  db.workJob.findFirst({
    where: { id: p.jobId, serviceRecordId: p.id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createJobPOST = writeRoute('POST', {
  permission: update,
  run: (svc, body, { id }: { id: string }) => createJobService(svc, id, body),
  audit: (result) => jobEvent('create', result),
  respond: async (result, ctx) => answerJob(ctx.organizationId, result.id, 201),
})

export const updateJobPATCH = writeRoute('PATCH', {
  permission: update,
  current: currentJob,
  run: (svc, body, p) => updateJobService(svc, p.id, p.jobId, body),
  audit: (result) => jobEvent('update', result),
  respond: async (result, ctx) => answerJob(ctx.organizationId, result.id),
})

export const deleteJobDELETE = writeRoute('DELETE', {
  permission: update,
  current: currentJob,
  run: (svc, _body, p) => deleteJobService(svc, p.id, p.jobId),
  audit: (result) => jobEvent('delete', result),
  respond: async (result) => deleted(result.id),
})

/* ---------- payments ---------- */

const currentPayment = (ctx: { organizationId: string }, p: { id: string; paymentId: string }) =>
  db.payment.findFirst({
    where: {
      id: p.paymentId,
      serviceRecordId: p.id,
      serviceRecord: { organizationId: ctx.organizationId },
    },
    select: { id: true, updatedAt: true },
  })

/** Recording a payment issues the invoice the way the app does (the service calls `issueInvoice`). */
export const createPaymentPOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject: PermissionSubject.BILLING },
  run: (svc, body, { id }: { id: string }) =>
    createPaymentService(
      svc,
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), serviceRecordId: id }
        : body
    ),
  audit: (result) => createPaymentEvent(result),
  respond: async (result, ctx) => {
    const payment = await db.payment.findFirst({
      where: { id: result.id, serviceRecord: { organizationId: ctx.organizationId } },
      select: PAYMENT_SELECT,
    })
    if (!payment) return publicApiError(404, 'not_found', 'Not found.')
    return Response.json(
      { data: serializePayment(payment, await serializeContext(ctx.organizationId)) },
      { status: 201, headers: { ETag: etagFor(payment) } }
    )
  },
})

export const deletePaymentDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.DELETE, subject: PermissionSubject.BILLING },
  current: currentPayment,
  run: (svc, _body, p) => deletePaymentService(svc, p.paymentId),
  audit: (result) => deletePaymentEvent(result),
  respond: async (_result, _ctx, p) => deleted(p.paymentId),
})

/* ---------- attachments ---------- */

/**
 * What a work order takes as a file, with its stored extension: a camera's photos and videos, a PDF, and the plain
 * text and CSV the app's own upload takes (diagnostic logs). Each a parser somewhere, so nothing more.
 */
const ATTACHMENT_TYPES = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/heic', 'heic'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
  ['text/csv', 'csv'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
])
const MB = 1024 * 1024
/** The technician app's limits: a photo, a document, a video. */
const MAX_IMAGE_BYTES = 60 * MB
const MAX_DOCUMENT_BYTES = 25 * MB
const MAX_VIDEO_BYTES = 250 * MB
const IMAGE_CATEGORIES = ['image', 'diagnostic', 'document', 'dropoff'] as const

const attachmentFieldsSchema = z
  .object({
    category: z.enum(IMAGE_CATEGORIES).optional(),
    description: z.string().max(500).optional(),
    includeInInvoice: z.enum(['true', 'false']).optional(),
  })
  .strict()

/** A PDF opens with its signature, within the first kilobyte. */
const isPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes('%PDF-')

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  Buffer.from(bytes.subarray(at, at + text.length)).toString('latin1') === text

/** A photo is the format it says it is, by its first bytes: a name and a type are only the client's word. */
const IMAGE_SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b[0] === 0x89 &&
    ascii(b, 1, 'PNG') &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a,
  'image/webp': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  'image/heic': (b) =>
    ascii(b, 4, 'ftyp') &&
    ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].some((brand) =>
      ascii(b, 8, brand)
    ),
}

/** Text has no NUL bytes: one in the first 8 KB is a binary file sent as text. */
const isText = (bytes: Uint8Array) => !bytes.subarray(0, 8192).includes(0)

function refuse(message: string): never {
  throw new Error(message)
}

/**
 * `POST /work-orders/{id}/attachments`, `multipart/form-data`: the file in `file`, and `category`, `description`,
 * `includeInInvoice` beside it. The bytes are stored under a name made here (never the client's) and the row is the
 * app's own (`addServiceAttachmentService`: the plan's limits, the workshop's uploads only); a refused row takes its
 * file with it.
 */
export const createAttachmentPOST = writeRoute('POST', {
  permission: update,
  multipart: { maxBytes: MAX_VIDEO_BYTES + MB },
  run: async (svc, body, { id }: { id: string }) => {
    const form = body as FormData
    const record = await db.serviceRecord.findFirst({
      where: { id, organizationId: svc.organizationId },
      select: { id: true },
    })
    if (!record) throw new Error('Work order not found')
    if (isRestoring(svc.organizationId)) throw new RestoreInProgressError()

    const file = form.get('file')
    if (!(file instanceof File)) refuse('No file was sent in the `file` field.')
    const fields = attachmentFieldsSchema.parse(
      Object.fromEntries([...form.entries()].filter(([key]) => key !== 'file'))
    )
    const ext =
      ATTACHMENT_TYPES.get(file.type) ?? refuse(`A ${file.type || 'file'} can’t be attached.`)
    if (file.size === 0) refuse('That file is empty.')
    const video = isDeclaredVideo(file.type)
    const textual = file.type === 'application/pdf' || file.type.startsWith('text/')
    const max = video ? MAX_VIDEO_BYTES : textual ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES
    if (file.size > max) refuse(`That file is too large: at most ${max / MB} MB.`)

    const bytes = new Uint8Array(await file.arrayBuffer())
    const container = video ? sniffDeclaredVideo(file.type, bytes) : null
    if (video && !container) refuse(NOT_A_VIDEO_MESSAGE)
    if (file.type === 'application/pdf' && !isPdf(bytes)) refuse('That file is not a PDF.')
    const signature = IMAGE_SIGNATURES[file.type]
    if (signature && !signature(bytes)) refuse(`That file is not a ${ext.toUpperCase()} image.`)
    if (file.type.startsWith('text/') && !isText(bytes)) refuse('That file is not text.')

    const category = video ? 'video' : (fields.category ?? (textual ? 'document' : 'image'))
    const filename = `${randomUUID()}.${ext}`
    const dir = path.join(uploadsRoot(), svc.organizationId, 'services')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, filename), bytes)
    const fileUrl = `/api/protected/files/${svc.organizationId}/services/${filename}`
    try {
      const attachment = await addServiceAttachmentService(svc, {
        serviceRecordId: record.id,
        attachment: {
          // The client's name is a label only, never part of a path.
          fileName: (file.name || filename).slice(0, 200),
          fileUrl,
          fileType: file.type,
          fileSize: bytes.byteLength,
          category,
          description: fields.description,
          // A photo of the car as it came in stays off the invoice unless asked.
          includeInInvoice: fields.includeInInvoice
            ? fields.includeInInvoice === 'true'
            : category !== 'dropoff',
        },
      })
      if (container) {
        void queueVideoDownscale({
          attachmentId: attachment.id,
          organizationId: svc.organizationId,
          fileUrl,
          container,
        })
      }
      return attachment
    } catch (err) {
      await discardUnsavedUpload(svc.organizationId, 'services', filename)
      throw err
    }
  },
  respond: async (result, ctx) => {
    const row = await db.serviceAttachment.findFirst({
      where: { id: result.id, serviceRecord: { organizationId: ctx.organizationId } },
      select: ATTACHMENT_SELECT,
    })
    if (!row) return publicApiError(404, 'not_found', 'Not found.')
    return Response.json(
      { data: serializeAttachment(result.serviceRecordId, row) },
      // An attachment doesn't change once made: its ETag is its making, as `If-Match` on its DELETE reads it.
      { status: 201, headers: { ETag: etagFor({ id: row.id, updatedAt: row.createdAt }) } }
    )
  },
})

const currentAttachment = async (
  ctx: { organizationId: string },
  p: { id: string; attachmentId: string }
) => {
  const row = await db.serviceAttachment.findFirst({
    where: {
      id: p.attachmentId,
      serviceRecordId: p.id,
      serviceRecord: { organizationId: ctx.organizationId },
    },
    select: { id: true, createdAt: true },
  })
  // An attachment doesn't change once made: its ETag is its making.
  return row ? { id: row.id, updatedAt: row.createdAt } : null
}

export const deleteAttachmentDELETE = writeRoute('DELETE', {
  permission: update,
  current: currentAttachment,
  run: (svc, _body, p: { id: string; attachmentId: string }) =>
    deleteServiceAttachmentService(svc, p.attachmentId),
  respond: async (_result, _ctx, p) => deleted(p.attachmentId),
})
