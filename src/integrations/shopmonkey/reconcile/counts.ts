/**
 * fork: the count section of the reconciliation (M6): every staged Shopmonkey record, in exactly one bucket, with
 * Shopmonkey's own totals beside them. A record that should have become a Torqvoice row and didn't, without a
 * reason, or whose row is gone, is named.
 *
 * Read in pages of a few columns rather than whole payloads: 50,000 orders and their children are a few hundred
 * thousand rows. A payload is opened only for the tables that need a key of it (a child's parent, a file's
 * download), since a payload of a few kilobytes is stored compressed and every key read unpacks it.
 */
import 'server-only'
import { db } from '@/lib/db'
import type { LocalModel } from '../load/links'
import { type Placement, place, type StagedFacts } from './tables'
import type { Bucket, NamedRecord, TableCounts } from './types'

const PAGE = 20_000
const ID_CHUNK = 10_000
/** Records named in the report; the counts say how many there were in all. */
export const NAMED_LIMIT = 500

interface Row {
  id: string
  table: string
  remoteId: string
  localEntity: string | null
  localId: string | null
  loadSkip: string | null
  deleted: boolean
  fileNotStaged: boolean
  parentTable: string | null
  parentId: string | null
}

async function scanRows(organizationId: string): Promise<Row[]> {
  const rows: Row[] = []
  let after = ''
  for (;;) {
    // Each child's parent: an order's services, authorizations and payments by `orderId`, a vehicle's owners by
    // `vehicleId`, an order's invoice PDF by its own id (it is the order's), a file by its `_parent`.
    const page = await db.$queryRaw<Row[]>`
      SELECT id, "table", "remoteId", "localEntity", "localId", "loadSkip",
        "remoteDeletedAt" IS NOT NULL AS deleted,
        CASE WHEN "table" IN ('order_file', 'invoice_pdf', 'inspection_file')
          THEN (payload->'_staged'->>'skipped') IS NOT NULL ELSE false END AS "fileNotStaged",
        CASE
          WHEN "table" IN ('payment', 'order_service', 'authorization', 'invoice_pdf') THEN 'order'
          WHEN "table" = 'vehicle_owner' THEN 'vehicle'
          WHEN "table" IN ('order_file', 'inspection_file') THEN payload->'_parent'->>'table'
        END AS "parentTable",
        CASE
          WHEN "table" IN ('payment', 'order_service', 'authorization') THEN payload->>'orderId'
          WHEN "table" = 'invoice_pdf' THEN "remoteId"
          WHEN "table" = 'vehicle_owner' THEN payload->>'vehicleId'
          WHEN "table" IN ('order_file', 'inspection_file') THEN payload->'_parent'->>'remoteId'
        END AS "parentId"
      FROM "public"."source_records"
      WHERE "organizationId" = ${organizationId} AND source = 'shopmonkey' AND id > ${after}
      ORDER BY id
      LIMIT ${PAGE}
    `
    rows.push(...page)
    if (page.length < PAGE) return rows
    after = page[page.length - 1].id
  }
}

/** The ids of one linked model that still exist in the workshop (the load's own `ownRowExists`, in bulk). */
function existing(
  model: LocalModel,
  ids: string[],
  organizationId: string
): Promise<{ id: string }[]> {
  const id = { in: ids }
  const scoped = { organizationId }
  const select = { id: true } as const
  switch (model) {
    case 'Customer':
      return db.customer.findMany({ where: { id, ...scoped }, select })
    case 'Vehicle':
      return db.vehicle.findMany({ where: { id, ...scoped }, select })
    case 'Technician':
      return db.technician.findMany({ where: { id, ...scoped }, select })
    case 'WorkOrderStatus':
      return db.workOrderStatus.findMany({ where: { id, ...scoped }, select })
    case 'ServiceRecord':
      return db.serviceRecord.findMany({ where: { id, ...scoped }, select })
    case 'Quote':
      return db.quote.findMany({ where: { id, ...scoped }, select })
    case 'InventoryPart':
      return db.inventoryPart.findMany({ where: { id, ...scoped }, select })
    case 'LaborPreset':
      return db.laborPreset.findMany({ where: { id, ...scoped }, select })
    case 'Appointment':
      return db.appointment.findMany({ where: { id, ...scoped }, select })
    case 'InspectionTemplate':
      return db.inspectionTemplate.findMany({ where: { id, ...scoped }, select })
    case 'Inspection':
      return db.inspection.findMany({ where: { id, ...scoped }, select })
    case 'TimeEntry':
      return db.timeEntry.findMany({ where: { id, ...scoped }, select })
    case 'TechnicianShift':
      return db.technicianShift.findMany({ where: { id, ...scoped }, select })
    case 'ServiceAttachment':
      // No organization column of its own: its work order says whose it is.
      return db.serviceAttachment.findMany({ where: { id, serviceRecord: scoped }, select })
    case 'VehicleFinding':
      return db.vehicleFinding.findMany({ where: { id, vehicle: scoped }, select })
    case 'Note':
      return db.note.findMany({ where: { id, vehicle: scoped }, select })
    case 'CustomFieldDefinition':
      return db.customFieldDefinition.findMany({ where: { id, ...scoped }, select })
    default: {
      // Every model the load links is above: a new one is a type error here before it is a gap in the report.
      const unknown: never = model
      throw new Error(`No existence check for ${String(unknown)}`)
    }
  }
}

async function existingRows(
  organizationId: string,
  byEntity: Map<string, string[]>
): Promise<Set<string>> {
  const found = new Set<string>()
  for (const [entity, ids] of byEntity) {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const rows = await existing(entity as LocalModel, ids.slice(i, i + ID_CHUNK), organizationId)
      for (const r of rows) found.add(`${entity}:${r.id}`)
    }
  }
  return found
}

/** The `externalId`s of the workshop's imported payments. */
async function importedPayments(organizationId: string): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ externalId: string }[]>`
    SELECT p."externalId" FROM "public"."payments" p
    JOIN "public"."service_records" sr ON sr.id = p."serviceRecordId"
    WHERE sr."organizationId" = ${organizationId} AND p.provider = 'shopmonkey' AND p."externalId" IS NOT NULL
  `
  return new Set(rows.map((r) => r.externalId))
}

export interface ExtractStep {
  phase?: 'backfill' | 'delta'
  total?: number | null
  skip?: number
  counts?: { skipped?: number }
}

export interface CountsResult {
  tables: TableCounts[]
  problems: NamedRecord[]
  problemTotal: number
  /** Failed records by name (the first 500), and how many failed in each table. */
  failures: NamedRecord[]
  failedByTable: Record<string, number>
  /** Orders that are loaded work orders, and loaded quotes, by Shopmonkey id: the money section's sets. */
  workOrders: Map<string, string>
  quotes: Map<string, string>
  /** The imported payments, by Shopmonkey id. */
  importedPayments: Set<string>
}

/** Parents are placed first: their buckets decide their children's. */
const PARENT_TABLES = new Set(['order', 'inspection', 'vehicle'])

export async function reconcileCounts(
  organizationId: string,
  extractSteps: Record<string, ExtractStep>
): Promise<CountsResult> {
  const rows = await scanRows(organizationId)
  const byEntity = new Map<string, string[]>()
  for (const r of rows) {
    if (r.localEntity && r.localId) {
      const ids = byEntity.get(r.localEntity)
      if (ids) ids.push(r.localId)
      else byEntity.set(r.localEntity, [r.localId])
    }
  }
  const [existingIds, payments] = await Promise.all([
    existingRows(organizationId, byEntity),
    importedPayments(organizationId),
  ])
  const facts = (r: Row, parentBucket: Bucket | null, parentIsWorkOrder: boolean): StagedFacts => ({
    table: r.table,
    remoteId: r.remoteId,
    localEntity: r.localEntity,
    localId: r.localId,
    rowExists: !!r.localEntity && !!r.localId && existingIds.has(`${r.localEntity}:${r.localId}`),
    loadSkip: r.loadSkip,
    deleted: r.deleted,
    fileNotStaged: r.fileNotStaged,
    paymentLoaded: r.table === 'payment' && payments.has(r.remoteId),
    parentBucket,
    parentIsWorkOrder,
  })

  const parents = new Map<string, Placement>()
  const workOrders = new Map<string, string>()
  const quotes = new Map<string, string>()
  for (const r of rows) {
    if (!PARENT_TABLES.has(r.table)) continue
    const placed = place(facts(r, null, false))
    parents.set(`${r.table}:${r.remoteId}`, placed)
    if (r.table === 'order' && placed.bucket === 'loaded') {
      if (r.localEntity === 'ServiceRecord') workOrders.set(r.remoteId, r.localId as string)
      if (r.localEntity === 'Quote') quotes.set(r.remoteId, r.localId as string)
    }
  }

  const tables = new Map<string, TableCounts>()
  const problems: NamedRecord[] = []
  const failures: NamedRecord[] = []
  const failedByTable: Record<string, number> = {}
  let problemTotal = 0
  for (const r of rows) {
    const parentKey = r.parentTable && r.parentId ? `${r.parentTable}:${r.parentId}` : null
    const placed =
      parents.get(`${r.table}:${r.remoteId}`) ??
      place(
        facts(
          r,
          parentKey ? (parents.get(parentKey)?.bucket ?? null) : null,
          r.table === 'payment' && !!r.parentId && workOrders.has(r.parentId)
        )
      )
    let t = tables.get(r.table)
    if (!t) {
      const step = extractSteps[r.table]
      // A delta reads only what changed: its count isn't the table's.
      const backfill = step?.phase !== 'delta'
      t = {
        table: r.table,
        extractPhase: step?.phase ?? null,
        shopmonkeyTotal: backfill ? (step?.total ?? null) : null,
        read: step?.skip ?? null,
        otherLocation: step?.counts?.skipped ?? null,
        staged: 0,
        buckets: {},
        skipped: {},
      }
      tables.set(r.table, t)
    }
    t.staged++
    t.buckets[placed.bucket] = (t.buckets[placed.bucket] ?? 0) + 1
    if (placed.bucket === 'skipped' && placed.reason) {
      t.skipped[placed.reason] = (t.skipped[placed.reason] ?? 0) + 1
    }
    if (placed.bucket === 'missing' || placed.bucket === 'unaccounted') {
      problemTotal++
      if (problems.length < NAMED_LIMIT) {
        problems.push({
          table: r.table,
          remoteId: r.remoteId,
          localEntity: r.localEntity,
          localId: r.localId,
          reason: placed.bucket,
        })
      }
    }
    if (placed.bucket === 'failed') {
      failedByTable[r.table] = (failedByTable[r.table] ?? 0) + 1
      if (failures.length < NAMED_LIMIT) {
        failures.push({ table: r.table, remoteId: r.remoteId, reason: 'failed' })
      }
    }
  }
  return {
    tables: [...tables.values()].sort((a, b) => a.table.localeCompare(b.table)),
    problems,
    problemTotal,
    failures,
    failedByTable,
    workOrders,
    quotes,
    importedPayments: payments,
  }
}
