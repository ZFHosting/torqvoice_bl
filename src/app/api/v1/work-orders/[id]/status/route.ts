import { workOrderStatusPOST } from '@/features/public-api/Writes/workOrders'

export const dynamic = 'force-dynamic'

/** `POST /api/v1/work-orders/{id}/status` (docs/fork/API.md §4). */
export const POST = workOrderStatusPOST
