'use server'

import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { type SaveBookingInput } from '../Schema/bookingSchema'
// fork: the body and its audit event live beside the booking service (A2)
import { createBookingOnceEvent } from '../Lib/bookingAuditEvents'
import { createBookingOnceService } from '../Lib/bookingService.server'

/**
 * Puts something on the calendar from the booking dialog.
 *
 * An appointment is only that: a time, who it is with, what it is about, and
 * the notifications before it. Work on a car is booked as a job like any
 * other, so the work board, the technician app and online booking all see
 * the time as taken, and nothing has to be copied across when the car
 * arrives. The job starts out `scheduled` and holds a bay, or in a shop
 * without bays a technician, as an online booking does (`resourceFor`).
 *
 * An appointment can become a work order: the dialog opens on it, and the
 * appointment goes once the job exists, in the same transaction.
 *
 * Booked once however often it is sent. The dialog makes up a token when it
 * opens and sends it with the booking; what gets booked carries it, unique
 * within the workshop. When the answer to the first send is lost (the
 * network dropped, the server restarted under a deploy) the dialog shows a
 * failure and stays filled in, and the second press finds the first booking
 * by its token instead of making another with the next job number.
 *
 * Named `createBookingOnce` because the token is required: a tab opened
 * before this existed calls `createBooking`, which is gone, and is asked to
 * reload rather than book without one.
 */
export async function createBookingOnce(input: SaveBookingInput) {
  return withAuth(
    // fork: the body is createBookingOnceService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createBookingOnceService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.SERVICES },
      ],
      // Written down when it was booked, not again each time it is found.
      audit: ({ result }) => createBookingOnceEvent(result),
    }
  )
}

/** What this token already booked in this workshop, if it booked anything. */
