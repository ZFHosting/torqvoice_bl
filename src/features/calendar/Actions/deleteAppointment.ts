'use server'

import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the body and its audit event live beside the booking service (A2)
import { deleteAppointmentEvent } from '../Lib/bookingAuditEvents'
import { deleteAppointmentService } from '../Lib/bookingService.server'

/**
 * Takes an appointment off the calendar, with its notifications. A booked
 * job is not an appointment: it is cancelled or deleted as a work order.
 */
export async function deleteAppointment(id: string) {
  return withAuth(
    // fork: the body is deleteAppointmentService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteAppointmentService({ organizationId, userId, actor: 'user' }, id),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => deleteAppointmentEvent(result),
    }
  )
}
