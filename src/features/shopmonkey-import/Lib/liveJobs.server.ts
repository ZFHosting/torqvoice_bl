/**
 * fork (M8): what the import has queued or running, read from the job queue itself rather than from what the
 * connection's state last said: a job that died before it could write its end (a paused connection, a crash) would
 * otherwise leave the screen waiting for ever, and a second click from another tab would queue a second run.
 */
import { db } from '@/lib/db'

export interface LiveJobs {
  /** An extract being driven: the operator's (`extract.step`) or the ten-minute sync's (`sync.delta`). */
  extract: boolean
  /** A load or dry run the screen queued (`load.run`). */
  load: boolean
  /** A cutover or its dry run (`cutover.run`). */
  cutover: boolean
}

export async function liveJobs(organizationId: string, connectionId: string): Promise<LiveJobs> {
  const rows = await db.integrationJob.findMany({
    where: {
      organizationId,
      connectionId,
      status: { in: ['queued', 'running'] },
      kind: { in: ['extract.step', 'sync.delta', 'load.run', 'cutover.run'] },
    },
    select: { kind: true },
  })
  const kinds = new Set(rows.map((r) => r.kind))
  return {
    extract: kinds.has('extract.step') || kinds.has('sync.delta'),
    load: kinds.has('load.run'),
    cutover: kinds.has('cutover.run'),
  }
}
