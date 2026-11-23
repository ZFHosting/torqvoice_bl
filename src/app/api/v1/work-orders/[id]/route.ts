import { getRoute } from '@/features/public-api/Lib/readResource'
import { workOrdersResource } from '@/features/public-api/Resources/workOrders'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-orders/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(workOrdersResource)
