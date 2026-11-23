import { getRoute } from '@/features/public-api/Lib/readResource'
import { findingsResource } from '@/features/public-api/Resources/records'
import { deleteFindingDELETE, updateFindingPATCH } from '@/features/public-api/Writes/records'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/findings/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(findingsResource)

/** `PATCH /api/v1/findings/{id}` (docs/fork/API.md §4). */
export const PATCH = updateFindingPATCH

/** `DELETE /api/v1/findings/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteFindingDELETE
