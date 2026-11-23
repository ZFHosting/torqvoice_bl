/**
 * fork: a part line links only to this workshop's inventory (A4). The app's pickers only offer the workshop's own
 * parts; an id sent by an API client (or a page of another workshop) can be anyone's, and would be stored linked to
 * it.
 *
 * Two strengths. The services the app's forms save through (work orders, quotes, labor presets) refuse an id of
 * another workshop's part, and nothing more: a line keeps the id of a part deleted since (the column has no foreign
 * key, and stock reconciling skips an id it can't find), and the forms send it back on every save, which must keep
 * working. Adding one line through the API (`/work-orders/{id}/lines`) asks for a part that exists here.
 */
import 'server-only'
import { db } from '@/lib/db'

type PartLinks = readonly { inventoryPartId?: string | null }[] | null | undefined

function idsOf(parts: PartLinks): string[] {
  return [
    ...new Set((parts ?? []).map((p) => p.inventoryPartId).filter((id): id is string => !!id)),
  ]
}

/** No part of another workshop's: an id that names no part at all (deleted since) is left as it is. */
export async function assertNoForeignInventoryParts(
  parts: PartLinks,
  organizationId: string
): Promise<void> {
  const ids = idsOf(parts)
  if (ids.length === 0) return
  const foreign = await db.inventoryPart.count({
    where: { id: { in: ids }, NOT: { organizationId } },
  })
  if (foreign > 0) throw new Error('Inventory part not found')
}

/** Every part named is this workshop's, and exists. */
export async function assertOwnInventoryParts(
  parts: PartLinks,
  organizationId: string
): Promise<void> {
  const ids = idsOf(parts)
  if (ids.length === 0) return
  const own = await db.inventoryPart.count({ where: { id: { in: ids }, organizationId } })
  if (own !== ids.length) throw new Error('Inventory part not found')
}
