import { listRoute } from '@/features/public-api/Lib/readResource'
import { shiftsResource } from '@/features/public-api/Resources/schedule'
import { createShiftPOST } from '@/features/public-api/Writes/schedule'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/shifts` (docs/fork/API.md §4). */
export const GET = listRoute(shiftsResource)

/** `POST /api/v1/shifts` (docs/fork/API.md §4). */
export const POST = createShiftPOST
