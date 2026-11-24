'use server'

import { logAudit } from '@/lib/audit'
import { withAuth } from '@/lib/with-auth'
import { jobEvent } from '../Lib/forkRecordAuditEvents'
import { reorderJobsOn } from '../Lib/forkRecordServices.server'
import { jobPermission } from '../Lib/jobPermission'
import { reorderWorkJobsInput } from '../Schema/workJobActionSchemas'

/**
 * fork (M9): a document's jobs in a new order. Each job that moved is one `job.update` (its `ordinal`), as a PATCH
 * through the API would be, so a subscriber hears of every job it holds that changed.
 */
export async function reorderWorkJobs(input: unknown) {
  const parsed = reorderWorkJobsInput.safeParse(input)
  if (!parsed.success) return { success: false as const, error: 'Invalid order' }
  const { parent, jobIds } = parsed.data
  return withAuth(
    async (ctx) => {
      const moved = await reorderJobsOn(
        { organizationId: ctx.organizationId, userId: ctx.userId, actor: 'user' },
        parent,
        jobIds
      )
      for (const job of moved) await logAudit(ctx, jobEvent('update', job))
      return { moved: moved.length }
    },
    { requiredPermissions: [jobPermission(parent.kind, true)] }
  )
}
