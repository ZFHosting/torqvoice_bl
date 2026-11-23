import { getRoute } from '@/features/public-api/Lib/readResource'
import { customersResource } from '@/features/public-api/Resources/customers'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/customers/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(customersResource)
