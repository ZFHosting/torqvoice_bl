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
  /** Told when a record's row was deleted in the app and is about to be created again (M5 task 1: warned). */
  onRecreate?: (table: string, model: LocalModel, remoteId: string) => void
  /** M7: told when a changed record is about to overwrite its row, edited in Torqvoice since its last sync (warned). */
  onOverwrite?: (table: string, model: LocalModel, remoteId: string) => void
  /**
   * M7: the rows the unit of work under way has written, its own and any it touched in passing (an appointment
   * setting its work order's start). Their links are synced as of the unit's end (`stampWritten`), so what the load
   * wrote never reads as an edit made in Torqvoice, and an edit made meanwhile to a row it didn't write still does.
   */
  written?: { model: LocalModel; id: string }[]
}

/** M7: a row the unit of work wrote in passing, so its link is synced with the unit. */
export function noteWritten(scope: LoadScope, model: LocalModel, id: string): void {
  scope.written?.push({ model, id })
}

/** M7: the links of the rows a unit wrote, synced as of now (its end). */
export async function stampWritten(tx: Tx, scope: LoadScope): Promise<void> {
  const written = scope.written ?? []
  if (!written.length) return
  await tx.integrationLink.updateMany({
    where: {
      connectionId: scope.connectionId,
      OR: written.map((w) => ({ entityType: w.model, entityId: w.id })),
    },
    data: { lastSyncedAt: new Date() },
  })
}

/** M7: links synced as of now, for rows written outside a unit (invoices issued after their order's unit). */
export async function stampLinks(
  tx: Tx,
  scope: Pick<LoadScope, 'connectionId'>,
  model: LocalModel,
  ids: string[]
): Promise<void> {
  for (let i = 0; i < ids.length; i += 1000) {
    await tx.integrationLink.updateMany({
      where: {
        connectionId: scope.connectionId,
        entityType: model,
        entityId: { in: ids.slice(i, i + 1000) },
      },
      data: { lastSyncedAt: new Date() },
    })
  }
}

/** Keys that hold the run's own ids, not what a record points at: left out of `foreignKeys`. */
const OWN_KEYS = new Set(['organizationId', 'userId', 'createdById'])

/**
 * The ids a record's rows point at (`vehicleId`, `customerId`, `technicianId`, `inventoryPartId`, and lists like
 * `helperTechnicianIds`), with where they sit: part of a record's load hash, so a dependency created again (deleted
 * in the app) or loaded late re-points the rows that use it on the next run instead of leaving a stale or empty
 * foreign key.
 */
export function foreignKeys(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => foreignKeys(v, `${at}[${i}]`))
  if (!value || typeof value !== 'object' || value instanceof Date) return []
  const out: string[] = []
  for (const [key, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    const path = at ? `${at}.${key}` : key
    if (/Ids?$/.test(key) && !OWN_KEYS.has(key)) {
      if (typeof v === 'string' || v === null) out.push(`${path}=${v}`)
      else if (Array.isArray(v)) out.push(`${path}=${v.join(',')}`)
      continue
    }
    if (v && typeof v === 'object') out.push(...foreignKeys(v, path))
  }
  return out
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
  | 'Note'
  | 'CustomFieldDefinition'

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
      case 'Note':
        return tx.note.findFirst({
          where: { id, vehicle: { organizationId } },
          select: { id: true },
        })
      case 'CustomFieldDefinition':
        return tx.customFieldDefinition.findFirst({ where, select: { id: true } })
    }
  })()
  return !!found
}

export interface FoundLink {
  localId: string
  /** The source hash the row was last loaded from. */
  hash: string | null
  /** M7: when its link was last synced (null when the link was only just restored from the archive's mapping). */
  syncedAt: Date | null
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
    select: { entityId: true, checksum: true, lastSyncedAt: true },
  })
  if (link) {
    if (await ownRowExists(tx, model, link.entityId, scope.organizationId)) {
      return { localId: link.entityId, hash: link.checksum, syncedAt: link.lastSyncedAt }
    }
    // Its row was deleted in the app: the link and the archive's mapping go (so a second look warns no more), and
    // the row is created again (warned).
    await unlink(tx, scope, table, model, remoteId, link.entityId)
    scope.onRecreate?.(table, model, remoteId)
    return null
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
    return { localId: source.localId, hash: source.loadedHash, syncedAt: null }
  }
  // Loaded once (the archive says so), and the row is gone: created again, warned once.
  if (source?.localEntity === model && source.localId) {
    await unlink(tx, scope, table, model, remoteId, source.localId)
    scope.onRecreate?.(table, model, remoteId)
  }
  return null
}

/**
 * The row a record is linked to as this model, if it still exists: no re-linking, no warning. For asking whether a
 * record was loaded as another model before (an estimate that became a repair order).
 */
export async function linkedRow(
  tx: Tx,
  scope: LoadScope,
  table: string,
  model: LocalModel,
  remoteId: string
): Promise<string | null> {
  const link = await tx.integrationLink.findFirst({
    where: {
      connectionId: scope.connectionId,
      entityType: model,
      remoteId: linkRemoteId(table, remoteId),
    },
    select: { entityId: true },
  })
  if (link && (await ownRowExists(tx, model, link.entityId, scope.organizationId))) {
    return link.entityId
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
    select: { localEntity: true, localId: true },
  })
  return source?.localEntity === model &&
    source.localId &&
    (await ownRowExists(tx, model, source.localId, scope.organizationId))
    ? source.localId
    : null
}

/** Forgets a record's row as this model: its link, and the archive's mapping if it names that row. */
export async function unlink(
  tx: Tx,
  scope: LoadScope,
  table: string,
  model: LocalModel,
  remoteId: string,
  localId: string
): Promise<void> {
  await tx.integrationLink.deleteMany({
    where: { connectionId: scope.connectionId, entityType: model, entityId: localId },
  })
  await tx.sourceRecord.updateMany({
    where: {
      organizationId: scope.organizationId,
      source: SOURCE,
      table,
      remoteId,
      localEntity: model,
      localId,
    },
    data: { localEntity: null, localId: null, loadedHash: null },
  })
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
  // One link per record and model: a user mapped to another technician since, say, leaves no second link.
  await tx.integrationLink.deleteMany({
    where: {
      connectionId: scope.connectionId,
      entityType: model,
      remoteId: linkRemoteId(table, remoteId),
      entityId: { not: localId },
    },
  })
  await tx.integrationLink.upsert({
    where: key,
    create: {
      connectionId: scope.connectionId,
      entityType: model,
      entityId: localId,
      remoteId: linkRemoteId(table, remoteId),
      checksum: hash,
      // M7: the app's clock, as every later sync stamp is (the column's default is the database's).
      lastSyncedAt: new Date(),
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
  noteWritten(scope, input.model, input.localId)
  await tx.sourceRecord.updateMany({
    where: {
      organizationId: scope.organizationId,
      source: SOURCE,
      table: input.table,
      remoteId: input.remoteId,
    },
    // M6: loaded now, so no longer left out for whatever reason an earlier run had.
    data: {
      localEntity: input.model,
      localId: input.localId,
      loadedHash: input.hash,
      loadSkip: null,
    },
  })
}
