import { getRoute } from '@/features/public-api/Lib/readResource'
import { customersResource } from '@/features/public-api/Resources/customers'
import { deleteCustomerDELETE, updateCustomerPATCH } from '@/features/public-api/Writes/customers'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/customers/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(customersResource)

/** `PATCH /api/v1/customers/{id}` (docs/fork/API.md §4). */
export const PATCH = updateCustomerPATCH

/** `DELETE /api/v1/customers/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteCustomerDELETE
