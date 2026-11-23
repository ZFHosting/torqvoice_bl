/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { db } from '@/lib/db'
import {
  createFindingSchema,
  updateFindingSchema,
  resolveFindingSchema,
} from '../Schema/findingSchema'
import { revalidatePath } from 'next/cache'
import { releaseFiles } from '@/lib/files/manager'
import { parseSentFields } from '@/lib/parse-sent-fields'
import type { ServiceCtx } from '@/lib/service-context'

async function assertConcernInOrg(concernId: string | null | undefined, organizationId: string) {
  if (!concernId) return
  const concern = await db.serviceConcern.findFirst({
    where: { id: concernId, serviceRecord: { organizationId } },
    select: { id: true },
  })
  if (!concern) throw new Error('Concern not found')
}

/** fork: a work order a finding is linked to is this workshop's, like its vehicle and concern (A4). */
async function assertRecordInOrg(
  serviceRecordId: string | null | undefined,
  organizationId: string
) {
  if (!serviceRecordId) return
  const record = await db.serviceRecord.count({ where: { id: serviceRecordId, organizationId } })
  if (!record) throw new Error('Work order not found')
}

export async function createFindingService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = createFindingSchema.parse(input)
  const vehicle = await db.vehicle.findFirst({
    where: { id: data.vehicleId, organizationId },
  })
  if (!vehicle) throw new Error('Vehicle not found')
  await assertConcernInOrg(data.concernId, organizationId)
  await assertRecordInOrg(data.serviceRecordId, organizationId)

  const finding = await db.vehicleFinding.create({ data })
  revalidatePath(`/vehicles/${data.vehicleId}`)
  revalidatePath('/')
  return finding
}

export async function updateFindingService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  // fork: only the fields sent; the schema's defaults (severity) would reset the rest (A4)
  const { id, ...data } = parseSentFields(updateFindingSchema, input)
  const finding = await db.vehicleFinding.findFirst({
    where: { id, vehicle: { organizationId } },
  })
  if (!finding) throw new Error('Finding not found')
  await assertConcernInOrg(data.concernId, organizationId)
  // fork: moved to a vehicle, or linked to a work order, of this workshop only (A4)
  if (data.vehicleId !== undefined) {
    const vehicle = await db.vehicle.count({ where: { id: data.vehicleId, organizationId } })
    if (!vehicle) throw new Error('Vehicle not found')
  }
  await assertRecordInOrg(data.serviceRecordId, organizationId)

  const updated = await db.vehicleFinding.update({
    where: { id },
    data: {
      ...data,
      notes: data.notes !== undefined ? data.notes || null : undefined,
    },
  })
  revalidatePath(`/vehicles/${finding.vehicleId}`)
  revalidatePath('/')
  return updated
}

export async function resolveFindingService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = resolveFindingSchema.parse(input)
  const finding = await db.vehicleFinding.findFirst({
    where: { id: data.id, vehicle: { organizationId } },
  })
  if (!finding) throw new Error('Finding not found')
  await assertRecordInOrg(data.resolvedServiceRecordId, organizationId)

  const updated = await db.vehicleFinding.update({
    where: { id: data.id },
    data: {
      status: 'resolved',
      resolvedServiceRecordId: data.resolvedServiceRecordId || null,
    },
  })
  revalidatePath(`/vehicles/${finding.vehicleId}`)
  revalidatePath('/')
  return updated
}

export async function deleteFindingService(ctx: ServiceCtx, findingId: string) {
  const { organizationId, userId } = ctx
  const finding = await db.vehicleFinding.findFirst({
    where: { id: findingId, vehicle: { organizationId } },
  })
  if (!finding) throw new Error('Finding not found')

  await db.vehicleFinding.delete({ where: { id: findingId } })
  // fork: the tombstone an API client syncing findings learns the delete from.
  await db.deletedRecord.create({
    data: { organizationId, entityType: 'finding', entityId: findingId, actorUserId: userId },
  })
  await releaseFiles(finding.imageUrls, { organizationId, reason: 'finding deleted' })
  revalidatePath(`/vehicles/${finding.vehicleId}`)
  revalidatePath('/')
  return { findingId }
}
