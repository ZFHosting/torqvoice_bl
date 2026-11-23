import { listRoute } from '@/features/public-api/Lib/readResource'
import { workOrderStatusesResource } from '@/features/public-api/Resources/staff'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-order-statuses` (docs/fork/API.md §4). */
export const GET = listRoute(workOrderStatusesResource)
