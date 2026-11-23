/**
 * The extract's run order and checkpoints (docs/fork/milestones/M3-extract-and-stage.md, tasks 3 and 6).
 *
 * Settings → staff → customers (+ their vehicles) → vehicles (+ owners) → catalog → orders (+ services,
 * payments, authorizations, files, PDFs, and any customer or vehicle they name that no list returned) →
 * the late sweeps for those customers and vehicles → calendar → inspections → time → archive-only tables.
 * Each step starts only when the one before it has finished: its list read to the end, then its
 * children fetched for every parent that needs them.
 *
 * The state lives in the connection's `state.extract` and is saved after every unit of work, so a run
 * killed anywhere resumes from its last page: a page is fetched again only if the run died between
 * fetching it and saving the checkpoint after it.
 */
import { TABLES, type TableSpec, tableSpec } from './tables'

export interface PlanStep {
  /** The checkpoint's key: the table, or `<table>:late` for a second children sweep. */
  key: string
  table: string
  /** Whether the step reads the table's list; a late sweep only fetches children. */
  list: boolean
}

export function fullPlan(): PlanStep[] {
  const steps: PlanStep[] = []
  for (const spec of TABLES) {
    steps.push({ key: spec.table, table: spec.table, list: spec.list.kind !== 'none' })
    if (spec.table === 'order') {
      // Orders name customers and vehicles no list returned; their own children come after.
      steps.push({ key: 'customer:late', table: 'customer', list: false })
      steps.push({ key: 'vehicle:late', table: 'vehicle', list: false })
    }
  }
  return steps
}

/** The plan, limited to some tables (`--tables`), in the same order. */
export function planFor(only: readonly string[] | null): PlanStep[] {
  const plan = fullPlan()
  if (!only?.length) return plan
  for (const table of only) tableSpec(table) // throws on a name that isn't a table
  return plan.filter((step) => only.includes(step.table))
}

export interface StepCounts {
  created: number
  updated: number
  unchanged: number
  /** Records left out: another location's, or files that couldn't be staged. */
  skipped: number
}

/** What a step's children sweep did: the children's own records, and the parents they came from. */
export interface ChildCounts extends StepCounts {
  /** Parents whose children were fetched. */
  parents: number
  /** Children that no longer come back from their parent, marked deleted. */
  gone: number
  /** Children or references Shopmonkey answered 404 for. */
  missing: number
  /** Parents left pending because a file failed for now: the next run fetches their children again. */
  retry: number
}

export interface StepCheckpoint {
  /** `delta` when the run reads changes since a date; `backfill` reads everything. */
  phase: 'backfill' | 'delta'
  stage: 'list' | 'children' | 'done'
  /** Rows of the list already read: the next page starts here. */
  skip: number
  /** The newest `updatedDate` staged in this step, where the next delta starts. */
  highWatermark: string | null
  /** `meta.total` from the first page, when Shopmonkey gives one. */
  total: number | null
  /** First and last id of the last full page: the same again means a skip the server ignores. */
  lastPage: string | null
  /** The children sweep's position (a SourceRecord id). */
  cursor: string | null
  /** The table's own records, as listed. */
  counts: StepCounts
  children: ChildCounts
  /** Why the step was skipped (an optional table whose list isn't there). */
  skippedReason?: string
}

export interface ExtractState {
  runId: string
  startedAt: string
  finishedAt: string | null
  /** Only records updated since then, where the list can filter (`--since`). */
  since: string | null
  /** Only these tables (`--tables`). */
  only: string[] | null
  /** The index in the plan of the step being worked on. */
  step: number
  steps: Record<string, StepCheckpoint>
  /** Per table, what its children were last fetched under; a change refetches them all. */
  childSignatures: Record<string, string>
  /** Per table, the newest `updatedDate` any finished run staged: where a later delta can start. */
  watermarks: Record<string, string>
  /** API calls made in this run. */
  calls: number
}

export function emptyCounts(): StepCounts {
  return { created: 0, updated: 0, unchanged: 0, skipped: 0 }
}

export function emptyChildCounts(): ChildCounts {
  return { ...emptyCounts(), parents: 0, gone: 0, missing: 0, retry: 0 }
}

export function newCheckpoint(
  phase: StepCheckpoint['phase'],
  spec: TableSpec,
  list: boolean
): StepCheckpoint {
  return {
    phase,
    stage: list && spec.list.kind !== 'none' ? 'list' : 'children',
    skip: 0,
    highWatermark: null,
    total: null,
    lastPage: null,
    cursor: null,
    counts: emptyCounts(),
    children: emptyChildCounts(),
  }
}

/**
 * A new run. What earlier runs learned (each table's children signature and watermark) carries over;
 * the checkpoints don't.
 */
export function startState(
  previous: Partial<ExtractState> | null | undefined,
  input: { runId: string; since?: string | null; only?: string[] | null; now: Date }
): ExtractState {
  if (input.since && Number.isNaN(new Date(input.since).getTime())) {
    throw new Error('since must be an ISO date')
  }
  planFor(input.only ?? null)
  return {
    runId: input.runId,
    startedAt: input.now.toISOString(),
    finishedAt: null,
    since: input.since ?? null,
    only: input.only?.length ? [...input.only] : null,
    step: 0,
    steps: {},
    childSignatures: { ...(previous?.childSignatures ?? {}) },
    watermarks: { ...(previous?.watermarks ?? {}) },
    calls: 0,
  }
}
