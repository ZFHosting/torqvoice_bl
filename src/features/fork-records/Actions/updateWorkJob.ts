'use server'

import { withAuth } from '@/lib/with-auth'
import { jobEvent } from '../Lib/forkRecordAuditEvents'
import { updateJobOn } from '../Lib/forkRecordServices.server'
import { jobPermission } from '../Lib/jobPermission'
import { updateWorkJobInput } from '../Schema/workJobActionSchemas'

/** fork (M9): a job's name and note; `job.update`, as from the API. */
export async function updateWorkJob(input: unknown) {
  const parsed = updateWorkJobInput.safeParse(input)
  if (!parsed.success) return { success: false as const, error: 'Invalid job' }
  const { parent, jobId, name, note } = parsed.data
  return withAuth(
    ({ organizationId, userId }) =>
      updateJobOn({ organizationId, userId, actor: 'user' }, parent, jobId, {
        name,
        note: note || null,
      }),
    {
      requiredPermissions: [jobPermission(parent.kind, true)],
      audit: ({ result }) => jobEvent('update', result),
    }
  )
}
