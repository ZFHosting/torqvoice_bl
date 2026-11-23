import { workOrderJobsGET } from '@/features/public-api/Resources/workOrderChildren'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-orders/{id}/jobs` (docs/fork/API.md §4). */
export const GET = workOrderJobsGET
