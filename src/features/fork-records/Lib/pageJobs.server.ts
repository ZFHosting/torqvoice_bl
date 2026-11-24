/**
 * fork (M9): what a work order's or quote's page needs to show its Jobs card, read in the page's server component:
 * the document's jobs, or null for a workshop without jobs (the page is then as upstream draws it, and asks nothing
 * more).
 */
import 'server-only'
import type { JobParent, PageJobs } from '../Schema/workJobActionSchemas'
import { jobsOf } from './forkRecordServices.server'

export async function pageJobs(
  organizationId: string,
  parent: JobParent
): Promise<PageJobs | null> {
  const view = await jobsOf({ organizationId, userId: '', actor: 'user' }, parent)
  return view.usesJobs ? { jobs: view.jobs } : null
}
