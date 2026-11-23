import { getRoute } from '@/features/public-api/Lib/readResource'
import { timeEntriesResource } from '@/features/public-api/Resources/schedule'
import { deleteTimeEntryDELETE, updateTimeEntryPATCH } from '@/features/public-api/Writes/schedule'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/time-entries/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(timeEntriesResource)

/** `PATCH /api/v1/time-entries/{id}` (docs/fork/API.md §4). */
export const PATCH = updateTimeEntryPATCH

/** `DELETE /api/v1/time-entries/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteTimeEntryDELETE
