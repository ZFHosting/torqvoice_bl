import { getRoute } from '@/features/public-api/Lib/readResource'
import { techniciansResource } from '@/features/public-api/Resources/staff'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/technicians/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(techniciansResource)
