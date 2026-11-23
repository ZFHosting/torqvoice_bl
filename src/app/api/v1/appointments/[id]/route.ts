import { getRoute } from '@/features/public-api/Lib/readResource'
import { appointmentsResource } from '@/features/public-api/Resources/schedule'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/appointments/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(appointmentsResource)
