import { getRoute } from '@/features/public-api/Lib/readResource'
import { inventoryPartsResource } from '@/features/public-api/Resources/catalog'
import {
  deleteInventoryPartDELETE,
  updateInventoryPartPATCH,
} from '@/features/public-api/Writes/catalog'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/inventory-parts/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(inventoryPartsResource)

/** `PATCH /api/v1/inventory-parts/{id}` (docs/fork/API.md §4). */
export const PATCH = updateInventoryPartPATCH

/** `DELETE /api/v1/inventory-parts/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteInventoryPartDELETE
