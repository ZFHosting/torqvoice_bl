'use server'

import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { type SaveBookingInput } from '../Schema/bookingSchema'
// fork: the body and its audit event live beside the booking service (A2)
import { updateBookingEvent } from '../Lib/bookingAuditEvents'
import { updateBookingService } from '../Lib/bookingService.server'

/**
 * Changes a booking from the calendar: an appointment, or a booked job whose
 * car has not arrived yet.
 *
 * Once the car is in, the job is a live work order and is changed there; the
 * calendar only moves what is still a booking. On a booked job:
 *
 * - The time moves, and the job keeps its bay or technician when that is
 *   still free then; otherwise it takes the first free one, as a new booking
 *   would.
 * - The car can be added to a booking made for a customer whose car was not
 *   on file. A different car or customer is changed on the work order, where
 *   the prices and tax that follow the customer are worked out again.
 * - The work lines are the job's concerns, and the only copy of what the job
 *   is about. They are replaced only while nobody has recorded anything on
 *   them; after that they are the job's history and are changed on the work
 *   order. A description an older job still carries becomes concerns too the
 *   first time the booking is saved here.
 */
export async function updateBooking(input: SaveBookingInput) {
  return withAuth(
    // fork: the body is updateBookingService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateBookingService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => updateBookingEvent(result),
    }
  )
}
