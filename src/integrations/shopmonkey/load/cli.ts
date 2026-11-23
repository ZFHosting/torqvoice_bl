/**
 * The load CLI's logic (`scripts/shopmonkey/run.ts load`, M5 tasks 9 and 11): arguments and the summary it
 * prints. A dry run executes every transaction and rolls it back, so its summary is what a real run would change.
 */
import type { LoadSummary } from './run'
import type { UndoResult } from './undo'

export interface LoadArgs {
  connection: string
  dryRun: boolean
  applyNumbering: boolean
  applySettings: boolean
  /** The member the run acts as; the connection's creator unless given. */
  user: string | null
}

export const LOAD_USAGE =
  'Usage: run.ts load --connection <id> [--dry-run] [--apply-numbering] [--apply-settings] [--user <id>]'

export function parseLoadArgs(argv: string[]): LoadArgs {
  const [command, ...rest] = argv
  if (command !== 'load') throw new Error(LOAD_USAGE)
  const out: LoadArgs = {
    connection: '',
    dryRun: false,
    applyNumbering: false,
    applySettings: false,
    user: null,
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const value = () => {
      const next = rest[++i]
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value. ${LOAD_USAGE}`)
      return next
    }
    if (flag === '--connection') out.connection = value()
    else if (flag === '--dry-run') out.dryRun = true
    else if (flag === '--apply-numbering') out.applyNumbering = true
    else if (flag === '--apply-settings') out.applySettings = true
    else if (flag === '--user') out.user = value()
    else throw new Error(`Unknown option ${flag}. ${LOAD_USAGE}`)
  }
  if (!out.connection) throw new Error(`--connection is required. ${LOAD_USAGE}`)
  if (out.dryRun && (out.applyNumbering || out.applySettings)) {
    throw new Error('A dry run applies nothing: leave out --apply-numbering and --apply-settings.')
  }
  return out
}

export interface UndoArgs {
  connection: string
  run: string
  /** The member the undo is recorded as; the connection's creator unless given. */
  user: string | null
}

export const UNDO_USAGE = 'Usage: run.ts undo --connection <id> --run <run id> [--user <id>]'

/** `undo --connection <id> --run <run id>`: the run id is the one a load prints first. */
export function parseUndoArgs(argv: string[]): UndoArgs {
  const [command, ...rest] = argv
  if (command !== 'undo') throw new Error(UNDO_USAGE)
  const out: UndoArgs = { connection: '', run: '', user: null }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const next = rest[++i]
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value. ${UNDO_USAGE}`)
    if (flag === '--connection') out.connection = next
    else if (flag === '--run') out.run = next
    else if (flag === '--user') out.user = next
    else throw new Error(`Unknown option ${flag}. ${UNDO_USAGE}`)
  }
  if (!out.connection || !out.run)
    throw new Error(`--connection and --run are required. ${UNDO_USAGE}`)
  return out
}

/** What an undo removed and kept, one model per line. */
export function formatUndoSummary(runId: string, result: UndoResult): string[] {
  const lines = [`Undid load ${runId}:`]
  for (const [model, n] of Object.entries(result.removed))
    if (n) lines.push(`  ${model}: ${n} removed`)
  const kept = Object.entries(result.kept)
  if (kept.length) {
    lines.push('Kept, because the workshop uses them since:')
    for (const [model, n] of kept) lines.push(`  ${model}: ${n}`)
  }
  lines.push('Settings applied with --apply-numbering or --apply-settings are not changed back.')
  return lines
}

/** The summary, one fact per line. Ids and counts only: no customer names, emails or phone numbers. */
export function formatLoadSummary(summary: LoadSummary): string[] {
  const lines: string[] = [
    summary.dryRun
      ? `Dry run ${summary.runId}: nothing was kept. A real run would change:`
      : `Load ${summary.runId}:`,
  ]
  for (const [table, c] of Object.entries(summary.counts)) {
    if (!c.created && !c.updated && !c.unchanged && !c.skipped && !c.failed) continue
    const extra = [c.skipped ? `${c.skipped} skipped` : '', c.failed ? `${c.failed} failed` : '']
      .filter(Boolean)
      .map((t) => `, ${t}`)
      .join('')
    lines.push(
      `  ${table}: ${c.created} new, ${c.updated} updated, ${c.unchanged} unchanged${extra}`
    )
  }
  if (!summary.dryRun) lines.push(`  invoices issued: ${summary.issued}`)
  if (summary.issueFailed) {
    lines.push(
      `  invoices not issued: ${summary.issueFailed} (still unlocked; the next load tries again)`
    )
  }
  const warnings = Object.entries(summary.warnings)
  if (warnings.length) {
    lines.push('Warnings:')
    for (const [code, n] of warnings) lines.push(`  ${code}: ${n}`)
  }
  if (summary.failures.length) {
    lines.push('Failed records (the rest loaded):')
    for (const f of summary.failures) lines.push(`  ${f.table} ${f.remoteId}: ${f.error}`)
  }
  const { numbering, settings, workshopName } = summary.proposals
  const appliedKeys = new Set(summary.applied)
  const proposal = (title: string, list: typeof settings, flag: string) => {
    if (!list.length) return
    const done = list.every((c) => appliedKeys.has(c.key))
    lines.push(done ? `${title} (applied):` : `${title} (apply with ${flag}):`)
    for (const c of list)
      lines.push(`  ${c.key}: ${JSON.stringify(c.current)} → ${JSON.stringify(c.proposed)}`)
  }
  if (numbering.highest) lines.push(`Highest imported number: ${numbering.highest}`)
  proposal('Numbering', numbering.changes, '--apply-numbering')
  proposal('Settings', settings, '--apply-settings')
  if (workshopName) {
    lines.push(
      `Shopmonkey names this location ${JSON.stringify(workshopName.proposed)}; the workshop is ${JSON.stringify(workshopName.current)}. Rename it in Settings if you want to.`
    )
  }
  return lines
}
