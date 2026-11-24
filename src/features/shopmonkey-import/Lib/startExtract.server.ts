/**
 * fork: starting a Shopmonkey extract (docs/fork/milestones/M3-extract-and-stage.md). Writes a fresh
 * run into the connection's `state.extract` (keeping what earlier runs learned: each table's children
 * signature and watermark) and queues its first `extract.step` job; the job reschedules itself until the
 * run is done. Starting again replaces a run in progress: the old run's job sees a different `runId`
 * and stops.
 *
 * The M8 import screen calls this through a server action; the CLI drives the steps in-process instead.
 */
import { randomUUID } from 'node:crypto'
import { enqueueJob } from '@/features/integrations/Lib/jobs'
import { type ExtractState, startState } from '@/integrations/shopmonkey/extract/plan'
import { db } from '@/lib/db'

export interface StartExtractInput {
  organizationId: string
  connectionId: string
  /** Only records updated since then, where Shopmonkey's list can filter. */
  since?: string | null
  /** Only these tables. */
  only?: string[] | null
}

export async function startShopmonkeyExtract(input: StartExtractInput): Promise<{ runId: string }> {
  // Scoped by workshop: a connection id from the browser can belong to another one.
  const connection = await db.integrationConnection.findFirst({
    where: {
      id: input.connectionId,
      organizationId: input.organizationId,
      connectorId: 'shopmonkey',
    },
    select: { id: true, state: true },
  })
  if (!connection) throw new Error('Shopmonkey connection not found')
  const state = (connection.state as Record<string, unknown> | null) ?? {}
  // M7: after cutover nothing more is read from Shopmonkey.
  if (state.cutover)
    throw new Error('The import is cut over: nothing more is read from Shopmonkey.')
  const runId = randomUUID()
  const extract: ExtractState = startState(state.extract as Partial<ExtractState> | undefined, {
    runId,
    since: input.since ?? null,
    only: input.only ?? null,
    now: new Date(),
  })
  // The run in progress, if any, saves its checkpoints only while its runId is the stored one
  // (extractState.server.ts), so this write replaces it for good.
  await db.integrationConnection.updateMany({
    where: { id: connection.id, organizationId: input.organizationId },
    data: { state: { ...state, extract } as object },
  })
  await enqueueJob({
    connectionId: connection.id,
    organizationId: input.organizationId,
    kind: 'extract.step',
    payload: { runId },
    idempotencyKey: `extract:${runId}`,
  })
  return { runId }
}
