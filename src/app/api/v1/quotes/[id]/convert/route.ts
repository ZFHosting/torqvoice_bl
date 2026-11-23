import { convertQuotePOST } from '@/features/public-api/Writes/quotes'

export const dynamic = 'force-dynamic'

/** `POST /api/v1/quotes/{id}/convert` (docs/fork/API.md §4). */
export const POST = convertQuotePOST
