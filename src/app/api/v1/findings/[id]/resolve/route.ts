import { resolveFindingPOST } from '@/features/public-api/Writes/records'

export const dynamic = 'force-dynamic'

/** `POST /api/v1/findings/{id}/resolve` (docs/fork/API.md §4). */
export const POST = resolveFindingPOST
