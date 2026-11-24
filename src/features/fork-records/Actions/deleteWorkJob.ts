'use server'

import { withAuth } from '@/lib/with-auth'
import { jobEvent } from '../Lib/forkRecordAuditEvents'
import { deleteJobOn } from '../Lib/forkRecordServices.server'
import { jobPermission } from '../Lib/jobPermission'
import { deleteWorkJobInput } from '../Schema/workJobActionSchemas'

/** fork (M9): a job goes, its lines stay on the document under no job; `job.delete`, as from the API. */
export async function deleteWorkJob(input: unknown) {
  const parsed = deleteWorkJobInput.safeParse(input)
  if (!parsed.success) return { success: false as const, error: 'Invalid job' }
  const { parent, jobId } = parsed.data
  return withAuth(
    ({ organizationId, userId }) =>
      deleteJobOn({ organizationId, userId, actor: 'user' }, parent, jobId),
    {
      requiredPermissions: [jobPermission(parent.kind, true)],
      audit: ({ result }) => jobEvent('delete', result),
    }
  )
}
