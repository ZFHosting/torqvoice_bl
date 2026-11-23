import { deleteAttachmentDELETE } from '@/features/public-api/Writes/workOrders'

export const dynamic = 'force-dynamic'

/** `DELETE /api/v1/work-orders/{id}/attachments/{attachmentId}` (docs/fork/API.md §4). */
export const DELETE = deleteAttachmentDELETE
