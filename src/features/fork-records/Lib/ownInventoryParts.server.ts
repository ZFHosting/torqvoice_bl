/**
 * fork: a part line links only to this workshop's inventory (A4). The app's pickers only offer the workshop's own
 * parts; an id sent by an API client (or a page of another workshop) can be anyone's, and would be stored linked to
 * it. Called by every service that writes part lines: work orders, quotes, one line at a time, labor presets.
 */
import 'server-only'
import { db } from '@/lib/db'

export async function assertOwnInventoryParts(
  parts: readonly { inventoryPartId?: string | null }[] | null | undefined,
  organizationId: string
): Promise<void> {
  const ids = [
    ...new Set((parts ?? []).map((p) => p.inventoryPartId).filter((id): id is string => !!id)),
  ]
  if (ids.length === 0) return
  const own = await db.inventoryPart.count({ where: { id: { in: ids }, organizationId } })
  if (own !== ids.length) throw new Error('Inventory part not found')
}
