/**
 * fork: what each staged Shopmonkey table is to the load (MAPPING §3, §11), and the one rule that puts a staged
 * record in its bucket (M6). Pure: the scan in `counts.ts` brings the facts.
 */
import type { Bucket } from './types'

/** Tables whose records each become a Torqvoice row of their own, linked (`SourceRecord.localEntity/localId`). */
export const LINKED_TABLES = new Set([
  'user',
  'workflow_status',
  'customer',
  'vehicle',
  'canned_service',
  'inventory_part',
  'inventory_tire',
  'inventory_labor',
  'inventory_fee',
  'order',
  'appointment',
  'inspection_template',
  'inspection',
  'timesheet',
  'order_file',
  'invoice_pdf',
  'inspection_file',
])

/** Files: their parent says whether they had somewhere to go. */
export const FILE_TABLES = new Set(['order_file', 'invoice_pdf', 'inspection_file'])

/** Part of another record's rows: an order's services and authorizations, a vehicle's owners. */
export const FOLDED_TABLES = new Set(['order_service', 'authorization', 'vehicle_owner'])

/** Read whole into the workshop's settings, statuses and customers' fields. */
export const SETTINGS_TABLES = new Set([
  'tax_config',
  'labor_rate',
  'workflow',
  'referral_source',
  'label',
])

/** Kept in the archive only (MAPPING §3 "Archive only", §11), reachable through the API. */
export const ARCHIVE_TABLES = new Set([
  'company',
  'location',
  'payment_type_config',
  'payment_term',
  'inventory_category',
  'vendor',
  'role',
  'labor_matrix',
  'pricing_matrix',
  'message_template',
  'brand',
  'tire_model',
  'line_item_assignment',
  'purchase_order',
  'statement',
  'part_return',
  'inventory_transfer',
  'tpi_scan',
  'message',
])

/** What the scan knows about one staged record. */
export interface StagedFacts {
  table: string
  remoteId: string
  localEntity: string | null
  localId: string | null
  /** Its linked Torqvoice row exists in the workshop (looked up when there's a link). */
  rowExists: boolean
  loadSkip: string | null
  /** Deleted in Shopmonkey: `remoteDeletedAt`, or the payload's own `deleted`. */
  deleted: boolean
  /** A file the extract didn't download (`_staged.skipped`). */
  fileNotStaged: boolean
  /** A payment's Payment row exists (by `externalId`). */
  paymentLoaded: boolean
  /** The record its parent is (a file's `_parent`, a payment's order), and that parent's bucket. */
  parentBucket: Bucket | null
  /** For a payment: whether its order is a loaded work order. */
  parentIsWorkOrder: boolean
}

export interface Placement {
  bucket: Bucket
  /** For `skipped`: why. */
  reason?: string
}

/**
 * Where a record lands. The order of the checks is the rule: what the record became first (a link, a payment row),
 * then what Shopmonkey says of it (deleted), then why the load left it out, then what its table is.
 */
export function place(r: StagedFacts): Placement {
  if (r.localEntity && r.localId) return { bucket: r.rowExists ? 'loaded' : 'missing' }
  if (r.table === 'payment' && r.paymentLoaded) return { bucket: 'loaded' }
  if (r.deleted) return { bucket: 'deleted' }
  if (r.loadSkip === 'failed') return { bucket: 'failed' }
  if (r.loadSkip) return { bucket: 'skipped', reason: r.loadSkip }
  if (ARCHIVE_TABLES.has(r.table)) return { bucket: 'archive' }
  if (SETTINGS_TABLES.has(r.table)) return { bucket: 'settings' }
  if (FOLDED_TABLES.has(r.table)) return { bucket: 'folded' }
  if (r.table === 'payment' && !r.parentIsWorkOrder) {
    // MAPPING §6.6: a payment on an order that isn't a loaded work order isn't imported.
    return { bucket: 'skipped', reason: 'payment_order_not_loaded' }
  }
  if (FILE_TABLES.has(r.table)) {
    if (r.fileNotStaged) return { bucket: 'skipped', reason: 'file_not_staged' }
    // A file whose record wasn't loaded has nowhere to go (a quote's, a skipped inspection's).
    if (r.parentBucket && r.parentBucket !== 'loaded') {
      return { bucket: 'skipped', reason: 'parent_not_loaded' }
    }
  }
  return { bucket: 'unaccounted' }
}
