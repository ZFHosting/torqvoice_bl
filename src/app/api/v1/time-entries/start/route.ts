import { startTimeEntryPOST } from '@/features/public-api/Writes/schedule'

export const dynamic = 'force-dynamic'

/** `POST /api/v1/time-entries/start` (docs/fork/API.md §4). */
export const POST = startTimeEntryPOST
