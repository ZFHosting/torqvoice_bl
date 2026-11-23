/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { db } from '@/lib/db'
import { revokeTechnicianCredentials } from '@/features/team/Lib/revokeTechnicianCredentials'
import { revalidatePath } from 'next/cache'
import { notificationBus } from '@/lib/notification-bus'
import { createTechnicianSchema, updateTechnicianSchema } from '../Schema/workboardSchema'
import type { ServiceCtx } from '@/lib/service-context'

export async function createTechnicianService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = createTechnicianSchema.parse(input)

  // If userId provided, return existing technician instead of creating duplicate
  if (data.userId) {
    const existing = await db.technician.findFirst({
      where: { userId: data.userId, organizationId },
    })
    if (existing) return existing
  }

  const maxOrder = await db.technician.aggregate({
    where: { organizationId },
    _max: { sortOrder: true },
  })

  const technician = await db.technician.create({
    data: {
      name: data.name,
      color: data.color,
      skills: data.skills || null,
      userId: data.userId || null,
      sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      organizationId,
    },
  })

  notificationBus.emit('workboard', {
    type: 'technician_created',
    organizationId,
    technician,
  })

  revalidatePath('/work-board')
  return technician
}

export async function updateTechnicianService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = updateTechnicianSchema.parse(input)
  const { id, skills, ...rest } = data
  // An emptied field means "no skills line", not a line of nothing.
  const updates = { ...rest, ...(skills !== undefined ? { skills: skills || null } : {}) }

  // Prevent linking a user that's already linked to another technician
  if (updates.userId) {
    const existing = await db.technician.findFirst({
      where: { userId: updates.userId, organizationId, id: { not: id } },
    })
    if (existing) {
      throw new Error(`This user is already linked to technician "${existing.name}"`)
    }
  }

  const technician = await db.technician.updateMany({
    where: { id, organizationId },
    data: updates,
  })
  // fork: another workshop's technician id changes nothing here, and goes no further (A4 prerequisite)
  if (technician.count === 0) throw new Error('Technician not found')

  // Sync denormalized techName on related service records when name changes
  if (updates.name) {
    await db.serviceRecord.updateMany({
      // fork: this workshop's jobs only (A4 prerequisite)
      where: { technicianId: id, organizationId },
      data: { techName: updates.name },
    })
  }

  notificationBus.emit('workboard', {
    type: 'technician_updated',
    organizationId,
    technicianId: id,
  })

  revalidatePath('/work-board')
  return { ...technician, technicianId: id }
}

export async function deleteTechnicianService(ctx: ServiceCtx, id: string) {
  const { organizationId } = ctx
  /**
   * Deactivated, not deleted.
   *
   * TimeEntry cascades from Technician, so a hard delete took every hour
   * that person had ever clocked with them. The service records survived,
   * because those only null the reference, which made it worse: the work
   * stayed and the evidence for what it cost disappeared. In Germany those
   * are statutory records.
   *
   * Deactivating looks identical from here, because the board only ever
   * reads active technicians, and it is what every other removal path in
   * the product already does.
   */
  const target = await db.technician.findFirst({
    where: { id, organizationId },
    select: { id: true, userId: true },
  })
  if (!target) throw new Error('That technician is not part of this workshop.')

  await db.technician.update({ where: { id: target.id }, data: { isActive: false } })
  // Same revocation as removing them from the team, so a phone in
  // somebody's pocket stops working here too.
  await revokeTechnicianCredentials(organizationId, target.userId)

  notificationBus.emit('workboard', {
    type: 'technician_removed',
    organizationId,
    technicianId: id,
  })

  revalidatePath('/work-board')
  // Board-only technicians are listed on the team page too, and that is now
  // where they can be removed from.
  revalidatePath('/settings/team')
  return { success: true, technicianId: id }
}

export async function assignTechToUnassignedWorkOrdersService(
  ctx: ServiceCtx,
  technicianId: string
) {
  const { organizationId } = ctx
  const technician = await db.technician.findFirst({
    where: { id: technicianId, organizationId, isActive: true },
    select: { id: true, name: true },
  })

  if (!technician) throw new Error('Technician not found')

  const result = await db.serviceRecord.updateMany({
    where: {
      organizationId,
      technicianId: null,
    },
    data: {
      technicianId: technician.id,
      techName: technician.name,
    },
  })

  revalidatePath('/work-board')
  return { updated: result.count }
}
