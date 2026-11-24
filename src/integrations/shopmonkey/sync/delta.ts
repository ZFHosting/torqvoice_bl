/**
 * The sync's delta extract (M7): what changed in Shopmonkey since the last run, read with the extract's own steps.
 * Each table starts at its watermark (the newest `updatedDate` a finished run staged) less an overlap, so a record
 * saved in Shopmonkey while the last run read its table, and dated a little before the newest one it saw, is read
 * again rather than missed. A table with no watermark starts where the last run did, less the same overlap.
 */
import type { ExtractDeps, SaveExtract } from '../extract/engine'
import { extractFor } from '../extract/engine'
import { type ExtractState, startState } from '../extract/plan'

/** How far back of each watermark a delta starts. */
export const OVERLAP_MS = 5 * 60_000

const minus = (iso: string, ms: number) => new Date(new Date(iso).getTime() - ms).toISOString()

/** A delta run starting from the last finished run's watermarks. */
export function deltaStart(
  previous: ExtractState,
  input: { runId: string; now: Date; sync?: boolean }
): ExtractState {
  const sinceByTable = Object.fromEntries(
    Object.entries(previous.watermarks ?? {}).map(([table, mark]) => [
      table,
      minus(mark, OVERLAP_MS),
    ])
  )
  return startState(previous, {
    runId: input.runId,
    since: minus(previous.startedAt, OVERLAP_MS),
    sinceByTable,
    sync: input.sync,
    now: input.now,
  })
}

/** Records a run wrote or marked deleted: whether a load has anything to do. */
export function changedRecords(state: ExtractState): number {
  let total = 0
  for (const cp of Object.values(state.steps)) {
    total +=
      cp.counts.created +
      cp.counts.updated +
      cp.children.created +
      cp.children.updated +
      cp.children.gone
  }
  return total
}

/** Drives a delta to its end, or until `budgetMs` has passed (then it carries on from its saved state). */
export function driveDelta(
  deps: ExtractDeps,
  state: ExtractState,
  options: { budgetMs: number; save: SaveExtract }
) {
  return extractFor(deps, state, options)
}
