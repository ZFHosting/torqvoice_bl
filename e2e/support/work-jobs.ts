import { randomBytes } from 'node:crypto'
import { Client } from 'pg'

/**
 * fork (M9): the jobs spec's look into the suite's database: whether the workshop has jobs, jobs put on a work order
 * as the Shopmonkey import or the API would (a job with a line under it, and one without), and the work order removed
 * again (its lines and jobs go with it). Plain pg, as `support/db.ts` does.
 */
async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const url = process.env.E2E_DATABASE_URL
  if (!url) throw new Error('E2E_DATABASE_URL is not set. See e2e/README.md.')
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    return await fn(db)
  } finally {
    await db.end()
  }
}

const id = () => `e2e${randomBytes(10).toString('hex')}`

/** Whether the work order's workshop has any job. */
export async function workshopHasJobs(workOrderId: string): Promise<boolean> {
  return withDb(async (db) => {
    const result = await db.query(
      `select 1 from work_jobs j
         join service_records s on s."organizationId" = j."organizationId"
        where s.id = $1 limit 1`,
      [workOrderId]
    )
    return (result.rowCount ?? 0) > 0
  })
}

/** Two jobs on the work order, first `withLine` with the labor line described so under it, then `empty`. */
export async function addJobs(
  workOrderId: string,
  jobs: { withLine: string; empty: string },
  line: string
): Promise<void> {
  await withDb(async (db) => {
    const org = await db.query<{ organizationId: string }>(
      `select "organizationId" from service_records where id = $1`,
      [workOrderId]
    )
    const organizationId = org.rows[0]?.organizationId
    if (!organizationId) throw new Error(`no work order ${workOrderId}`)
    const first = id()
    for (const [jobId, name, ordinal] of [
      [first, jobs.withLine, 0],
      [id(), jobs.empty, 1],
    ] as const) {
      await db.query(
        `insert into work_jobs (id, "organizationId", "serviceRecordId", name, ordinal, "updatedAt")
         values ($1, $2, $3, $4, $5, now())`,
        [jobId, organizationId, workOrderId, name, ordinal]
      )
    }
    await db.query(
      `update service_labor set "jobId" = $1 where "serviceRecordId" = $2 and description = $3`,
      [first, workOrderId, line]
    )
  })
}

/** Removes the work order, and with it its lines and jobs. */
export async function removeWorkOrder(workOrderId: string): Promise<void> {
  await withDb((db) => db.query(`delete from service_records where id = $1`, [workOrderId]))
}
