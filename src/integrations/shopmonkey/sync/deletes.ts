/**
 * The delete policy (M7 task 3): what happens in Torqvoice when Shopmonkey deletes a record during the sync window.
 * - A record only in the archive (never loaded, or left out): nothing; the archive keeps it, marked deleted.
 * - A loaded work order, quote or appointment untouched in Torqvoice since its last sync: deleted, with the tombstones
 *   API clients learn deletes from (`DeletedRecord`), what it takes with it, its custom field values and its files.
 * - One edited in Torqvoice since (the row itself, or anything added to a work order: a payment, an attachment, time,
 *   a status report, equipment, a helper, a concern, a job), or an invoice that is locked: kept, and listed.
 * - Any other loaded record (a customer, a vehicle, a part, a technician): kept and listed. Removing one would take
 *   the history that hangs off it, which Shopmonkey may still have; the person doing the cutover decides (B16).
 *
 * A work order is deleted here, not through the app's delete service: that service puts its parts back on the
 * shelf, and an imported work order never took any (the part counts come from Shopmonkey, `load/catalog.ts`).
 */
import { deleteAppointmentService } from '@/features/calendar/Lib/bookingService.server'
import { deleteCustomFieldValuesOf } from '@/features/custom-fields/Lib/deleteCustomFieldValues'
import { unlinkMeterReadingsOfDeletedJobs } from '@/features/meters/Lib/jobMeterReading.server'
import { cascadeTombstones } from '@/features/public-api/Lib/tombstones.server'
import { auditDetails, logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { DocumentLockedError } from '@/lib/document-lock'
import { assertInvoiceEditable, assertQuoteEditable } from '@/lib/document-lock.server'
import { quoteFileUrls, serviceRecordFileUrls } from '@/lib/files/collect'
import { releaseFiles } from '@/lib/files/manager'
import { SOURCE } from '../extract/stage'
import type { Tx } from '../load/context'
import { rowUpdatedAt } from '../load/edits'
import { type LocalModel, unlink } from '../load/links'

export interface DeletedImport {
  table: string
  remoteId: string
  model: string
}

export interface KeptDelete extends DeletedImport {
  /** `edited`: changed in Torqvoice since its last sync; `locked`: an invoice that can't be deleted; `policy`: not a
   * record the sync deletes. */
  reason: 'edited' | 'locked' | 'policy'
}

export interface DeleteOutcome {
  deleted: DeletedImport[]
  kept: KeptDelete[]
}

type Scope = { organizationId: string; connectionId: string; runId: string }

/** The records the sync deletes in Torqvoice, by Shopmonkey table and the model it was loaded as. */
const DELETED_BY_SYNC: Record<string, LocalModel[]> = {
  order: ['ServiceRecord', 'Quote'],
  appointment: ['Appointment'],
}

/**
 * Whether the workshop added anything to an imported work order, told by what each thing is, never by when (a later
 * load re-syncs the order, and a time comparison would forget the addition): a status report or equipment (never
 * imported); a payment that isn't Shopmonkey's (`provider`); an attachment or a time entry no import link names; a
 * concern beside the one the complaint became; more jobs than Shopmonkey has services (the load rewrites its own on
 * every change). Helpers aren't counted: the work order editor saves them with the order, which moves its `updatedAt`.
 */
async function addedInTorqvoice(
  scope: { organizationId: string; connectionId: string },
  id: string,
  orderRemoteId: string
): Promise<boolean> {
  const { organizationId, connectionId } = scope
  const own = { serviceRecordId: id, serviceRecord: { organizationId } }
  const [reports, equipment, payments] = await Promise.all([
    db.statusReport.count({ where: own }),
    db.serviceRecordEquipment.count({ where: own }),
    db.payment.count({
      where: { ...own, OR: [{ provider: null }, { provider: { not: 'shopmonkey' } }] },
    }),
  ])
  if (reports + equipment + payments > 0) return true
  const unlinked = async (model: 'ServiceAttachment' | 'TimeEntry', ids: { id: string }[]) => {
    if (!ids.length) return false
    const linked = await db.integrationLink.count({
      where: { connectionId, entityType: model, entityId: { in: ids.map((r) => r.id) } },
    })
    return linked < ids.length
  }
  const [attachments, time] = await Promise.all([
    db.serviceAttachment.findMany({ where: own, select: { id: true } }),
    db.timeEntry.findMany({ where: own, select: { id: true } }),
  ])
  if ((await unlinked('ServiceAttachment', attachments)) || (await unlinked('TimeEntry', time))) {
    return true
  }
  const order = await db.sourceRecord.findFirst({
    where: { organizationId, source: SOURCE, table: 'order', remoteId: orderRemoteId },
    select: { payload: true },
  })
  const complaint = (order?.payload as { complaint?: unknown } | null)?.complaint
  const [concerns, jobs, services] = await Promise.all([
    db.serviceConcern.count({ where: own }),
    db.workJob.count({ where: { serviceRecordId: id, organizationId } }),
    db.sourceRecord.count({
      where: {
        organizationId,
        source: SOURCE,
        table: 'order_service',
        remoteDeletedAt: null,
        payload: { path: ['orderId'], equals: orderRemoteId },
      },
    }),
  ])
  const importedConcerns = typeof complaint === 'string' && complaint.trim() ? 1 : 0
  return concerns > importedConcerns || jobs > services
}

/**
 * A work order imported from Shopmonkey, as the app deletes one (`deleteServiceRecordService` in
 * `features/vehicles/Lib/serviceRecordService.server.ts`: keep the two in step when upstream changes it), but leaving
 * stock alone.
 */
async function deleteImportedWorkOrder(organizationId: string, userId: string, id: string) {
  await assertInvoiceEditable(id, organizationId)
  const files = await serviceRecordFileUrls(organizationId, [id])
  await db.$transaction(async (tx) => {
    // Its meter readings stay in the history, at the date they count at now.
    await unlinkMeterReadingsOfDeletedJobs(tx, { organizationId, jobIds: [id] })
    const cascaded = await cascadeTombstones(tx, { organizationId, userId }, { workOrderIds: [id] })
    await tx.serviceRecord.deleteMany({ where: { id, organizationId } })
    await deleteCustomFieldValuesOf(tx, organizationId, 'service_record', [id])
    await tx.deletedRecord.createMany({
      data: [
        { organizationId, entityType: 'work_order', entityId: id, actorUserId: userId },
        ...cascaded,
      ],
    })
  })
  await releaseFiles(files, { organizationId, reason: 'work order deleted in Shopmonkey' })
}

/** A quote imported from Shopmonkey, as the app deletes one. */
async function deleteImportedQuote(organizationId: string, userId: string, id: string) {
  await assertQuoteEditable(id, organizationId)
  const files = await quoteFileUrls(organizationId, [id])
  await db.$transaction(async (tx) => {
    await tx.quote.deleteMany({ where: { id, organizationId } })
    await deleteCustomFieldValuesOf(tx, organizationId, 'quote', [id])
    await tx.deletedRecord.create({
      data: { organizationId, entityType: 'quote', entityId: id, actorUserId: userId },
    })
  })
  await releaseFiles(files, { organizationId, reason: 'quote deleted in Shopmonkey' })
}

async function deleteRow(organizationId: string, userId: string, model: LocalModel, id: string) {
  if (model === 'ServiceRecord') await deleteImportedWorkOrder(organizationId, userId, id)
  else if (model === 'Quote') await deleteImportedQuote(organizationId, userId, id)
  else if (model === 'Appointment') {
    await deleteAppointmentService({ organizationId, userId, actor: 'user' }, id)
  }
}

/**
 * Applies the policy to every loaded record Shopmonkey has deleted: deleted, or kept and listed. A deleted one's link
 * and archive mapping go, so it isn't looked at again; a kept one is listed again by every run until someone deals
 * with it. One audit event for the run when anything was deleted. The tombstones name `userId`: the member the sync
 * loads as.
 */
export async function applyRemoteDeletes(scope: Scope, userId: string): Promise<DeleteOutcome> {
  const { organizationId, connectionId } = scope
  const records = await db.sourceRecord.findMany({
    where: {
      organizationId,
      source: SOURCE,
      remoteDeletedAt: { not: null },
      localId: { not: null },
    },
    orderBy: { id: 'asc' },
    select: { table: true, remoteId: true, localEntity: true, localId: true },
  })
  const out: DeleteOutcome = { deleted: [], kept: [] }
  for (const record of records) {
    const model = record.localEntity as LocalModel
    const id = record.localId as string
    const named = { table: record.table, remoteId: record.remoteId, model }
    const updatedAt = await rowUpdatedAt(db as unknown as Tx, model, id, organizationId)
    if (!DELETED_BY_SYNC[record.table]?.includes(model)) {
      if (updatedAt !== null || model === 'ServiceAttachment')
        out.kept.push({ ...named, reason: 'policy' })
      continue
    }
    if (updatedAt === null) {
      // Already gone from Torqvoice: only its mapping is left to clear.
      await unlink(db as unknown as Tx, scope, record.table, model, record.remoteId, id)
      continue
    }
    const link = await db.integrationLink.findFirst({
      where: { connectionId, entityType: model, entityId: id },
      select: { lastSyncedAt: true },
    })
    const edited =
      !link ||
      updatedAt.getTime() > link.lastSyncedAt.getTime() ||
      (model === 'ServiceRecord' && (await addedInTorqvoice(scope, id, record.remoteId)))
    if (edited) {
      out.kept.push({ ...named, reason: 'edited' })
      continue
    }
    try {
      await deleteRow(organizationId, userId, model, id)
    } catch (err) {
      if (err instanceof DocumentLockedError) {
        out.kept.push({ ...named, reason: 'locked' })
        continue
      }
      throw err
    }
    await unlink(db as unknown as Tx, scope, record.table, model, record.remoteId, id)
    out.deleted.push(named)
  }
  if (out.deleted.length) {
    await logAudit(
      { userId, organizationId },
      {
        action: 'shopmonkey.sync_delete',
        entity: 'integration_connection',
        entityId: connectionId,
        details: auditDetails('shopmonkey_sync_delete', { records: out.deleted.length }),
        metadata: { runId: scope.runId, deleted: out.deleted },
      }
    )
  }
  return out
}
