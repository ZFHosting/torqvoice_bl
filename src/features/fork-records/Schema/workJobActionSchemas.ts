/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 1): what the work order and quote screens send to change
 * a document's jobs.
 */
import { z } from 'zod'

/** The work order or quote a job belongs to. */
export const jobParentSchema = z.object({
  kind: z.enum(['workOrder', 'quote']),
  id: z.string().min(1).max(64),
})
export type JobParent = z.infer<typeof jobParentSchema>

/** A document's jobs as its page shows them (`pageJobs.server.ts`). */
export interface PageJobs {
  jobs: { id: string; name: string; note: string | null; authorizationStatus: string | null }[]
}

const jobId = z.string().min(1).max(64)
const name = z.string().trim().min(1).max(200)
const note = z.string().trim().max(2000).nullable()

export const getWorkJobsInput = z.object({ parent: jobParentSchema })
export const createWorkJobInput = z.object({ parent: jobParentSchema, name, note: note.optional() })
export const updateWorkJobInput = z.object({ parent: jobParentSchema, jobId, name, note })
export const deleteWorkJobInput = z.object({ parent: jobParentSchema, jobId })
export const reorderWorkJobsInput = z.object({
  parent: jobParentSchema,
  jobIds: z.array(jobId).min(1).max(500),
})
