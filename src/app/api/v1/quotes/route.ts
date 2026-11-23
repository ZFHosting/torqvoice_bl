import { listRoute } from '@/features/public-api/Lib/readResource'
import { quotesResource } from '@/features/public-api/Resources/quotes'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/quotes` (docs/fork/API.md §4). */
export const GET = listRoute(quotesResource)
