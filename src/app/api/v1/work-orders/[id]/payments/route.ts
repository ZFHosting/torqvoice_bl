import { workOrderPaymentsGET } from '@/features/public-api/Resources/workOrderChildren'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-orders/{id}/payments` (docs/fork/API.md §4). */
export const GET = workOrderPaymentsGET
