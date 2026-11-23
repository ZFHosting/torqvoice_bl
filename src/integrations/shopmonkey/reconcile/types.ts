/**
 * fork: the reconciliation report (docs/fork/milestones/M6-reconcile.md): proof that an import is complete and
 * correct, and the gates that hold cutover back when it isn't. Stored as the connection's
 * `state.lastReconciliation`, printed by `scripts/shopmonkey/run.ts reconcile`, shown by M8.
 *
 * Money is integer cents throughout, as Shopmonkey keeps it: Torqvoice's amounts are rounded to the cent first.
 */

/** Where a staged record ended up. Every one lands in exactly one. */
export type Bucket =
  /** Loaded: its Torqvoice row is there. */
  | 'loaded'
  /** Loaded once, but its Torqvoice row is gone (deleted in the app): named, and the count gate fails. */
  | 'missing'
  /** Deleted in Shopmonkey (marked by the extract): archive only. */
  | 'deleted'
  /** Left out by the load, for the reason on the record (`SourceRecord.loadSkip`). */
  | 'skipped'
  /** The load tried and failed: named, and the gates fail. */
  | 'failed'
  /** A table kept in the archive only (MAPPING §3, §11). */
  | 'archive'
  /** Part of another record's rows (an order's services, a vehicle's owners): accounted with it. */
  | 'folded'
  /** Read whole into the workshop's settings and proposals (tax, labor rates, statuses' workflow). */
  | 'settings'
  /** None of these: named, and the count gate fails. */
  | 'unaccounted'

export interface TableCounts {
  table: string
  /** Shopmonkey's own count (`meta.total` from the first page the extract read), when its list gives one. */
  shopmonkeyTotal: number | null
  /** Rows the extract read from the list, and the ones it left out as another location's. */
  read: number | null
  otherLocation: number | null
  staged: number
  buckets: Partial<Record<Bucket, number>>
  /** `skipped`, by reason. */
  skipped: Record<string, number>
}

export interface NamedRecord {
  table: string
  remoteId: string
  /** The Torqvoice row, where there was one. */
  localEntity?: string | null
  localId?: string | null
  reason?: string
}

export type MoneyField = 'lines' | 'total' | 'paid' | 'balance'

export interface MoneyDifference {
  orderId: string
  number: string | null
  workOrderId: string
  field: MoneyField
  shopmonkeyCents: number
  torqvoiceCents: number
  /** The rule that explains it (a MAPPING §6.6 code), or null: unexplained. */
  explainedBy: string | null
}

export interface MonthTotals {
  /** YYYY-MM on the workshop's clock. */
  month: string
  invoiced: number
  tax: number
  discounts: number
  payments: number
  /** Invoiced up to the month's end, less what was paid by then. */
  openReceivables: number
}

export interface SpotCheck {
  orderId: string
  number: string | null
  workOrderId: string
  invoiceNumber: string | null
  /** The work order in the app, relative to its address. */
  path: string
  shopmonkeyTotalCents: number
  torqvoiceTotalCents: number
}

export interface UnmappedField {
  /** The table, or a nested record as `<table>.<key>[]`. */
  where: string
  field: string
  /** Records looked at, and how many carried the field with a value. */
  seen: number
  nonEmpty: number
}

export interface Gate {
  passed: boolean
  /** One line: why it passed or failed. */
  summary: string
}

export interface ReconciliationReport {
  version: 1
  connectionId: string
  generatedAt: string
  timeZone: string
  /** The load the report is about (`state.lastLoad`), when there was one. */
  loadRunId: string | null
  counts: TableCounts[]
  /** Records the count gate names: missing rows and unaccounted records (the first 500). */
  countProblems: NamedRecord[]
  countProblemTotal: number
  money: {
    workOrders: number
    differences: MoneyDifference[]
    differenceTotal: number
    unexplained: number
  }
  receivables: { shopmonkeyCents: number; torqvoiceCents: number }
  months: { shopmonkey: MonthTotals[]; torqvoice: MonthTotals[] }
  spotChecks: SpotCheck[]
  warnings: Record<string, { count: number; examples: unknown[] }>
  failures: NamedRecord[]
  unmapped: UnmappedField[]
  gates: {
    counts: Gate
    money: Gate
    receivables: Gate
    failures: Gate
  }
  /** All four gates pass: cutover may go ahead. */
  passed: boolean
}
