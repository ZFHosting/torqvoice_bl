/**
 * Undoing a load (M5 task 3). The rows a run created are removed, and nothing it only matched or updated:
 * - customers, vehicles, work orders and inspections by their import batch, by the spreadsheet importer's own undo
 *   rules (`undoImportBatch`, importActions.ts): what was added to them since goes with them, their custom field
 *   values are removed, and their files are let go;
 * - everything else the run created (quotes, inventory, presets, appointments, templates, time, technicians,
 *   statuses, the custom fields it defined), which has no batch column, by the run's links (`createdByRun`).
 *   A row the workshop has come to use since is kept, so the undo never takes the workshop's own work with it or
 *   fails on it: a template an inspection made in the app uses, a technician with time, helpers, a login or lines
 *   outside the run, a status a work order is in, an inventory part a line, preset or stock movement of the
 *   workshop's names, a custom field with values. Kept rows keep their links, so a later load matches them.
 * The links and the archive's mappings of what was removed are cleared, so a later load creates them again.
 * Settings applied with `--apply-numbering` / `--apply-settings` are not reverted (MAPPING §9.2).
 */
import {
  deleteCustomFieldValuesOf,
  workOrderIdsOfVehicles,
} from '@/features/custom-fields/Lib/deleteCustomFieldValues'
import { db, type TxClient } from '@/lib/db'
import { serviceRecordFileUrls, vehicleFileUrls } from '@/lib/files/collect'
import { releaseFiles } from '@/lib/files/manager'
import { SOURCE } from '../extract/stage'
import { recordUndo } from './finish'
import type { LocalModel } from './links'
import { withLoadLock } from './lock'
import { mergeState } from './outcome'

export interface UndoResult {
  removed: Record<string, number>
  /** Rows the run created that the workshop uses since, left in place, by model. */
  kept: Record<string, number>
}

export class UndoRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UndoRefused'
  }
}

/** Ids per query: well under PostgreSQL's limit on bound parameters. */
const CHUNK = 10_000

type Delegate = {
  findMany: (args: unknown) => Promise<{ id: string }[]>
  deleteMany: (args: unknown) => Promise<{ count: number }>
}

/** Models without a batch column the run's links say it created, in an order that respects references. */
const LINKED: LocalModel[] = [
  'TimeEntry',
  'TechnicianShift',
  'Appointment',
  'Quote',
  'LaborPreset',
  'InventoryPart',
  'InspectionTemplate',
  'WorkOrderStatus',
  'Technician',
]

function delegateOf(tx: TxClient, model: LocalModel): Delegate {
  const delegates: Partial<Record<LocalModel, unknown>> = {
    TimeEntry: tx.timeEntry,
    TechnicianShift: tx.technicianShift,
    Appointment: tx.appointment,
    Quote: tx.quote,
    LaborPreset: tx.laborPreset,
    InventoryPart: tx.inventoryPart,
    InspectionTemplate: tx.inspectionTemplate,
    WorkOrderStatus: tx.workOrderStatus,
    Technician: tx.technician,
  }
  return delegates[model] as Delegate
}

/** What makes a created row the workshop's to keep, as a `where` it must match to be removed. */
const UNUSED: Partial<Record<LocalModel, Record<string, unknown>>> = {
  InspectionTemplate: { inspections: { none: {} } },
  WorkOrderStatus: { serviceRecords: { none: {} } },
  Technician: {
    userId: null,
    serviceRecords: { none: {} },
    inspections: { none: {} },
    statusReports: { none: {} },
    timeEntries: { none: {} },
    absences: { none: {} },
    helping: { none: {} },
    laborLines: { none: {} },
    quoteLaborLines: { none: {} },
    shifts: { none: {} },
    loginCodes: { none: {} },
  },
  // Its own "import" movement goes with it; any other is the workshop's stock history.
  InventoryPart: { movements: { none: { reason: { not: 'import' } } } },
}

/** Inventory parts lines and presets still name (a plain column, no relation to filter on). */
async function namedInventoryParts(tx: TxClient, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const where = { inventoryPartId: { in: ids } }
  const select = { inventoryPartId: true } as const
  const rows = [
    ...(await tx.servicePart.findMany({ where, select })),
    ...(await tx.quotePart.findMany({ where, select })),
    ...(await tx.laborPresetPart.findMany({ where, select })),
  ]
  return new Set(rows.map((r) => r.inventoryPartId as string))
}

/** Each linked model's table, for clearing links and mappings whose row is gone. */
const TABLES: Record<LocalModel, string> = {
  Customer: 'customers',
  Vehicle: 'vehicles',
  Technician: 'technicians',
  WorkOrderStatus: 'work_order_statuses',
  ServiceRecord: 'service_records',
  Quote: 'quotes',
  InventoryPart: 'inventory_parts',
  LaborPreset: 'labor_presets',
  Appointment: 'appointments',
  InspectionTemplate: 'inspection_templates',
  Inspection: 'inspections',
  TimeEntry: 'time_entries',
  TechnicianShift: 'technician_shifts',
  ServiceAttachment: 'service_attachments',
  VehicleFinding: 'vehicle_findings',
  Note: 'notes',
  CustomFieldDefinition: 'custom_field_definitions',
}

/**
 * Links and archive mappings of this connection whose row no longer exists, removed: an undo can take rows a
 * later run linked (its work order on this run's vehicle), and a stale one would read as "deleted in Torqvoice".
 */
async function clearDangling(tx: TxClient, organizationId: string, connectionId: string) {
  for (const [model, table] of Object.entries(TABLES)) {
    await tx.$executeRawUnsafe(
      `DELETE FROM "public"."integration_links" AS l
        WHERE l."connectionId" = $1 AND l."entityType" = $2
          AND NOT EXISTS (SELECT 1 FROM "public"."${table}" AS r WHERE r."id" = l."entityId")`,
      connectionId,
      model
    )
    await tx.$executeRawUnsafe(
      `UPDATE "public"."source_records" AS s
          SET "localEntity" = NULL, "localId" = NULL, "loadedHash" = NULL
        WHERE s."organizationId" = $1 AND s."source" = $2 AND s."localEntity" = $3
          AND NOT EXISTS (SELECT 1 FROM "public"."${table}" AS r WHERE r."id" = s."localId")`,
      organizationId,
      SOURCE,
      model
    )
  }
}

export interface UndoInput {
  organizationId: string
  connectionId: string
  runId: string
  /** The member undoing it: the audit event's user. */
  userId: string
}

/**
 * Undoes a load, holding the connection's load lock (M7: never beside a sync's load). Afterwards the connection has
 * no last load (`state.lastLoad`), so the sync stops loading until the operator loads again: otherwise its next load
 * would create what the undo removed.
 */
export async function undoLoad(input: UndoInput): Promise<UndoResult> {
  return withLoadLock(input.connectionId, async () => {
    const result = await undoUnlocked(input)
    await mergeState(input, { lastLoad: null })
    return result
  })
}

async function undoUnlocked(input: UndoInput): Promise<UndoResult> {
  const { organizationId, connectionId, runId } = input
  // Links have no workshop column: the connection has to be this workshop's before its links decide anything.
  const connection = await db.integrationConnection.findFirst({
    where: { id: connectionId, organizationId, connectorId: 'shopmonkey' },
    select: { id: true },
  })
  if (!connection) throw new UndoRefused('That is not a Shopmonkey connection of this workshop.')
  const member = await db.organizationMember.findFirst({
    where: { organizationId, userId: input.userId },
    select: { id: true },
  })
  if (!member) throw new UndoRefused('An undo is done by a member of the workshop.')
  const batches = await db.importBatch.findMany({
    where: {
      organizationId,
      source: 'shopmonkey',
      status: 'completed',
      mapping: { path: ['shopmonkeyRunId'], equals: runId },
    },
    select: { id: true },
  })
  const batchIds = batches.map((b) => b.id)
  const [records, vehicles, customers] = await Promise.all([
    db.serviceRecord.findMany({
      where: { organizationId, importBatchId: { in: batchIds } },
      select: { id: true },
    }),
    db.vehicle.findMany({
      where: { organizationId, importBatchId: { in: batchIds } },
      select: { id: true },
    }),
    db.customer.findMany({
      where: { organizationId, importBatchId: { in: batchIds } },
      select: { id: true },
    }),
  ])
  const links = await db.integrationLink.findMany({
    where: { connectionId, metadata: { path: ['createdByRun'], equals: runId } },
    select: { entityType: true, entityId: true },
  })
  const created = (model: LocalModel) =>
    links.filter((l) => l.entityType === model).map((l) => l.entityId)
  // Attachments the run put on work orders it didn't create: their files go too.
  const attachments = await db.serviceAttachment.findMany({
    where: { id: { in: created('ServiceAttachment') }, serviceRecord: { organizationId } },
    select: { id: true, fileUrl: true },
  })
  const files = [
    ...(await serviceRecordFileUrls(
      organizationId,
      records.map((r) => r.id)
    )),
    ...(await vehicleFileUrls(
      organizationId,
      vehicles.map((v) => v.id)
    )),
    ...attachments.map((a) => a.fileUrl),
  ]
  const goneWorkOrderIds = [
    ...new Set([
      ...records.map((r) => r.id),
      ...(await workOrderIdsOfVehicles(
        organizationId,
        vehicles.map((v) => v.id)
      )),
    ]),
  ]
  const removed: Record<string, number> = {}
  const kept: Record<string, number> = {}
  const keptIds: string[] = []
  await db.$transaction(
    async (tx) => {
      removed.Inspection = (
        await tx.inspection.deleteMany({
          where: { organizationId, importBatchId: { in: batchIds } },
        })
      ).count
      removed.ServiceRecord = (
        await tx.serviceRecord.deleteMany({
          where: { organizationId, importBatchId: { in: batchIds } },
        })
      ).count
      removed.Vehicle = (
        await tx.vehicle.deleteMany({ where: { organizationId, importBatchId: { in: batchIds } } })
      ).count
      await deleteCustomFieldValuesOf(tx, organizationId, 'service_record', goneWorkOrderIds)
      await deleteCustomFieldValuesOf(
        tx,
        organizationId,
        'vehicle',
        vehicles.map((v) => v.id)
      )
      removed.Customer = (
        await tx.customer.deleteMany({ where: { organizationId, importBatchId: { in: batchIds } } })
      ).count
      await deleteCustomFieldValuesOf(
        tx,
        organizationId,
        'customer',
        customers.map((c) => c.id)
      )
      for (const model of LINKED) {
        const ids = created(model)
        if (!ids.length) continue
        const delegate = delegateOf(tx, model)
        // Still there: a row the run made may already be gone with something removed above (a time entry with its
        // work order), and that's neither removed here nor kept.
        const existing = (
          await delegate.findMany({
            where: { id: { in: ids }, organizationId },
            select: { id: true },
          })
        ).map((r) => r.id)
        let removable = (
          await delegate.findMany({
            where: { id: { in: ids }, organizationId, ...(UNUSED[model] ?? {}) },
            select: { id: true },
          })
        ).map((r) => r.id)
        if (model === 'InventoryPart') {
          const named = await namedInventoryParts(tx, removable)
          removable = removable.filter((id) => !named.has(id))
        }
        if (model === 'Quote')
          await deleteCustomFieldValuesOf(tx, organizationId, 'quote', removable)
        removed[model] = (
          await delegate.deleteMany({ where: { id: { in: removable }, organizationId } })
        ).count
        const removing = new Set(removable)
        const left = existing.filter((id) => !removing.has(id))
        if (left.length) {
          kept[model] = left.length
          keptIds.push(...left)
        }
      }
      // Findings and attachments have no workshop column: removed by id, their vehicle or work order checked.
      removed.VehicleFinding = (
        await tx.vehicleFinding.deleteMany({
          where: { id: { in: created('VehicleFinding') }, vehicle: { organizationId } },
        })
      ).count
      removed.ServiceAttachment = (
        await tx.serviceAttachment.deleteMany({
          where: { id: { in: attachments.map((a) => a.id) } },
        })
      ).count
      // Vehicle notes it wrote on vehicles it didn't create (one deleted in the app and written again, say).
      removed.Note = (
        await tx.note.deleteMany({
          where: { id: { in: created('Note') }, vehicle: { organizationId } },
        })
      ).count
      // A quote converted into a work order that's gone (this run's, or a later run's on this run's vehicle) points
      // at nothing now: it's accepted again, so the app can convert it, and the next load converts it again if
      // Shopmonkey still has it as a repair order.
      for (let i = 0; i < goneWorkOrderIds.length; i += CHUNK) {
        await tx.quote.updateMany({
          where: { organizationId, convertedToId: { in: goneWorkOrderIds.slice(i, i + CHUNK) } },
          data: { convertedToId: null, status: 'accepted' },
        })
      }
      // Custom fields the run defined, unless a value (the workshop's, or another run's) uses them.
      const fields = created('CustomFieldDefinition')
      const unusedFields = (
        await tx.customFieldDefinition.findMany({
          where: { id: { in: fields }, organizationId, values: { none: {} } },
          select: { id: true },
        })
      ).map((f) => f.id)
      removed.CustomFieldDefinition = (
        await tx.customFieldDefinition.deleteMany({
          where: { id: { in: unusedFields }, organizationId },
        })
      ).count
      const keptFields = fields.filter((id) => !unusedFields.includes(id))
      if (keptFields.length) {
        kept.CustomFieldDefinition = keptFields.length
        keptIds.push(...keptFields)
      }
      // The links of what's gone (whatever took it: a delete above, or a cascade from one), and the archive's
      // mappings of it. A kept row keeps both. In chunks: one query takes a bounded number of ids.
      const keptSet = new Set(keptIds)
      const goneLinks = links.map((l) => l.entityId).filter((id) => !keptSet.has(id))
      for (let i = 0; i < goneLinks.length; i += CHUNK) {
        await tx.integrationLink.deleteMany({
          where: {
            connectionId,
            metadata: { path: ['createdByRun'], equals: runId },
            entityId: { in: goneLinks.slice(i, i + CHUNK) },
          },
        })
      }
      const goneIds = [...goneLinks, ...[...records, ...vehicles, ...customers].map((r) => r.id)]
      for (let i = 0; i < goneIds.length; i += CHUNK) {
        await tx.sourceRecord.updateMany({
          where: { organizationId, source: SOURCE, localId: { in: goneIds.slice(i, i + CHUNK) } },
          data: { localEntity: null, localId: null, loadedHash: null },
        })
      }
      await tx.importBatch.updateMany({
        where: { id: { in: batchIds }, organizationId },
        data: { status: 'undone', undoneAt: new Date() },
      })
      await clearDangling(tx, organizationId, connectionId)
    },
    { maxWait: 30_000, timeout: 30 * 60_000 }
  )
  await releaseFiles(files, { organizationId, reason: 'import undone' })
  await recordUndo(organizationId, input.userId, { connectionId, runId, removed, kept })
  return { removed, kept }
}
