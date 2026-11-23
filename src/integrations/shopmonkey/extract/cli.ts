/**
 * The extract CLI's logic (`scripts/shopmonkey/run.ts extract`, M3 task 7): arguments, resuming, and
 * the progress line. It drives the same `extractStep` the job runs, in-process and without pauses, which
 * is what an initial backfill of a large shop wants.
 */
import { PAGE_SIZE } from '../client'
import { type ExtractDeps, extractStep } from './engine'
import { type ExtractState, planFor, startState } from './plan'

export interface ExtractArgs {
  connection: string
  tables: string[] | null
  since: string | null
  /** Start over even when an unfinished run could be resumed. */
  restart: boolean
}

export const USAGE =
  'Usage: run.ts extract --connection <id> [--tables a,b] [--since <ISO date>] [--restart]'

export function parseExtractArgs(argv: string[]): ExtractArgs {
  const [command, ...rest] = argv
  if (command !== 'extract') throw new Error(USAGE)
  const out: ExtractArgs = { connection: '', tables: null, since: null, restart: false }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const value = () => {
      const next = rest[++i]
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value. ${USAGE}`)
      return next
    }
    if (flag === '--connection') out.connection = value()
    else if (flag === '--tables')
      out.tables = value()
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    else if (flag === '--since') out.since = value()
    else if (flag === '--restart') out.restart = true
    else throw new Error(`Unknown option ${flag}. ${USAGE}`)
  }
  if (!out.connection) throw new Error(`--connection is required. ${USAGE}`)
  if (out.since && Number.isNaN(new Date(out.since).getTime())) {
    throw new Error('--since must be an ISO date')
  }
  return out
}

/**
 * The run to drive: an unfinished one carries on (under a new run id, so a job chain still queued for
 * it stops), unless the arguments ask for something else; otherwise a new run.
 */
export function runToDrive(
  previous: Partial<ExtractState> | null | undefined,
  args: ExtractArgs,
  runId: string,
  now: Date
): { state: ExtractState; resumed: boolean } {
  const resumable =
    previous?.runId && !previous.finishedAt && previous.steps && previous.step !== undefined
  if (resumable && !args.restart && !args.since && !args.tables) {
    return { state: { ...(previous as ExtractState), runId }, resumed: true }
  }
  return {
    state: startState(previous, { runId, since: args.since, only: args.tables, now }),
    resumed: false,
  }
}

/** `[4/42] customer  list 200/1,234 · 118 calls/min · ~9 min left` */
export function formatProgress(state: ExtractState, callsPerMinute: number): string {
  const plan = planFor(state.only)
  if (state.step >= plan.length) return `done · ${state.calls} calls`
  const step = plan[state.step]
  const cp = state.steps[step.key]
  const rate = `${Math.round(callsPerMinute)} calls/min`
  const head = `[${state.step + 1}/${plan.length}] ${step.key}`
  if (!cp || cp.stage === 'list') {
    const skip = cp?.skip ?? 0
    const total = cp?.total ?? null
    if (total === null) return `${head}  list ${skip.toLocaleString('en')} · ${rate}`
    const left = Math.max(0, Math.ceil((total - skip) / PAGE_SIZE))
    const eta = callsPerMinute > 0 ? ` · ~${Math.ceil(left / callsPerMinute)} min left` : ''
    return `${head}  list ${skip.toLocaleString('en')}/${total.toLocaleString('en')} · ${rate}${eta}`
  }
  return `${head}  children of ${cp.children.parents.toLocaleString('en')} fetched · ${rate}`
}

/** Steps until done, saving after each and printing progress at most every `everyMs`. */
export async function driveExtract(options: {
  deps: ExtractDeps
  state: ExtractState
  save: (state: ExtractState) => Promise<void>
  print: (line: string) => void
  clock?: () => number
  everyMs?: number
}): Promise<ExtractState> {
  const clock = options.clock ?? Date.now
  const every = options.everyMs ?? 5000
  const started = clock()
  const callsAtStart = options.state.calls
  let printed = Number.NEGATIVE_INFINITY
  let state = options.state
  for (;;) {
    const result = await extractStep(options.deps, state)
    await options.save(result.state)
    state = result.state
    const now = clock()
    const minutes = Math.max((now - started) / 60_000, 1 / 60)
    if (result.done || now - printed >= every) {
      options.print(formatProgress(state, (state.calls - callsAtStart) / minutes))
      printed = now
    }
    if (result.done) return state
  }
}
