'use server'

import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the body and its audit event live beside the vehicle service (A2)
import { vehicleUnarchivedEvent } from '../Lib/vehicleAuditEvents'
import { unarchiveVehicleService } from '../Lib/vehicleArchiveService.server'

export async function unarchiveVehicle(vehicleId: string) {
  return withAuth(
    // fork: the body is unarchiveVehicleService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      unarchiveVehicleService({ organizationId, userId, actor: 'user' }, vehicleId),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.VEHICLES },
      ],
      audit: ({ result }) => vehicleUnarchivedEvent(result),
    }
  )
}
