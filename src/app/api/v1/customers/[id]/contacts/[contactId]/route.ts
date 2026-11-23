import { deleteContactDELETE, updateContactPATCH } from '@/features/public-api/Writes/contacts'

export const dynamic = 'force-dynamic'

/** `PATCH /api/v1/customers/{id}/contacts/{contactId}` (docs/fork/API.md §4). */
export const PATCH = updateContactPATCH

/** `DELETE /api/v1/customers/{id}/contacts/{contactId}` (docs/fork/API.md §4). */
export const DELETE = deleteContactDELETE
