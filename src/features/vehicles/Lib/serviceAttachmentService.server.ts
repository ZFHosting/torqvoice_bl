/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { db } from '@/lib/db'
import { assertOwnUploads } from '@/lib/upload-url'
import { revalidatePath } from 'next/cache'
import { getFeatures } from '@/lib/features'
import { z } from 'zod'
import { serviceAttachmentSchema } from '../Schema/serviceSchema'
import type { PlanFeatures } from '@/lib/features'
import type { ServiceCtx } from '@/lib/service-context'

const addAttachmentSchema = z.object({
  serviceRecordId: z.string(),
  attachment: serviceAttachmentSchema,
  /** The concern the file is evidence for, when it was added from that concern's row. */
  concernId: z.string().min(1).optional(),
})

const CATEGORY_LIMIT_MAP: Record<string, keyof PlanFeatures | undefined> = {
  image: 'maxImagesPerService',
  diagnostic: 'maxDiagnosticsPerService',
  document: 'maxDocumentsPerService',
}

const updateAttachmentSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  includeInInvoice: z.boolean().optional(),
})

export async function addServiceAttachmentService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = addAttachmentSchema.parse(input)
  assertOwnUploads(data, organizationId)

  const record = await db.serviceRecord.findFirst({
    where: {
      id: data.serviceRecordId,
      organizationId,
    },
    select: { id: true, vehicleId: true },
  })
  if (!record) throw new Error('Service record not found')

  const limitKey = CATEGORY_LIMIT_MAP[data.attachment.category]
  if (limitKey) {
    const features = await getFeatures(organizationId)
    const maxAllowed = features[limitKey] as number
    const currentCount = await db.serviceAttachment.count({
      where: {
        serviceRecordId: record.id,
        category: data.attachment.category,
      },
    })
    if (currentCount >= maxAllowed) {
      const label =
        data.attachment.category === 'diagnostic'
          ? 'Diagnostic report'
          : data.attachment.category.charAt(0).toUpperCase() + data.attachment.category.slice(1)
      throw new Error(
        `${label} limit reached (${currentCount}/${maxAllowed}). Upgrade your plan for more.`
      )
    }
  }

  // A concern on another job, or another workshop's, is not somewhere
  // this file can be filed.
  if (data.concernId) {
    const concern = await db.serviceConcern.findFirst({
      where: { id: data.concernId, serviceRecordId: record.id },
      select: { id: true },
    })
    if (!concern) throw new Error('Concern not found')
  }

  const attachment = await db.serviceAttachment.create({
    data: {
      ...data.attachment,
      serviceRecordId: record.id,
      concernId: data.concernId ?? null,
    },
  })

  revalidatePath(`/vehicles/${record.vehicleId}/service/${record.id}`)

  return attachment
}

export async function updateServiceAttachmentService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = updateAttachmentSchema.parse(input)

  const attachment = await db.serviceAttachment.findFirst({
    where: {
      id: data.id,
      serviceRecord: { organizationId },
    },
    include: {
      serviceRecord: { select: { vehicleId: true, id: true } },
    },
  })
  if (!attachment) throw new Error('Attachment not found')

  const updated = await db.serviceAttachment.update({
    where: { id: data.id },
    data: {
      ...(data.description !== undefined && {
        description: data.description,
      }),
      ...(data.includeInInvoice !== undefined && {
        includeInInvoice: data.includeInInvoice,
      }),
    },
  })

  const { vehicleId, id: serviceId } = attachment.serviceRecord
  revalidatePath(`/vehicles/${vehicleId}/service/${serviceId}`)

  return updated
}
