/**
 * What to fetch from Shopmonkey, table by table (docs/fork/milestones/M3-extract-and-stage.md task 1,
 * MAPPING §1 and §3, RESULTS S4). Every table is read whole for the connection's location and staged
 * unchanged; children hang off the record they belong to, and records an order points at but no list
 * returned (a vehicle with no owner, a deleted customer) are fetched by id.
 *
 * PROVISIONAL(M0:S4): endpoints and shapes are from Shopmonkey's published reference, not recorded
 * responses. Customers and inventory have no GET list (search only); vehicles have no list at all
 * (reached through customers, or by id from orders); payments come from the payment search; order files
 * are `files[]` on Find Order; inspection photos are `items[].files[]` on the inspection.
 */

/** How a table's records are listed. */
export type ListSpec =
  | { kind: 'get'; path: string }
  | { kind: 'search'; path: string }
  /** One record, by the connection's company id (`:id`). */
  | { kind: 'record'; path: string }
  /** Not listed on its own: reached as a child, or by id from another record. */
  | { kind: 'none' }

/** Records fetched per parent. `:id` in a path is the parent's id. */
export type ChildSpec =
  /** A GET returning the parent's records (paged when it pages). */
  | { kind: 'list'; table: string; path: string; parentField?: string }
  /** A search for the records whose `parentField` is the parent's id. */
  | { kind: 'search'; table: string; path: string; parentField: string }
  /** `files[]` on the parent (read fresh by id: links may be signed), each downloaded. */
  | { kind: 'files'; table: string; detailPath: string }
  /** `items[].files[]` on the parent (read fresh by id), each downloaded. */
  | { kind: 'itemFiles'; table: string; detailPath: string }
  /** Shopmonkey's own PDF of an invoice. */
  | { kind: 'invoicePdf'; table: string; path: string }
  /** The record the parent's `field` names, fetched by id when no list staged it. */
  | { kind: 'ref'; table: string; field: string; path: string }

export interface TableSpec {
  table: string
  list: ListSpec
  /**
   * The field naming the record's location, filtered to the connection's location. PROVISIONAL(M0:S2):
   * sent as `where` and, because GET lists were reported to ignore it, checked again on every record.
   */
  location?: 'locationId' | 'locationIds'
  /** Whether the list honours `where: { updatedDate: { gte } }`, so a delta reads only changes. */
  updatedFilter: boolean
  children?: ChildSpec[]
  /** The list may not exist (archived or undocumented): a 404 skips the table with a warning. */
  optional?: boolean
}

const get = (table: string, extra: Partial<TableSpec> = {}): TableSpec => ({
  table,
  list: { kind: 'get', path: `/v3/${table}` },
  updatedFilter: false,
  ...extra,
})

const search = (table: string, extra: Partial<TableSpec> = {}): TableSpec => ({
  table,
  list: { kind: 'search', path: `/v3/${table}/search` },
  location: 'locationId',
  updatedFilter: true,
  ...extra,
})

export const TABLES: readonly TableSpec[] = [
  // The company the key belongs to (its id is the connection's account id, from `identify`).
  { table: 'company', list: { kind: 'record', path: '/v3/company/:id' }, updatedFilter: false },
  // Settings: small, read whole each time.
  get('location', { optional: true }), // PROVISIONAL(M0:S1): only in archived docs.
  get('tax_config', { location: 'locationId' }),
  get('labor_rate', { location: 'locationId' }),
  get('workflow', { optional: true }),
  get('workflow_status', { location: 'locationId' }),
  get('payment_type_config'),
  get('payment_term', { optional: true }),
  get('referral_source'),
  get('label'),
  get('inventory_category'),
  get('vendor'),
  get('role', { optional: true }),
  get('labor_matrix', { optional: true }),
  get('pricing_matrix', { optional: true }),
  get('message_template', { optional: true }),
  get('brand', { optional: true }),
  get('tire_model', { optional: true }),

  // Staff.
  get('user'),

  // Customers (emails and phone numbers come embedded in each one), then their vehicles' owners.
  search('customer', {
    location: 'locationIds',
    children: [{ kind: 'list', table: 'vehicle', path: '/v3/customer/:id/vehicle' }],
  }),
  {
    table: 'vehicle',
    list: { kind: 'none' },
    updatedFilter: false,
    children: [
      {
        kind: 'list',
        table: 'vehicle_owner',
        path: '/v3/vehicle/:id/owners',
        parentField: 'vehicleId',
      },
    ],
  },

  // Catalog.
  get('canned_service', { location: 'locationId' }),
  search('inventory_part'),
  search('inventory_tire'),
  search('inventory_labor'),
  search('inventory_fee'),

  // Orders and everything that hangs off one.
  get('order', {
    location: 'locationId',
    children: [
      {
        kind: 'list',
        table: 'order_service',
        path: '/v3/order/:id/service',
        parentField: 'orderId',
      },
      {
        kind: 'search',
        table: 'payment',
        path: '/v3/integration/payment/search',
        parentField: 'orderId',
      },
      {
        kind: 'list',
        table: 'authorization',
        path: '/v3/order/:id/authorization',
        parentField: 'orderId',
      },
      { kind: 'files', table: 'order_file', detailPath: '/v3/order/:id' },
      { kind: 'invoicePdf', table: 'invoice_pdf', path: '/v3/order/:id/pdf' },
      { kind: 'ref', table: 'customer', field: 'customerId', path: '/v3/customer/:id' },
      { kind: 'ref', table: 'vehicle', field: 'vehicleId', path: '/v3/vehicle/:id' },
    ],
  }),
  get('line_item_assignment', { optional: true }),

  // Calendar, inspections, time.
  get('appointment', { location: 'locationId' }),
  get('inspection_template'),
  get('inspection', {
    location: 'locationId',
    children: [{ kind: 'itemFiles', table: 'inspection_file', detailPath: '/v3/inspection/:id' }],
  }),
  search('timesheet'),

  // Archive only (MAPPING §3).
  get('purchase_order', { location: 'locationId', optional: true }),
  search('statement', { optional: true }),
  search('part_return', { optional: true }),
  search('inventory_transfer', { optional: true }),
  get('tpi_scan', { optional: true }),
  // Messages are archived whatever `includeMessages` says; the setting decides whether M5 loads them (B4).
  get('message', { optional: true }),
]

export function tableSpec(table: string): TableSpec {
  const spec = TABLES.find((t) => t.table === table)
  if (!spec) throw new Error(`Unknown Shopmonkey table ${table}`)
  return spec
}

/** Every table a record can be staged under, children included. */
export function stagedTables(): string[] {
  const names = new Set<string>()
  for (const spec of TABLES) {
    names.add(spec.table)
    for (const child of spec.children ?? []) names.add(child.table)
  }
  return [...names]
}
