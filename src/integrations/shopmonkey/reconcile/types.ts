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
  /** The extract's last run of this table: `backfill` reads it whole, `delta` only what changed. */
  extractPhase: 'backfill' | 'delta' | null
  /**
   * Shopmonkey's own count (`meta.total` from the first page the extract read), when its list gives one and the
   * last run read the whole table (a delta's count is only what changed).
   */
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
  /** The Torqvoice row: a work order, or (for an estimate) a quote. */
  workOrderId: string
  document: 'workOrder' | 'quote'
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
  /** Why, as a code and its numbers: what the import page (M8) says, in the workshop's language. */
  code: string
  values: Record<string, number | string>
  /** The same in English, for the command line. */
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
    quotes: number
    differences: MoneyDifference[]
    differenceTotal: number
    unexplained: number
  }
  receivables: {
    /** What the imported invoices still have open, on both sides. */
    shopmonkeyCents: number
    torqvoiceCents: number
    /** Open on Shopmonkey invoices that weren't imported (before `historyFrom`, failed, left out): not compared. */
    notImportedCents: number
    notImportedInvoices: number
    /** Imported work orders Shopmonkey has deleted since: still in Torqvoice, and counted on both sides. */
    deletedInShopmonkey: number
  }
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
