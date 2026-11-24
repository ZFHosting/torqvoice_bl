/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 1): the job each line of a work order's or quote's save is
 * under. The editors send a line's `jobId` (so a line moved between jobs is saved as moved), and so may an API body.
 * Each sent id is kept only when it is a job of that document in this workshop, never someone else's. From the page,
 * anything else (a job deleted in another tab since it loaded) saves the line under no job, as the delete left the
 * saved lines; through the API it is a 404, as every id naming another record is (API.md §3). `''` or null is no job
 * from either. A line that doesn't send one is left to the save, which carries its job over (`carryLineColumns`).
 */
import 'server-only'
import { db } from '@/lib/db'

type Owner = { serviceRecordId: string } | { quoteId: string }

/**
 * `lines` with each sent `jobId` checked against `owner`'s jobs (`owner` null: a new document, which has none);
 * `refuse` for an API caller.
 */
export async function ownLineJobs<L extends { jobId?: string | null }>(
  organizationId: string,
  owner: Owner | null,
  lines: L[] | undefined,
  refuse = false
): Promise<L[] | undefined> {
  if (!lines?.some((line) => line.jobId !== undefined)) return lines
  const sent = [
    ...new Set(
      lines.flatMap((line) => (typeof line.jobId === 'string' && line.jobId ? [line.jobId] : []))
    ),
  ]
  const owned =
    owner && sent.length
      ? new Set(
          (
            await db.workJob.findMany({
              where: { id: { in: sent }, organizationId, ...owner },
              select: { id: true },
            })
          ).map((job) => job.id)
        )
      : new Set<string>()
  if (refuse && sent.some((id) => !owned.has(id))) throw new Error('Job not found')
  return lines.map((line) =>
    line.jobId === undefined
      ? line
      : { ...line, jobId: line.jobId && owned.has(line.jobId) ? line.jobId : null }
  )
}
