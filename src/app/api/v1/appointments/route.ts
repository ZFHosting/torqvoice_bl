import { listRoute } from '@/features/public-api/Lib/readResource'
import { appointmentsResource } from '@/features/public-api/Resources/schedule'
import { createAppointmentPOST } from '@/features/public-api/Writes/schedule'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/appointments` (docs/fork/API.md §4). */
export const GET = listRoute(appointmentsResource)

/** `POST /api/v1/appointments` (docs/fork/API.md §4). */
export const POST = createAppointmentPOST
