import { getRoute } from '@/features/public-api/Lib/readResource'
import { shiftsResource } from '@/features/public-api/Resources/schedule'
import { deleteShiftDELETE, updateShiftPATCH } from '@/features/public-api/Writes/schedule'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/shifts/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(shiftsResource)

/** `PATCH /api/v1/shifts/{id}` (docs/fork/API.md §4). */
export const PATCH = updateShiftPATCH

/** `DELETE /api/v1/shifts/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteShiftDELETE
