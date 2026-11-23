/**
 * Undoing a load (M5 task 3). The rows a run created are removed, and nothing it only matched or updated:
 * - customers, vehicles, work orders and inspections by their import batch, by the spreadsheet importer's own undo
 *   rules (`undoImportBatch`, importActions.ts): what was added to them since goes with them, their custom field
 *   values are removed, and their files are let go;
 * - everything else the run created (quotes, inventory, presets, appointments, templates, time, technicians,
 *   statuses), which has no batch column, by the run's links (`createdByRun`).
 * The links and the archive's mappings of what was removed are cleared, so a later load creates them again.
 */
import {
  deleteCustomFieldValuesOf,
  workOrderIdsOfVehicles,
} from '@/features/custom-fields/Lib/deleteCustomFieldValues'
import { db } from '@/lib/db'
import { serviceRecordFileUrls, vehicleFileUrls } from '@/lib/files/collect'
import { releaseFiles } from '@/lib/files/manager'
import { SOURCE } from '../extract/stage'
import type { LocalModel } from './links'

export interface UndoResult {
  removed: Record<string, number>
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

export async function undoLoad(input: {
  organizationId: string
  connectionId: string
  runId: string
}): Promise<UndoResult> {
  const { organizationId, connectionId, runId } = input
  const batches = await db.importBatch.findMany({
    where: {
      organizationId,
      source: 'shopmonkey',
      fileName: `Shopmonkey import ${runId}`,
      status: 'completed',
    },
    select: { id: true, userId: true, createdAt: true },
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
  await db.$transaction(
    async (tx) => {
      const where = (ids: string[]) => ({ id: { in: ids }, organizationId })
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
      const quotes = created('Quote')
      await deleteCustomFieldValuesOf(tx, organizationId, 'quote', quotes)
      for (const model of LINKED) {
        const ids = created(model)
        if (!ids.length) continue
        const delegate = {
          TimeEntry: tx.timeEntry,
          TechnicianShift: tx.technicianShift,
          Appointment: tx.appointment,
          Quote: tx.quote,
          LaborPreset: tx.laborPreset,
          InventoryPart: tx.inventoryPart,
          InspectionTemplate: tx.inspectionTemplate,
          WorkOrderStatus: tx.workOrderStatus,
          Technician: tx.technician,
        }[model as 'Quote'] as unknown as {
          deleteMany: (args: unknown) => Promise<{ count: number }>
        }
        removed[model] = (await delegate.deleteMany({ where: where(ids) })).count
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
      // Custom field definitions the run's user added during the run that no value uses any more.
      const startedAt = batches.reduce<Date | null>(
        (a, b) => (!a || b.createdAt < a ? b.createdAt : a),
        null
      )
      if (startedAt) {
        removed.CustomFieldDefinition = (
          await tx.customFieldDefinition.deleteMany({
            where: {
              organizationId,
              userId: { in: [...new Set(batches.map((b) => b.userId))] },
              createdAt: { gte: startedAt },
              values: { none: {} },
            },
          })
        ).count
      }
      await tx.integrationLink.deleteMany({
        where: { connectionId, metadata: { path: ['createdByRun'], equals: runId } },
      })
      const createdIds = links.map((l) => l.entityId)
      const batchRows = [...records, ...vehicles, ...customers].map((r) => r.id)
      await tx.sourceRecord.updateMany({
        where: { organizationId, source: SOURCE, localId: { in: [...createdIds, ...batchRows] } },
        data: { localEntity: null, localId: null, loadedHash: null },
      })
      await tx.importBatch.updateMany({
        where: { id: { in: batchIds }, organizationId },
        data: { status: 'undone', undoneAt: new Date() },
      })
    },
    { maxWait: 30_000, timeout: 30 * 60_000 }
  )
  await releaseFiles(files, { organizationId, reason: 'import undone' })
  return { removed }
}
