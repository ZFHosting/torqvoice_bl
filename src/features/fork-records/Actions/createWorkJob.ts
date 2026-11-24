'use server'

import { withAuth } from '@/lib/with-auth'
import { jobEvent } from '../Lib/forkRecordAuditEvents'
import { createJobOn } from '../Lib/forkRecordServices.server'
import { jobPermission } from '../Lib/jobPermission'
import { createWorkJobInput } from '../Schema/workJobActionSchemas'

/** fork (M9): a new job on a work order or quote, last in its order; `job.create`, as from the API. */
export async function createWorkJob(input: unknown) {
  const parsed = createWorkJobInput.safeParse(input)
  if (!parsed.success) return { success: false as const, error: 'Invalid job' }
  const { parent, name, note } = parsed.data
  return withAuth(
    ({ organizationId, userId }) =>
      createJobOn({ organizationId, userId, actor: 'user' }, parent, {
        name,
        ...(note ? { note } : {}),
      }),
    {
      requiredPermissions: [jobPermission(parent.kind, true)],
      audit: ({ result }) => jobEvent('create', result),
    }
  )
}
