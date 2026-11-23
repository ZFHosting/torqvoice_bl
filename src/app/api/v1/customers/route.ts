import { listRoute } from '@/features/public-api/Lib/readResource'
import { customersResource } from '@/features/public-api/Resources/customers'
import { createCustomerPOST } from '@/features/public-api/Writes/customers'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/customers` (docs/fork/API.md §4). */
export const GET = listRoute(customersResource)

/** `POST /api/v1/customers` (docs/fork/API.md §4). */
export const POST = createCustomerPOST
