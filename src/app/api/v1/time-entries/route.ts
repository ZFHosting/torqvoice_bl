import { listRoute } from '@/features/public-api/Lib/readResource'
import { timeEntriesResource } from '@/features/public-api/Resources/schedule'
import { createTimeEntryPOST } from '@/features/public-api/Writes/schedule'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/time-entries` (docs/fork/API.md §4). */
export const GET = listRoute(timeEntriesResource)

/** `POST /api/v1/time-entries` (docs/fork/API.md §4). */
export const POST = createTimeEntryPOST
