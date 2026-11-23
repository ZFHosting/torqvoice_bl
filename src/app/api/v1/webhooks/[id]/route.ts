import { getRoute } from '@/features/public-api/Lib/readResource'
import { webhooksResource } from '@/features/public-api/Resources/records'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/webhooks/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(webhooksResource)
