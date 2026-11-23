/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import type { ServiceCtx } from '@/lib/service-context'

export async function archiveVehicleService(ctx: ServiceCtx, vehicleId: string, reason?: string) {
  const { organizationId } = ctx
  const result = await db.vehicle.updateMany({
    where: { id: vehicleId, organizationId },
    data: { isArchived: true, archiveReason: reason || null },
  })
  if (result.count === 0) throw new Error('Vehicle not found')

  revalidatePath('/')
  revalidatePath('/vehicles')
  revalidatePath(`/vehicles/${vehicleId}`)

  return { success: true as const, vehicleId }
}

export async function unarchiveVehicleService(ctx: ServiceCtx, vehicleId: string) {
  const { organizationId } = ctx
  const result = await db.vehicle.updateMany({
    where: { id: vehicleId, organizationId },
    data: { isArchived: false, archiveReason: null },
  })
  if (result.count === 0) throw new Error('Vehicle not found')

  revalidatePath('/')
  revalidatePath('/vehicles')
  revalidatePath(`/vehicles/${vehicleId}`)

  return { success: true as const, vehicleId }
}
