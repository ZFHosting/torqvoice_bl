import { workOrderLinesGET } from '@/features/public-api/Resources/workOrderChildren'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-orders/{id}/lines` (docs/fork/API.md §4). */
export const GET = workOrderLinesGET
