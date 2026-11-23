/**
 * One work order's jobs, lines, payments and attachments on their own, and an attachment's file
 * (docs/fork/API.md §4). The work order is checked to be the key's workshop's first: another workshop's id, or an
 * attachment that isn't on this work order, is a 404. Small, bounded lists: not paged.
 */
import 'server-only'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { parseStoredFileUrl } from '@/lib/files/manager'
import { uploadsRoots } from '@/lib/upload-root'
import { svgDownloadHeaders } from '@/lib/upload-url'
import { publicApiError, publicApiOk } from '../Lib/errors'
import { serializeContext } from '../Lib/serializeContext'
import { type PublicApiContext, withPublicApi } from '../Lib/withPublicApi'
import { serializeJob, serializeLines } from '../Serializers/common'
import { serializePayment } from '../Serializers/records'
import {
  ATTACHMENT_SELECT,
  BY_ID,
  JOB_ORDER,
  JOB_SELECT,
  LABOR_LINE_SELECT,
  PART_LINE_SELECT,
  PAYMENT_SELECT,
  serializeAttachment,
} from '../Serializers/workOrders'
import { WORK_ORDER_PERMISSION } from './workOrders'

type Params = { params: Promise<{ id: string }> }

/** A handler for one work order's child list, after the work order is found in the key's workshop. */
function childRoute(read: (workOrderId: string, ctx: PublicApiContext) => Promise<unknown>) {
  return (request: Request, { params }: Params) =>
    withPublicApi(
      request,
      async (ctx) => {
        const { id } = await params
        const workOrder = await db.serviceRecord.findFirst({
          where: { id, organizationId: ctx.organizationId },
          select: { id: true },
        })
        if (!workOrder) return publicApiError(404, 'not_found', 'Not found.')
        return publicApiOk(await read(workOrder.id, ctx))
      },
      { requiredPermissions: [WORK_ORDER_PERMISSION] }
    )
}

export const workOrderJobsGET = childRoute(async (serviceRecordId) =>
  (
    await db.workJob.findMany({
      where: { serviceRecordId },
      select: JOB_SELECT,
      orderBy: [...JOB_ORDER],
    })
  ).map(serializeJob)
)

export const workOrderLinesGET = childRoute(async (serviceRecordId) => {
  const [labor, parts] = await Promise.all([
    db.serviceLabor.findMany({
      where: { serviceRecordId },
      select: LABOR_LINE_SELECT,
      orderBy: [...BY_ID],
    }),
    db.servicePart.findMany({
      where: { serviceRecordId },
      select: PART_LINE_SELECT,
      orderBy: [...BY_ID],
    }),
  ])
  return serializeLines(labor, parts)
})

export const workOrderPaymentsGET = childRoute(async (serviceRecordId, ctx) => {
  const serialize = await serializeContext(ctx.organizationId)
  return (
    await db.payment.findMany({
      where: { serviceRecordId },
      select: PAYMENT_SELECT,
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    })
  ).map((p) => serializePayment(p, serialize))
})

export const workOrderAttachmentsGET = childRoute(async (serviceRecordId) =>
  (
    await db.serviceAttachment.findMany({
      where: { serviceRecordId },
      select: ATTACHMENT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
  ).map((a) => serializeAttachment(serviceRecordId, a))
)

/** A file name safe in a Content-Disposition header. */
function dispositionName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * `GET /api/v1/work-orders/{id}/attachments/{attachmentId}/content`: the file, after the checks the protected
 * files route makes (the workshop's own upload, a folder the app writes to, no path outside it, a plain file).
 */
export async function workOrderAttachmentContentGET(
  request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  return withPublicApi(
    request,
    async ({ organizationId }) => {
      const { id, attachmentId } = await params
      const attachment = await db.serviceAttachment.findFirst({
        where: { id: attachmentId, serviceRecordId: id, serviceRecord: { organizationId } },
        select: { fileUrl: true, fileName: true, fileType: true },
      })
      if (!attachment) return publicApiError(404, 'not_found', 'Not found.')
      const stored = parseStoredFileUrl(attachment.fileUrl)
      // Only this workshop's own uploads: a URL pointing anywhere else isn't served.
      if (!stored || stored.organizationId !== organizationId) {
        return publicApiError(404, 'not_found', 'The file is not stored here.')
      }
      for (const root of uploadsRoots()) {
        const folder = path.resolve(root, stored.organizationId, stored.folder)
        const target = path.resolve(folder, stored.name)
        if (path.dirname(target) !== folder) continue
        try {
          const info = await lstat(target)
          if (!info.isFile()) continue
        } catch {
          continue
        }
        const body = await readFile(target)
        const name = attachment.fileName || stored.name
        if (stored.name.toLowerCase().endsWith('.svg')) {
          return new Response(body, { headers: svgDownloadHeaders('private, no-store') })
        }
        return new Response(body, {
          headers: {
            'Content-Type': attachment.fileType || 'application/octet-stream',
            'Content-Length': String(body.byteLength),
            'Content-Disposition': dispositionName(name),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
          },
        })
      }
      return publicApiError(404, 'not_found', 'The file is missing.')
    },
    { requiredPermissions: [WORK_ORDER_PERMISSION] }
  )
}
