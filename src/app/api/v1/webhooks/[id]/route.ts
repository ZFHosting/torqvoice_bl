import { getRoute } from '@/features/public-api/Lib/readResource'
import { webhooksResource } from '@/features/public-api/Resources/records'
import { deleteWebhookDELETE, updateWebhookPATCH } from '@/features/public-api/Writes/records'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/webhooks/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(webhooksResource)

/** `PATCH /api/v1/webhooks/{id}` (docs/fork/API.md §4). */
export const PATCH = updateWebhookPATCH

/** `DELETE /api/v1/webhooks/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteWebhookDELETE
