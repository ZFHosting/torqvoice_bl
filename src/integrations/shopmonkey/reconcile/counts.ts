/**
 * fork: the count section of the reconciliation (M6): every staged Shopmonkey record, in exactly one bucket, with
 * Shopmonkey's own totals beside them. A record that should have become a Torqvoice row and didn't, without a
 * reason, or whose row is gone, is named.
 *
 * Read in pages of a few columns (and a few payload keys) rather than whole payloads: 50,000 orders and their
 * children are a few hundred thousand rows.
 */
import 'server-only'
import { db } from '@/lib/db'
import { type Placement, place, type StagedFacts } from './tables'
import type { Bucket, NamedRecord, TableCounts } from './types'

const PAGE = 20_000
const ID_CHUNK = 10_000
/** Records named in the report; the count says how many there were in all. */
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
  orderId: string | null
}

async function scanRows(organizationId: string): Promise<Row[]> {
  const rows: Row[] = []
  let after = ''
  for (;;) {
    const page = await db.$queryRaw<Row[]>`
      SELECT id, "table", "remoteId", "localEntity", "localId", "loadSkip",
        ("remoteDeletedAt" IS NOT NULL OR payload->>'deleted' = 'true') AS deleted,
        (payload->'_staged'->>'skipped') IS NOT NULL AS "fileNotStaged",
        payload->'_parent'->>'table' AS "parentTable",
        payload->'_parent'->>'remoteId' AS "parentId",
        CASE WHEN "table" = 'payment' THEN payload->>'orderId' END AS "orderId"
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

/** The ids of each linked model that still exist in the workshop (the load's own `ownRowExists`, in bulk). */
async function existingRows(
  organizationId: string,
  byEntity: Map<string, string[]>
): Promise<Set<string>> {
  const found = new Set<string>()
  const scoped = { organizationId }
  for (const [entity, ids] of byEntity) {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const id = { in: ids.slice(i, i + ID_CHUNK) }
      const select = { id: true } as const
      const rows: { id: string }[] = await (() => {
        switch (entity) {
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
            return db.serviceAttachment.findMany({ where: { id, serviceRecord: scoped }, select })
          case 'VehicleFinding':
            return db.vehicleFinding.findMany({ where: { id, vehicle: scoped }, select })
          case 'Note':
            return db.note.findMany({ where: { id, vehicle: scoped }, select })
          case 'CustomFieldDefinition':
            return db.customFieldDefinition.findMany({ where: { id, ...scoped }, select })
          default:
            // A model the load doesn't link: its rows can't be checked, so they count as gone.
            return Promise.resolve([])
        }
      })()
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

interface ExtractStep {
  total?: number | null
  skip?: number
  counts?: { skipped?: number }
}

export interface CountsResult {
  tables: TableCounts[]
  problems: NamedRecord[]
  problemTotal: number
  failures: NamedRecord[]
  /** Orders that are loaded work orders, by Shopmonkey id: the money section's set. */
  workOrders: Map<string, string>
}

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
  const [existing, payments] = await Promise.all([
    existingRows(organizationId, byEntity),
    importedPayments(organizationId),
  ])
  const facts = (r: Row, parentBucket: Bucket | null, parentIsWorkOrder: boolean): StagedFacts => ({
    table: r.table,
    remoteId: r.remoteId,
    localEntity: r.localEntity,
    localId: r.localId,
    rowExists: !!r.localEntity && !!r.localId && existing.has(`${r.localEntity}:${r.localId}`),
    loadSkip: r.loadSkip,
    deleted: r.deleted,
    fileNotStaged: r.fileNotStaged,
    paymentLoaded: r.table === 'payment' && payments.has(r.remoteId),
    parentBucket,
    parentIsWorkOrder,
  })

  // Parents first: an order's or an inspection's bucket decides its files' and payments'.
  const parents = new Map<string, Placement>()
  const workOrders = new Map<string, string>()
  for (const r of rows) {
    if (r.table !== 'order' && r.table !== 'inspection') continue
    const placed = place(facts(r, null, false))
    parents.set(`${r.table}:${r.remoteId}`, placed)
    if (r.table === 'order' && placed.bucket === 'loaded' && r.localEntity === 'ServiceRecord') {
      workOrders.set(r.remoteId, r.localId as string)
    }
  }

  const tables = new Map<string, TableCounts>()
  const problems: NamedRecord[] = []
  const failures: NamedRecord[] = []
  let problemTotal = 0
  for (const r of rows) {
    const parentKey =
      r.table === 'payment'
        ? r.orderId && `order:${r.orderId}`
        : r.parentTable && r.parentId && `${r.parentTable}:${r.parentId}`
    const placed =
      parents.get(`${r.table}:${r.remoteId}`) ??
      place(
        facts(
          r,
          parentKey ? (parents.get(parentKey)?.bucket ?? null) : null,
          r.table === 'payment' && !!r.orderId && workOrders.has(r.orderId)
        )
      )
    const t =
      tables.get(r.table) ??
      ({
        table: r.table,
        shopmonkeyTotal: extractSteps[r.table]?.total ?? null,
        read: extractSteps[r.table]?.skip ?? null,
        otherLocation: extractSteps[r.table]?.counts?.skipped ?? null,
        staged: 0,
        buckets: {},
        skipped: {},
      } satisfies TableCounts)
    t.staged++
    t.buckets[placed.bucket] = (t.buckets[placed.bucket] ?? 0) + 1
    if (placed.bucket === 'skipped' && placed.reason) {
      t.skipped[placed.reason] = (t.skipped[placed.reason] ?? 0) + 1
    }
    tables.set(r.table, t)
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
    if (placed.bucket === 'failed' && failures.length < NAMED_LIMIT) {
      failures.push({ table: r.table, remoteId: r.remoteId, reason: 'failed' })
    }
  }
  return {
    tables: [...tables.values()].sort((a, b) => a.table.localeCompare(b.table)),
    problems,
    problemTotal,
    failures,
    workOrders,
  }
}
