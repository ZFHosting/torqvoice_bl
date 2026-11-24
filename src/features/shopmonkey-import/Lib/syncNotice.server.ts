/**
 * fork: whether a record is still synced from Shopmonkey (M7 task 4, built in M8): it was loaded from Shopmonkey by a
 * connection of this workshop that is live and not cut over. Then the record's page says so, since an edit made here
 * is overwritten by the next change made in Shopmonkey.
 */
import { db } from '@/lib/db'

export type SyncedModel = 'ServiceRecord' | 'Customer' | 'Vehicle'

/** Null when the record isn't synced from Shopmonkey (never imported, or the import is cut over). */
export async function shopmonkeySyncNotice(
  organizationId: string,
  model: SyncedModel,
  id: string
): Promise<{ lastSyncAt: string | null } | null> {
  if (!organizationId || !id) return null
  try {
    return await lookup(organizationId, model, id)
  } catch {
    // A banner isn't worth a page that fails to open.
    return null
  }
}

async function lookup(
  organizationId: string,
  model: SyncedModel,
  id: string
): Promise<{ lastSyncAt: string | null } | null> {
  const link = await db.integrationLink.findFirst({
    where: {
      entityType: model,
      entityId: id,
      // A link's workshop is its connection's.
      connection: {
        organizationId,
        connectorId: 'shopmonkey',
        status: { in: ['active', 'error'] },
      },
    },
    select: { connection: { select: { state: true } } },
  })
  if (!link) return null
  const state = (link.connection.state ?? {}) as {
    cutover?: unknown
    lastSync?: { at?: string }
    lastLoad?: { finishedAt?: string }
  }
  if (state.cutover) return null
  return { lastSyncAt: state.lastSync?.at ?? state.lastLoad?.finishedAt ?? null }
}
