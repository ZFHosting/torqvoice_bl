/**
 * The cutover command's arguments (`scripts/shopmonkey/run.ts cutover`, M7 task 5).
 */
import type { CutoverResult } from './cutover'

export interface CutoverArgs {
  connection: string
  shopStopped: boolean
  dryRun: boolean
  /** The member doing it; the connection's creator unless given. */
  user: string | null
}

export const CUTOVER_USAGE =
  'Usage: run.ts cutover --connection <id> --shop-stopped [--dry-run] [--user <id>]'

export function parseCutoverArgs(argv: string[]): CutoverArgs {
  const [command, ...rest] = argv
  if (command !== 'cutover') throw new Error(CUTOVER_USAGE)
  const out: CutoverArgs = { connection: '', shopStopped: false, dryRun: false, user: null }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const value = () => {
      const next = rest[++i]
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value. ${CUTOVER_USAGE}`)
      return next
    }
    if (flag === '--connection') out.connection = value()
    else if (flag === '--shop-stopped') out.shopStopped = true
    else if (flag === '--dry-run') out.dryRun = true
    else if (flag === '--user') out.user = value()
    else throw new Error(`Unknown option ${flag}. ${CUTOVER_USAGE}`)
  }
  if (!out.connection) throw new Error(`--connection is required. ${CUTOVER_USAGE}`)
  return out
}

/** The closing lines, after each step's own line. */
export function formatCutoverResult(result: CutoverResult): string[] {
  if (result.completed) {
    return [
      result.dryRun
        ? 'Dry run: every step would go ahead. Nothing in the workshop was changed.'
        : 'Cut over. Torqvoice no longer follows Shopmonkey.',
    ]
  }
  return [
    `Stopped at step ${result.stoppedAt}${result.dryRun ? ' (dry run)' : ''}. Nothing after it ${result.dryRun ? 'was tried' : 'was done'}.`,
  ]
}
