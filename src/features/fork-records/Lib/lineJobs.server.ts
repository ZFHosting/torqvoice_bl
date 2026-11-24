/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 1): the job each line of a work order's or quote's save is
 * under. The editors send a line's `jobId` (so a line moved between jobs is saved as moved), and so may an API body.
 * Each sent id is kept only when it is a job of that document in this workshop, never someone else's. `''` or null is
 * no job. Through the API any other id is a 404, as every id naming another record is (API.md §3). From the page it
 * is as if the line had sent none: the save carries over the job of the line it replaces (`carryLineColumns`), so a
 * page that still holds job ids the Shopmonkey sync has since recreated keeps each line's new job, and a job deleted in
 * another tab leaves its lines under none, as the delete left them. A line that sends no id is carried the same way.
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
  return lines.map((line) => {
    if (line.jobId === undefined || owned.has(line.jobId as string)) return line
    if (!line.jobId) return { ...line, jobId: null }
    // An id that isn't the document's: left to the carry, as an old page's unsent one is.
    const { jobId: _stale, ...rest } = line
    return rest as L
  })
}
