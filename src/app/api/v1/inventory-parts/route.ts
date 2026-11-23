import { listRoute } from '@/features/public-api/Lib/readResource'
import { inventoryPartsResource } from '@/features/public-api/Resources/catalog'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/inventory-parts` (docs/fork/API.md §4). */
export const GET = listRoute(inventoryPartsResource)
