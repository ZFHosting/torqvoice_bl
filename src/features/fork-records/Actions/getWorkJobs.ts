'use server'

import { withAuth } from '@/lib/with-auth'
import { jobPermission } from '../Lib/jobPermission'
import { jobsOf } from '../Lib/forkRecordServices.server'
import { getWorkJobsInput } from '../Schema/workJobActionSchemas'

/** fork (M9): a work order's or quote's jobs, in order, and whether the workshop uses jobs at all. */
export async function getWorkJobs(input: unknown) {
  const parsed = getWorkJobsInput.safeParse(input)
  if (!parsed.success) return { success: false as const, error: 'Invalid request' }
  const { parent } = parsed.data
  return withAuth(
    ({ organizationId, userId }) => jobsOf({ organizationId, userId, actor: 'user' }, parent),
    { requiredPermissions: [jobPermission(parent.kind, false)] }
  )
}
