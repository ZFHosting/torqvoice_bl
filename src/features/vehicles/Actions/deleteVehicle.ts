'use server'

import { db } from '@/lib/db'
import { unlinkMeterReadingsOfDeletedJobs } from '@/features/meters/Lib/jobMeterReading.server'
import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { revalidatePath } from 'next/cache'
import { vehicleFileUrls } from '@/lib/files/collect'
import { releaseFiles } from '@/lib/files/manager'
import {
  deleteCustomFieldValuesOf,
  workOrderIdsOfVehicles,
} from '@/features/custom-fields/Lib/deleteCustomFieldValues'
import { cascadeTombstones } from '@/features/public-api/Lib/tombstones.server'

export async function deleteVehicle(vehicleId: string) {
  return withAuth(
    async ({ organizationId, userId }) => {
      // Its files are read while the rows exist and let go once they are gone:
      // this path used to leave every photo of every job on disk.
      const files = await vehicleFileUrls(organizationId, [vehicleId])
      // Its work orders go with it by cascade; their custom field values hang
      // on the work order's id alone and have to be removed by name.
      const workOrderIds = await workOrderIdsOfVehicles(organizationId, [vehicleId])
      const result = await db.$transaction(async (tx) => {
        // Readings its jobs took on equipment that has since moved to another
        // vehicle stay in that item's history, at the date they count at now.
        await unlinkMeterReadingsOfDeletedJobs(tx, {
          organizationId,
          jobIds: workOrderIds,
          vehicleId,
        })
        // fork: what the delete takes with it, read while it exists (API sync tombstones).
        const cascaded = await cascadeTombstones(
          tx,
          { organizationId, userId },
          { workOrderIds, vehicleId }
        )
        const deleted = await tx.vehicle.deleteMany({
          where: { id: vehicleId, organizationId },
        })
        await deleteCustomFieldValuesOf(tx, organizationId, 'service_record', workOrderIds)
        // And the vehicle's own.
        await deleteCustomFieldValuesOf(tx, organizationId, 'vehicle', [vehicleId])
        // fork: tombstones for API sync, as deleteVehicleService leaves (A2): the vehicle and the
        // work orders that went with it.
        if (deleted.count > 0) {
          await tx.deletedRecord.createMany({
            data: [
              { organizationId, entityType: 'vehicle', entityId: vehicleId, actorUserId: userId },
              ...workOrderIds.map((entityId) => ({
                organizationId,
                entityType: 'work_order',
                entityId,
                actorUserId: userId,
              })),
              ...cascaded,
            ],
          })
        }
        return deleted
      })
      if (result.count === 0) throw new Error('Vehicle not found')
      await releaseFiles(files, { organizationId, reason: 'vehicle deleted' })

      revalidatePath('/')
      revalidatePath('/vehicles')

      return { success: true as const }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.VEHICLES },
      ],
    }
  )
}
