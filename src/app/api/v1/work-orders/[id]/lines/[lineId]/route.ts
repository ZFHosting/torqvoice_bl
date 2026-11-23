import { deleteLineDELETE, updateLinePATCH } from '@/features/public-api/Writes/workOrders'

export const dynamic = 'force-dynamic'

/** `PATCH /api/v1/work-orders/{id}/lines/{lineId}` (docs/fork/API.md §4). */
export const PATCH = updateLinePATCH

/** `DELETE /api/v1/work-orders/{id}/lines/{lineId}` (docs/fork/API.md §4). */
export const DELETE = deleteLineDELETE
