/**
 * The delete policy (M7 task 3): what happens in Torqvoice when Shopmonkey deletes a record during the sync window.
 * - A record only in the archive (never loaded, or left out): nothing; the archive keeps it, marked deleted.
 * - A loaded work order, quote or appointment untouched in Torqvoice since its last sync: deleted, through the app's
 *   own delete (what it takes with it, its tombstone in `DeletedRecord` for API clients).
 * - One edited in Torqvoice since (the row itself, or a payment, attachment or time entry added to it), or an invoice
 *   that is locked: kept, and listed for the report.
 * - Any other loaded record (a customer, a vehicle, a part, a technician): kept and listed. Removing one would take
 *   the history that hangs off it, which Shopmonkey may still have; the person doing the cutover decides.
 */
import { deleteAppointmentService } from '@/features/calendar/Lib/bookingService.server'
import { deleteQuoteService } from '@/features/quotes/Lib/quoteService.server'
import { deleteServiceRecordService } from '@/features/vehicles/Lib/serviceRecordService.server'
import { db } from '@/lib/db'
import { DocumentLockedError } from '@/lib/document-lock'
import type { ServiceCtx } from '@/lib/service-context'
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

/** The records the sync deletes in Torqvoice, by Shopmonkey table and the model it was loaded as. */
const DELETED_BY_SYNC: Record<string, LocalModel[]> = {
  order: ['ServiceRecord', 'Quote'],
  appointment: ['Appointment'],
}

/** Something added to a work order in Torqvoice after its last sync: a payment, an attachment, a time entry. */
async function addedTo(organizationId: string, id: string, since: Date): Promise<boolean> {
  const where = { serviceRecordId: id, serviceRecord: { organizationId }, createdAt: { gt: since } }
  const [payments, attachments, time] = await Promise.all([
    db.payment.count({ where }),
    db.serviceAttachment.count({ where }),
    db.timeEntry.count({ where }),
  ])
  return payments + attachments + time > 0
}

async function deleteRow(ctx: ServiceCtx, model: LocalModel, id: string): Promise<void> {
  try {
    if (model === 'ServiceRecord') await deleteServiceRecordService(ctx, id)
    else if (model === 'Quote') await deleteQuoteService(ctx, id)
    else if (model === 'Appointment') await deleteAppointmentService(ctx, id)
  } catch (err) {
    if (err instanceof DocumentLockedError) throw err
    // Outside a request (the CLI), the service's page refresh after its delete throws: the delete itself committed.
    if (
      (await rowUpdatedAt(db as unknown as Tx, model, id, ctx.organizationId)) === null &&
      err instanceof Error &&
      /static generation store missing/.test(err.message)
    ) {
      return
    }
    throw err
  }
}

/**
 * Applies the policy to every loaded record Shopmonkey has deleted: deleted, or kept and listed. A deleted one's link
 * and archive mapping go, so it isn't looked at again; a kept one is listed again by every run until someone deals
 * with it.
 */
export async function applyRemoteDeletes(
  scope: { organizationId: string; connectionId: string; runId: string },
  userId: string
): Promise<DeleteOutcome> {
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
  const ctx: ServiceCtx = { organizationId, userId, actor: 'user' }
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
      await unlink(db as unknown as Tx, { ...scope }, record.table, model, record.remoteId, id)
      continue
    }
    const link = await db.integrationLink.findFirst({
      where: { connectionId, entityType: model, entityId: id },
      select: { lastSyncedAt: true },
    })
    const edited =
      !link ||
      updatedAt.getTime() > link.lastSyncedAt.getTime() ||
      (model === 'ServiceRecord' && (await addedTo(organizationId, id, link.lastSyncedAt)))
    if (edited) {
      out.kept.push({ ...named, reason: 'edited' })
      continue
    }
    try {
      await deleteRow(ctx, model, id)
    } catch (err) {
      if (err instanceof DocumentLockedError) {
        out.kept.push({ ...named, reason: 'locked' })
        continue
      }
      throw err
    }
    await unlink(db as unknown as Tx, { ...scope }, record.table, model, record.remoteId, id)
    out.deleted.push(named)
  }
  return out
}
