/**
 * Which Torqvoice row a Shopmonkey record became (M5, FORK.md "Idempotent everywhere"): an `IntegrationLink` per
 * loaded record (remote id ↔ local id, with the hash of what was loaded), written through the same transaction
 * as the row, and the same mapping on the record's `SourceRecord` (`localEntity`, `localId`, `loadedHash`), which
 * travels with backups. `ctx.links` writes with `db` outside any transaction, so a rolled-back order would leave a
 * link to nothing; this doesn't.
 *
 * A link's `remoteId` is `<table>:<id>`: two Shopmonkey tables load into one model (parts and tires into
 * `InventoryPart`), and the table keeps their ids apart.
 */
import type { Prisma } from '@/generated/prisma/client'
import { SOURCE } from '../extract/stage'

export interface LoadScope {
  organizationId: string
  connectionId: string
  /** The load run, kept on the links it creates so undo knows what this run made. */
  runId: string
}

type Tx = Prisma.TransactionClient

/** The Torqvoice models a loaded record can be, and how to check a row is still this workshop's. */
export type LocalModel =
  | 'Customer'
  | 'Vehicle'
  | 'Technician'
  | 'WorkOrderStatus'
  | 'ServiceRecord'
  | 'Quote'
  | 'InventoryPart'
  | 'LaborPreset'
  | 'Appointment'
  | 'InspectionTemplate'
  | 'Inspection'
  | 'TimeEntry'
  | 'TechnicianShift'
  | 'ServiceAttachment'
  | 'VehicleFinding'

export const linkRemoteId = (table: string, remoteId: string) => `${table}:${remoteId}`

/** Whether the row still exists in this workshop: a link or a restored mapping can point at a deleted one. */
async function ownRowExists(
  tx: Tx,
  model: LocalModel,
  id: string,
  organizationId: string
): Promise<boolean> {
  const where = { id, organizationId }
  const found = await (() => {
    switch (model) {
      case 'Customer':
        return tx.customer.findFirst({ where, select: { id: true } })
      case 'Vehicle':
        return tx.vehicle.findFirst({ where, select: { id: true } })
      case 'Technician':
        return tx.technician.findFirst({ where, select: { id: true } })
      case 'WorkOrderStatus':
        return tx.workOrderStatus.findFirst({ where, select: { id: true } })
      case 'ServiceRecord':
        return tx.serviceRecord.findFirst({ where, select: { id: true } })
      case 'Quote':
        return tx.quote.findFirst({ where, select: { id: true } })
      case 'InventoryPart':
        return tx.inventoryPart.findFirst({ where, select: { id: true } })
      case 'LaborPreset':
        return tx.laborPreset.findFirst({ where, select: { id: true } })
      case 'Appointment':
        return tx.appointment.findFirst({ where, select: { id: true } })
      case 'InspectionTemplate':
        return tx.inspectionTemplate.findFirst({ where, select: { id: true } })
      case 'Inspection':
        return tx.inspection.findFirst({ where, select: { id: true } })
      case 'TimeEntry':
        return tx.timeEntry.findFirst({ where, select: { id: true } })
      case 'TechnicianShift':
        return tx.technicianShift.findFirst({ where, select: { id: true } })
      case 'ServiceAttachment':
        // No organization column of its own: its work order says whose it is.
        return tx.serviceAttachment.findFirst({
          where: { id, serviceRecord: { organizationId } },
          select: { id: true },
        })
      case 'VehicleFinding':
        // Its vehicle says whose it is.
        return tx.vehicleFinding.findFirst({
          where: { id, vehicle: { organizationId } },
          select: { id: true },
        })
    }
  })()
  return !!found
}

export interface FoundLink {
  localId: string
  /** The source hash the row was last loaded from. */
  hash: string | null
}

/**
 * The row a record was loaded as: its link, or (after a restore or a reconnect, when the link is gone) the mapping
 * on its source record, checked to still be this workshop's row and re-linked. Null when it was never loaded, or
 * its row is gone (deleted in the app): the caller creates it again.
 */
export async function findLoaded(
  tx: Tx,
  scope: LoadScope,
  table: string,
  model: LocalModel,
  remoteId: string
): Promise<FoundLink | null> {
  const link = await tx.integrationLink.findFirst({
    where: {
      connectionId: scope.connectionId,
      entityType: model,
      remoteId: linkRemoteId(table, remoteId),
    },
    select: { entityId: true, checksum: true },
  })
  if (link) {
    if (await ownRowExists(tx, model, link.entityId, scope.organizationId)) {
      return { localId: link.entityId, hash: link.checksum }
    }
    // Its row was deleted in the app: the link goes, and the row is created again.
    await tx.integrationLink.deleteMany({
      where: { connectionId: scope.connectionId, entityType: model, entityId: link.entityId },
    })
  }
  const source = await tx.sourceRecord.findUnique({
    where: {
      organizationId_source_table_remoteId: {
        organizationId: scope.organizationId,
        source: SOURCE,
        table,
        remoteId,
      },
    },
    select: { localEntity: true, localId: true, loadedHash: true },
  })
  if (
    source?.localEntity === model &&
    source.localId &&
    (await ownRowExists(tx, model, source.localId, scope.organizationId))
  ) {
    await writeLink(tx, scope, table, model, remoteId, source.localId, source.loadedHash, false)
    return { localId: source.localId, hash: source.loadedHash }
  }
  return null
}

async function writeLink(
  tx: Tx,
  scope: LoadScope,
  table: string,
  model: LocalModel,
  remoteId: string,
  localId: string,
  hash: string | null,
  created: boolean
) {
  const key = {
    connectionId_entityType_entityId: {
      connectionId: scope.connectionId,
      entityType: model,
      entityId: localId,
    },
  }
  await tx.integrationLink.upsert({
    where: key,
    create: {
      connectionId: scope.connectionId,
      entityType: model,
      entityId: localId,
      remoteId: linkRemoteId(table, remoteId),
      checksum: hash,
      // Undo removes what a run created, never a row it only matched or updated.
      metadata: created ? { createdByRun: scope.runId } : {},
    },
    update: { remoteId: linkRemoteId(table, remoteId), checksum: hash, lastSyncedAt: new Date() },
  })
}

/** Records that a record was loaded as this row, from this hash: the link, and the backed-up mapping. */
export async function markLoaded(
  tx: Tx,
  scope: LoadScope,
  input: {
    table: string
    model: LocalModel
    remoteId: string
    localId: string
    hash: string
    created: boolean
  }
) {
  await writeLink(
    tx,
    scope,
    input.table,
    input.model,
    input.remoteId,
    input.localId,
    input.hash,
    input.created
  )
  await tx.sourceRecord.updateMany({
    where: {
      organizationId: scope.organizationId,
      source: SOURCE,
      table: input.table,
      remoteId: input.remoteId,
    },
    data: { localEntity: input.model, localId: input.localId, loadedHash: input.hash },
  })
}
