import { getRoute } from '@/features/public-api/Lib/readResource'
import { techniciansResource } from '@/features/public-api/Resources/staff'
import { deleteTechnicianDELETE, updateTechnicianPATCH } from '@/features/public-api/Writes/staff'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/technicians/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(techniciansResource)

/** `PATCH /api/v1/technicians/{id}` (docs/fork/API.md §4). */
export const PATCH = updateTechnicianPATCH

/** `DELETE /api/v1/technicians/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteTechnicianDELETE
