/**
 * fork: the reconciliation on the command line (`scripts/shopmonkey/run.ts reconcile`): its arguments, and the
 * report as lines. Names records by their Shopmonkey ids and codes only, never by what they hold (FORK.md).
 */
import type { ReconciliationReport } from './types'

export const RECONCILE_USAGE = 'Usage: run.ts reconcile --connection <id> [--json]'

export interface ReconcileArgs {
  connection: string
  json: boolean
}

export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const [command, ...rest] = argv
  if (command !== 'reconcile') throw new Error(RECONCILE_USAGE)
  const out: ReconcileArgs = { connection: '', json: false }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '--json') {
      out.json = true
      continue
    }
    const next = rest[++i]
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value. ${RECONCILE_USAGE}`)
    if (flag === '--connection') out.connection = next
    else throw new Error(`Unknown option ${flag}. ${RECONCILE_USAGE}`)
  }
  if (!out.connection) throw new Error(`--connection is required. ${RECONCILE_USAGE}`)
  return out
}

const dollars = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`

/** The report, for a person at a terminal: the gates first, then what they rest on. */
export function formatReport(report: ReconciliationReport): string[] {
  const lines = [
    `Reconciliation of connection ${report.connectionId} at ${report.generatedAt} (${report.timeZone})`,
    report.passed ? 'All gates pass: cutover may go ahead.' : 'Cutover is held back: a gate fails.',
    '',
    'Gates:',
  ]
  for (const [name, gate] of Object.entries(report.gates)) {
    lines.push(`  ${gate.passed ? 'PASS' : 'FAIL'} ${name}: ${gate.summary}`)
  }
  lines.push('', 'Counts (staged: buckets):')
  for (const t of report.counts) {
    const buckets = Object.entries(t.buckets)
      .map(([b, n]) => `${b} ${n}`)
      .join(', ')
    const shop =
      t.shopmonkeyTotal === null
        ? t.extractPhase === 'delta'
          ? ' (last read: changes only)'
          : ''
        : ` of ${t.shopmonkeyTotal} on Shopmonkey`
    const away = t.otherLocation ? `, ${t.otherLocation} at another location` : ''
    lines.push(`  ${t.table}: ${t.staged} staged${shop}${away}: ${buckets}`)
    const reasons = Object.entries(t.skipped)
    if (reasons.length) {
      lines.push(`    skipped: ${reasons.map(([r, n]) => `${r} ${n}`).join(', ')}`)
    }
  }
  if (report.countProblemTotal) {
    lines.push('', `Not accounted for (${report.countProblemTotal}):`)
    for (const p of report.countProblems) {
      lines.push(
        `  ${p.table} ${p.remoteId}: ${p.reason}${p.localEntity ? ` (${p.localEntity} ${p.localId})` : ''}`
      )
    }
  }
  lines.push(
    '',
    `Money: ${report.money.workOrders} work order(s) and ${report.money.quotes} estimate(s), ${report.money.differenceTotal} difference(s), ${report.money.unexplained} unexplained.`
  )
  for (const d of report.money.differences.filter((x) => !x.explainedBy)) {
    const what = d.document === 'quote' ? 'estimate' : 'order'
    lines.push(
      `  ${what} ${d.orderId}${d.number ? ` (#${d.number})` : ''} ${d.field}: Shopmonkey ${dollars(d.shopmonkeyCents)}, Torqvoice ${dollars(d.torqvoiceCents)}`
    )
  }
  const r = report.receivables
  lines.push(
    `Receivables: Shopmonkey ${dollars(r.shopmonkeyCents)}, Torqvoice ${dollars(r.torqvoiceCents)}`
  )
  if (r.notImportedInvoices) {
    lines.push(
      `  Not imported (not compared): ${r.notImportedInvoices} invoice(s) with ${dollars(r.notImportedCents)} open in Shopmonkey`
    )
  }
  if (r.deletedInShopmonkey) {
    lines.push(`  ${r.deletedInShopmonkey} imported work order(s) deleted in Shopmonkey since`)
  }
  if (report.failures.length) {
    lines.push('', 'Failed to load:')
    for (const f of report.failures) lines.push(`  ${f.table} ${f.remoteId}`)
  }
  const codes = Object.entries(report.warnings)
  if (codes.length) {
    lines.push('', 'Warnings:')
    for (const [code, group] of codes) lines.push(`  ${code}: ${group.count}`)
  }
  if (report.spotChecks.length) {
    lines.push('', 'Spot checks (open both and compare):')
    for (const s of report.spotChecks) {
      lines.push(
        `  #${s.number ?? s.orderId} -> ${s.path}: Shopmonkey ${dollars(s.shopmonkeyTotalCents)}, Torqvoice ${dollars(s.torqvoiceTotalCents)}`
      )
    }
  }
  const unknown = report.unmapped.filter((u) => u.nonEmpty > 0)
  if (unknown.length) {
    lines.push('', 'Fields Shopmonkey sends that nothing maps (with a value / looked at):')
    for (const u of unknown.slice(0, 50))
      lines.push(`  ${u.where}.${u.field}: ${u.nonEmpty}/${u.seen}`)
  }
  return lines
}
