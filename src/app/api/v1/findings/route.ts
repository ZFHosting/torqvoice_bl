import { listRoute } from '@/features/public-api/Lib/readResource'
import { findingsResource } from '@/features/public-api/Resources/records'
import { createFindingPOST } from '@/features/public-api/Writes/records'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/findings` (docs/fork/API.md §4). */
export const GET = listRoute(findingsResource)

/** `POST /api/v1/findings` (docs/fork/API.md §4). */
export const POST = createFindingPOST
