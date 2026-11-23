import { workOrderPaymentsGET } from '@/features/public-api/Resources/workOrderChildren'
import { createPaymentPOST } from '@/features/public-api/Writes/workOrders'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-orders/{id}/payments` (docs/fork/API.md §4). */
export const GET = workOrderPaymentsGET

/** `POST /api/v1/work-orders/{id}/payments` (docs/fork/API.md §4). */
export const POST = createPaymentPOST
