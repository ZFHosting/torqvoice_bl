/**
 * fork: saving a Shopmonkey extract's checkpoint (M3) only while it is still the connection's run.
 *
 * A new start (`startShopmonkeyExtract`) or the CLI taking over writes a new `runId`. The run it replaced
 * may be in the middle of a unit: a plain `saveState` would put the old run back over the new one. This
 * writes the checkpoint in one statement that matches on the stored `runId`, so the replaced run's save
 * changes nothing, it learns it was replaced, and stops.
 */
import type { ExtractState } from '@/integrations/shopmonkey/extract/plan'
import { db } from '@/lib/db'

export async function saveExtractState(
  scope: { connectionId: string; organizationId: string },
  next: ExtractState,
  client: Pick<typeof db, '$executeRaw'> = db
): Promise<boolean> {
  const written = await client.$executeRaw`
    UPDATE "public"."integration_connections"
    SET "state" = jsonb_set(COALESCE("state", '{}'::jsonb), '{extract}', ${JSON.stringify(next)}::jsonb),
        "updatedAt" = now()
    WHERE "id" = ${scope.connectionId}
      AND "organizationId" = ${scope.organizationId}
      AND "state"->'extract'->>'runId' = ${next.runId}`
  return written === 1
}
