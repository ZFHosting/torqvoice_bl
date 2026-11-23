'use server'

import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the body and its audit event live beside the vehicle service (A2)
import { vehicleArchivedEvent } from '../Lib/vehicleAuditEvents'
import { archiveVehicleService } from '../Lib/vehicleArchiveService.server'

export async function archiveVehicle(vehicleId: string, reason?: string) {
  return withAuth(
    // fork: the body is archiveVehicleService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      archiveVehicleService({ organizationId, userId, actor: 'user' }, vehicleId, reason),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.VEHICLES },
      ],
      audit: ({ result }) => vehicleArchivedEvent(result),
    }
  )
}
