import { deleteJobDELETE, updateJobPATCH } from '@/features/public-api/Writes/workOrders'

export const dynamic = 'force-dynamic'

/** `PATCH /api/v1/work-orders/{id}/jobs/{jobId}` (docs/fork/API.md §4). */
export const PATCH = updateJobPATCH

/** `DELETE /api/v1/work-orders/{id}/jobs/{jobId}` (docs/fork/API.md §4). */
export const DELETE = deleteJobDELETE
