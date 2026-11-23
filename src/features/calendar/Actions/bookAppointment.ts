'use server'

import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { type BookAppointmentInput } from '../Schema/appointmentSchema'
// fork: the body and its audit event live beside the booking service (A2)
import { bookAppointmentEvent } from '../Lib/bookingAuditEvents'
import { bookAppointmentService } from '../Lib/bookingService.server'

/**
 * Books a car or a customer in from the calendar without going through the
 * work order page.
 *
 * The booking is a job like any other, so the work board, the technician app
 * and online booking all see the time as taken, and nothing has to be copied
 * across when the car arrives. It starts out `scheduled`: checking the car in
 * or clocking on moves it on, as with a customer's own online booking. What
 * the customer wants done becomes the job's concerns, one per line, which is
 * what the printed work order lists under work requested.
 *
 * It holds a bay, or in a shop without bays a technician, the same way an
 * online booking does (see `resourceFor`). A job holding neither is invisible
 * to the online booking page, which would then offer the same hour to a
 * customer.
 */
export async function bookAppointment(input: BookAppointmentInput) {
  return withAuth(
    // fork: the body is bookAppointmentService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      bookAppointmentService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => bookAppointmentEvent(result),
    }
  )
}
