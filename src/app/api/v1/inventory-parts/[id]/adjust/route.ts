import { adjustInventoryStockPOST } from '@/features/public-api/Writes/catalog'

export const dynamic = 'force-dynamic'

/** `POST /api/v1/inventory-parts/{id}/adjust` (docs/fork/API.md §4). */
export const POST = adjustInventoryStockPOST
