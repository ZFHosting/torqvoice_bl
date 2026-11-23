import { getRoute } from '@/features/public-api/Lib/readResource'
import { quotesResource } from '@/features/public-api/Resources/quotes'
import { deleteQuoteDELETE, updateQuotePATCH } from '@/features/public-api/Writes/quotes'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/quotes/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(quotesResource)

/** `PATCH /api/v1/quotes/{id}` (docs/fork/API.md §4). */
export const PATCH = updateQuotePATCH

/** `DELETE /api/v1/quotes/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteQuoteDELETE
