/**
 * fork: the reconciliation (docs/fork/milestones/M6-reconcile.md): a report that proves an import complete and
 * correct, and four gates that hold cutover back when it isn't. It explains; people decide (nothing is fixed here).
 *
 * Gates (all must pass for cutover):
 * - counts: every staged record is accounted for (no missing row, nothing unaccounted), and the extract read every
 *   record Shopmonkey listed;
 * - money: no unexplained difference over a cent on any imported work order;
 * - receivables: what the imported invoices still have open equals Shopmonkey's, to the cent;
 * - failures: no order failed to load.
 */
import 'server-only'
import { db } from '@/lib/db'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { mergeState, type LastLoad } from '../load/outcome'
import { reconcileCounts } from './counts'
import { reconcileFields } from './fields'
import {
  compareOrder,
  monthTotals,
  readShopmonkeyOrders,
  readShopmonkeyPayments,
  readTorqvoiceOrders,
  spotChecks,
} from './money'
import type { MoneyDifference, ReconciliationReport } from './types'

/** Differences kept in the report; the counts say how many there were in all. */
export const DIFFERENCES_KEPT = 1_000

const money = (cents: number) => (cents / 100).toFixed(2)

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
  const extract = (state.extract as { steps?: Record<string, unknown> } | undefined) ?? {}
  const lastLoad = (state.lastLoad as LastLoad | undefined) ?? null
  const timeZone = options.timeZone ?? (await workshopTimeZone(scope.organizationId))

  const counts = await reconcileCounts(
    scope.organizationId,
    (extract.steps ?? {}) as Parameters<typeof reconcileCounts>[1]
  )
  const [smOrders, tv, smPayments, unmapped] = await Promise.all([
    readShopmonkeyOrders(scope.organizationId, counts.workOrders),
    readTorqvoiceOrders(scope.organizationId, counts.workOrders),
    readShopmonkeyPayments(scope.organizationId, counts.workOrders),
    reconcileFields(scope.organizationId),
  ])

  const mismatched = new Set(lastLoad?.warnedOrders?.money_mismatch ?? [])
  const pairs = smOrders.flatMap((sm) => {
    const order = tv.orders.get(sm.orderId)
    return order ? [{ sm, tv: order }] : []
  })
  const differences: MoneyDifference[] = []
  let differenceTotal = 0
  let unexplained = 0
  let smOpen = 0
  let tvOpen = 0
  for (const { sm, tv: order } of pairs) {
    for (const d of compareOrder(sm, order, {
      moneyMismatch: mismatched.has(sm.orderId),
      skippedPayments: smPayments.skipped.get(sm.orderId) ?? [],
    })) {
      differenceTotal++
      if (!d.explainedBy) unexplained++
      // Unexplained ones first in what's kept: they're what a person has to look at.
      if (differences.length < DIFFERENCES_KEPT || !d.explainedBy) differences.push(d)
    }
    // Receivables: invoices only, both sides over the same ones.
    if (sm.invoicedDate || order.invoiceDate) {
      smOpen += sm.remainingCents
      tvOpen += order.totalCents - order.paidCents
    }
  }
  differences.sort((a, b) => Number(!!a.explainedBy) - Number(!!b.explainedBy))
  differences.splice(DIFFERENCES_KEPT)

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
  const extractSteps = (extract.steps ?? {}) as Record<
    string,
    { total?: number | null; skip?: number }
  >
  const unread = Object.entries(extractSteps).filter(
    ([, step]) =>
      typeof step.total === 'number' && typeof step.skip === 'number' && step.skip < step.total
  )
  const failedOrders = counts.failures.filter((f) => f.table === 'order')
  const countsPassed =
    counts.problemTotal === 0 && unread.length === 0 && Object.keys(extractSteps).length > 0
  const report: ReconciliationReport = {
    version: 1,
    connectionId: scope.connectionId,
    generatedAt: now.toISOString(),
    timeZone,
    loadRunId: lastLoad?.runId ?? null,
    counts: counts.tables,
    countProblems: counts.problems,
    countProblemTotal: counts.problemTotal,
    money: { workOrders: pairs.length, differences, differenceTotal, unexplained },
    receivables: { shopmonkeyCents: smOpen, torqvoiceCents: tvOpen },
    months: {
      shopmonkey: monthTotals(smInvoices, smPayments.payments, timeZone),
      torqvoice: monthTotals(tvInvoices, tv.payments, timeZone),
    },
    spotChecks: spotChecks(pairs, `${scope.connectionId}:${lastLoad?.runId ?? ''}`),
    warnings: lastLoad?.warnings ?? {},
    failures: counts.failures,
    unmapped,
    gates: {
      counts: {
        passed: countsPassed,
        summary: !Object.keys(extractSteps).length
          ? 'No extract is on record for this connection.'
          : counts.problemTotal
            ? `${counts.problemTotal} staged record(s) not accounted for (missing rows or no reason).`
            : unread.length
              ? `The extract read fewer records than Shopmonkey listed in ${unread.map(([t]) => t).join(', ')}.`
              : 'Every staged record is accounted for, and every listed record was read.',
      },
      money: {
        passed: unexplained === 0,
        summary: unexplained
          ? `${unexplained} unexplained difference(s) over $0.01 on ${pairs.length} work order(s).`
          : `No unexplained difference on ${pairs.length} work order(s) (${differenceTotal} explained).`,
      },
      receivables: {
        passed: Math.abs(smOpen - tvOpen) === 0,
        summary: `Open on imported invoices: Shopmonkey ${money(smOpen)}, Torqvoice ${money(tvOpen)}.`,
      },
      failures: {
        passed: failedOrders.length === 0,
        summary: failedOrders.length
          ? `${failedOrders.length} order(s) failed to load.`
          : 'No order failed to load.',
      },
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
