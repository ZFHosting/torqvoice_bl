import { workOrderAttachmentsGET } from '@/features/public-api/Resources/workOrderChildren'
import { createAttachmentPOST } from '@/features/public-api/Writes/workOrders'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/work-orders/{id}/attachments` (docs/fork/API.md §4). */
export const GET = workOrderAttachmentsGET

/** `POST /api/v1/work-orders/{id}/attachments` (docs/fork/API.md §4). */
export const POST = createAttachmentPOST
