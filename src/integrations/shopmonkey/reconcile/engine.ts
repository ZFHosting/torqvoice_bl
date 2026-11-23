/**
 * fork: the reconciliation (docs/fork/milestones/M6-reconcile.md, MAPPING §12): a report that proves an import
 * complete and correct, and four gates that hold cutover back when it isn't. It explains; people decide (nothing is
 * fixed here).
 *
 * Gates (all must pass for cutover):
 * - counts: every staged record is accounted for (no missing row, nothing unaccounted), and the extract read every
 *   record Shopmonkey listed in its last whole read of each table;
 * - money: no unexplained difference over a cent on any imported work order or estimate;
 * - receivables: what the imported invoices still have open equals Shopmonkey's, to the cent (a difference a rule
 *   explains still fails it: the shop decides);
 * - failures: no order failed to load, in the archive or in the last load.
 */
import 'server-only'
import { db } from '@/lib/db'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { type LastLoad, mergeState } from '../load/outcome'
import { type ExtractStep, reconcileCounts } from './counts'
import { reconcileFields } from './fields'
import {
  compareOrder,
  compareQuote,
  monthTotals,
  readNotImported,
  readShopmonkeyOrders,
  readShopmonkeyPayments,
  readTorqvoiceOrders,
  readTorqvoiceQuotes,
  spotChecks,
} from './money'
import type { Gate, MoneyDifference, ReconciliationReport } from './types'

/** Differences kept in the report (unexplained first); the counts say how many there were in all. */
export const DIFFERENCES_KEPT = 1_000

const money = (cents: number) => (cents / 100).toFixed(2)

function gate(
  passed: boolean,
  code: string,
  values: Record<string, number | string>,
  summary: string
): Gate {
  return { passed, code, values, summary }
}

export async function buildReport(
  scope: { organizationId: string; connectionId: string },
  options: { now?: Date; timeZone?: string } = {}
): Promise<ReconciliationReport> {
  const now = options.now ?? new Date()
  const connection = await db.integrationConnection.findFirst({
    where: {
      id: scope.connectionId,
      organizationId: scope.organizationId,
      connectorId: 'shopmonkey',
    },
    select: { state: true },
  })
  if (!connection) throw new Error('That is not a Shopmonkey connection of this workshop.')
  const state = (connection.state as Record<string, unknown>) ?? {}
  const extractSteps =
    (state.extract as { steps?: Record<string, ExtractStep> } | undefined)?.steps ?? {}
  const lastLoad = (state.lastLoad as LastLoad | undefined) ?? null
  const timeZone = options.timeZone ?? (await workshopTimeZone(scope.organizationId))

  const counts = await reconcileCounts(scope.organizationId, extractSteps)
  const loaded = new Set([...counts.workOrders.keys(), ...counts.quotes.keys()])
  const [smOrders, tv, tvQuotes, smPayments, notImported, unmapped] = await Promise.all([
    readShopmonkeyOrders(scope.organizationId, loaded),
    readTorqvoiceOrders(scope.organizationId, counts.workOrders),
    readTorqvoiceQuotes(scope.organizationId, counts.quotes),
    readShopmonkeyPayments(scope.organizationId, counts.workOrders, counts.importedPayments),
    readNotImported(scope.organizationId),
    reconcileFields(scope.organizationId),
  ])

  const linesAtLoad = lastLoad?.mismatchedLines ?? {}
  const pairs = smOrders.flatMap((sm) => {
    const order = tv.orders.get(sm.orderId)
    return order ? [{ sm, tv: order }] : []
  })
  const all: MoneyDifference[] = []
  let smOpen = 0
  let tvOpen = 0
  let deletedInShopmonkey = 0
  for (const { sm, tv: order } of pairs) {
    all.push(
      ...compareOrder(sm, order, {
        linesAtLoad: linesAtLoad[sm.orderId] ?? null,
        skippedPayments: smPayments.skipped.get(sm.orderId) ?? [],
      })
    )
    if (sm.deleted) deletedInShopmonkey++
    // Receivables: invoices only, both sides over the same ones.
    if (sm.invoicedDate || order.invoiceDate) {
      smOpen += sm.remainingCents
      tvOpen += order.totalCents - order.paidCents
    }
  }
  let quotesCompared = 0
  for (const sm of smOrders) {
    const quote = tvQuotes.get(sm.orderId)
    if (!quote) continue
    quotesCompared++
    all.push(...compareQuote(sm, quote))
  }
  const unexplained = all.filter((d) => !d.explainedBy).length
  const differences = [...all]
    .sort((a, b) => Number(!!a.explainedBy) - Number(!!b.explainedBy))
    .slice(0, DIFFERENCES_KEPT)

  const smInvoices = pairs.flatMap(({ sm }) =>
    sm.invoicedDate
      ? [
          {
            orderId: sm.orderId,
            date: sm.invoicedDate,
            totalCents: sm.totalCents,
            taxCents: sm.taxCents,
            discountCents: sm.discountCents,
          },
        ]
      : []
  )
  const tvInvoices = pairs.flatMap(({ sm, tv: order }) =>
    order.invoiceDate
      ? [
          {
            orderId: sm.orderId,
            date: order.invoiceDate,
            totalCents: order.totalCents,
            taxCents: order.taxCents,
            discountCents: order.discountCents,
          },
        ]
      : []
  )

  // PROVISIONAL(M0:S12): `meta.total` on a list's first page is the whole table, so reading fewer is stopping early.
  // A delta's total is only what changed, so only a whole read is held to it.
  const unread = Object.entries(extractSteps).filter(
    ([, step]) =>
      step.phase !== 'delta' &&
      typeof step.total === 'number' &&
      typeof step.skip === 'number' &&
      step.skip < step.total
  )
  // Failed orders: in the archive (their reason), and in the last load (a linked order whose update failed keeps
  // its link, so only the load's own count says so).
  const failedOrders = Math.max(
    counts.failedByTable.order ?? 0,
    lastLoad?.counts?.order?.failed ?? 0
  )
  const unreadTables = unread.map(([t]) => t).join(', ')
  const countsGate =
    Object.keys(extractSteps).length === 0
      ? gate(false, 'no_extract', {}, 'No extract is on record for this connection.')
      : counts.problemTotal
        ? gate(
            false,
            'records_unaccounted',
            { records: counts.problemTotal },
            `${counts.problemTotal} staged record(s) not accounted for (missing rows or no reason).`
          )
        : unread.length
          ? gate(
              false,
              'extract_incomplete',
              { tables: unreadTables },
              `The extract read fewer records than Shopmonkey listed in ${unreadTables}.`
            )
          : gate(
              true,
              'all_accounted',
              {},
              'Every staged record is accounted for, and every listed record was read.'
            )
  const documents = pairs.length + quotesCompared
  const report: ReconciliationReport = {
    version: 1,
    connectionId: scope.connectionId,
    generatedAt: now.toISOString(),
    timeZone,
    loadRunId: lastLoad?.runId ?? null,
    counts: counts.tables,
    countProblems: counts.problems,
    countProblemTotal: counts.problemTotal,
    money: {
      workOrders: pairs.length,
      quotes: quotesCompared,
      differences,
      differenceTotal: all.length,
      unexplained,
    },
    receivables: {
      shopmonkeyCents: smOpen,
      torqvoiceCents: tvOpen,
      notImportedCents: notImported.openCents,
      notImportedInvoices: notImported.invoices,
      deletedInShopmonkey,
    },
    months: {
      shopmonkey: monthTotals(smInvoices, smPayments.payments, timeZone),
      torqvoice: monthTotals(tvInvoices, tv.payments, timeZone),
    },
    spotChecks: spotChecks(pairs, `${scope.connectionId}:${lastLoad?.runId ?? ''}`),
    warnings: lastLoad?.warnings ?? {},
    failures: counts.failures,
    unmapped,
    gates: {
      counts: countsGate,
      money: unexplained
        ? gate(
            false,
            'money_unexplained',
            { differences: unexplained, documents },
            `${unexplained} unexplained difference(s) over $0.01 on ${documents} document(s).`
          )
        : gate(
            true,
            'money_explained',
            { documents, explained: all.length },
            `No unexplained difference on ${documents} document(s) (${all.length} explained).`
          ),
      receivables: gate(
        smOpen === tvOpen,
        smOpen === tvOpen ? 'receivables_equal' : 'receivables_differ',
        { shopmonkeyCents: smOpen, torqvoiceCents: tvOpen },
        `Open on imported invoices: Shopmonkey ${money(smOpen)}, Torqvoice ${money(tvOpen)}.`
      ),
      failures: failedOrders
        ? gate(
            false,
            'orders_failed',
            { orders: failedOrders },
            `${failedOrders} order(s) failed to load.`
          )
        : gate(true, 'no_failures', {}, 'No order failed to load.'),
    },
    passed: false,
  }
  report.passed = Object.values(report.gates).every((g) => g.passed)
  return report
}

/** Builds the report and keeps it as the connection's `state.lastReconciliation` (shown by M8). */
export async function reconcile(
  scope: { organizationId: string; connectionId: string },
  options: { now?: Date; timeZone?: string } = {}
): Promise<ReconciliationReport> {
  const report = await buildReport(scope, options)
  await mergeState(scope, { lastReconciliation: report })
  return report
}
