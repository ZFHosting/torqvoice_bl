/**
 * fork: who may run the Shopmonkey import (docs/fork/milestones/M8-import-ui.md, Acceptance): the owner or an admin
 * of the workshop, with the settings permission on top. A member, whatever role they were given, gets `forbidden`:
 * an import rewrites the workshop's history, and a cutover ends the sync for good. What runs the connector (reading
 * Shopmonkey, or a job the queue would refuse on the plan: extract, resume, load, cutover) also needs a plan with it
 * (`plan: true`), refused as `gated` for the screen to offer the upgrade rather than queued for the job to fail. What
 * doesn't (the mapping, the reconciliation, stopping an extract, undoing a load) stays open on any plan, so a workshop
 * that downgraded can still take an import back out.
 */
import { connectorAllowed } from '@/features/integrations/Lib/plan'
import { getManifest } from '@/integrations/registry'
import { FeatureGatedError, getFeatures } from '@/lib/features'
import { type ActionResult, type AuthContext, withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'

const NOT_ADMIN = 'Only the owner or an admin can run the Shopmonkey import.'

export async function withImportAuth<T>(
  fn: (ctx: AuthContext) => Promise<T>,
  options: { write: boolean; plan?: boolean }
): Promise<ActionResult<T>> {
  const result = await withAuth(
    async (ctx) => {
      if (!ctx.isAdmin) throw new Error(NOT_ADMIN)
      if (options.plan) {
        const manifest = getManifest('shopmonkey')
        if (manifest && !connectorAllowed(manifest, await getFeatures(ctx.organizationId))) {
          throw new FeatureGatedError(
            manifest.plan ?? 'integrations',
            `${manifest.name} is not included in your plan.`
          )
        }
      }
      return fn(ctx)
    },
    {
      requiredPermissions: [
        {
          action: options.write ? PermissionAction.UPDATE : PermissionAction.READ,
          subject: PermissionSubject.SETTINGS,
        },
      ],
    }
  )
  return !result.success && result.error === NOT_ADMIN ? { ...result, forbidden: true } : result
}

/** The workshop's Shopmonkey connection, or an error the screen shows. Scoped by workshop, never by id alone. */
export async function shopmonkeyConnection(organizationId: string) {
  const { db } = await import('@/lib/db')
  const connection = await db.integrationConnection.findUnique({
    where: { organizationId_connectorId: { organizationId, connectorId: 'shopmonkey' } },
    select: { id: true, status: true, state: true, createdById: true },
  })
  if (!connection) throw new Error('Connect Shopmonkey first.')
  return {
    ...connection,
    state: ((connection.state as Record<string, unknown> | null) ?? {}) as Record<string, unknown>,
  }
}
