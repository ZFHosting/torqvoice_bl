import { workOrderJobsGET } from '@/features/public-api/Resources/workOrderChildren'
import { createJobPOST } from '@/features/public-api/Writes/workOrders'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-orders/{id}/jobs` (docs/fork/API.md §4). */
export const GET = workOrderJobsGET

/** `POST /api/v1/work-orders/{id}/jobs` (docs/fork/API.md §4). */
export const POST = createJobPOST
