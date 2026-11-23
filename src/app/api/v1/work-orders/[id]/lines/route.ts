import { workOrderLinesGET } from '@/features/public-api/Resources/workOrderChildren'
import { createLinePOST } from '@/features/public-api/Writes/workOrders'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-orders/{id}/lines` (docs/fork/API.md §4). */
export const GET = workOrderLinesGET

/** `POST /api/v1/work-orders/{id}/lines` (docs/fork/API.md §4). */
export const POST = createLinePOST
