import { listRoute } from '@/features/public-api/Lib/readResource'
import { webhooksResource } from '@/features/public-api/Resources/records'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/webhooks` (docs/fork/API.md §4). */
export const GET = listRoute(webhooksResource)
