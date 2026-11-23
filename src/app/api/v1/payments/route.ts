import { listRoute } from '@/features/public-api/Lib/readResource'
import { paymentsResource } from '@/features/public-api/Resources/records'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/payments` (docs/fork/API.md §4). */
export const GET = listRoute(paymentsResource)
