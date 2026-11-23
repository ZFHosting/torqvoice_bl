import { listRoute } from '@/features/public-api/Lib/readResource'
import { quotesResource } from '@/features/public-api/Resources/quotes'
import { createQuotePOST } from '@/features/public-api/Writes/quotes'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/quotes` (docs/fork/API.md §4). */
export const GET = listRoute(quotesResource)

/** `POST /api/v1/quotes` (docs/fork/API.md §4). */
export const POST = createQuotePOST
