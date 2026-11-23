/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { parseWorkshopDateTime } from '@/lib/workshop-datetime'
import { createManualEntry, deleteEntry, TimeEntryError, updateEntry } from '../Lib/timeEntries'
import { toSheetEntries } from '../Lib/serialize'
import type { ServiceCtx } from '@/lib/service-context'

/** Wall-clock input from the dialog, "YYYY-MM-DDTHH:MM" in the workshop's zone. */
const wallClock = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/)

export const createSchema = z.object({
  technicianId: z.string().min(1),
  serviceRecordId: z.string().min(1),
  startedAt: wallClock,
  endedAt: wallClock,
  note: z.string().max(500).optional().nullable(),
})

export async function createTimeEntryService(ctx: ServiceCtx, input: z.input<typeof createSchema>) {
  const args = createSchema.parse(input)
  const timeZone = await workshopTimeZone(ctx.organizationId)
  const entry = await createManualEntry({
    organizationId: ctx.organizationId,
    technicianId: args.technicianId,
    serviceRecordId: args.serviceRecordId,
    startedAt: parseWorkshopDateTime(args.startedAt, timeZone),
    endedAt: parseWorkshopDateTime(args.endedAt, timeZone),
    note: args.note,
    editedByUserId: ctx.userId,
  })
  const [sheet] = await toSheetEntries([entry])
  return sheet
}

export const updateSchema = z.object({
  id: z.string().min(1),
  // fork: each of these left out keeps what the entry has (the public API's PATCH, A4). The timesheet sends all three.
  startedAt: wallClock.optional(),
  /** Null keeps a running clock running. */
  endedAt: wallClock.nullable().optional(),
  note: z.string().max(500).optional().nullable(),
})

export async function updateTimeEntryService(ctx: ServiceCtx, input: z.input<typeof updateSchema>) {
  const args = updateSchema.parse(input)
  const timeZone = await workshopTimeZone(ctx.organizationId)
  // fork: what wasn't sent, as the entry has it (to the second, where a wall clock is to the minute)
  const sentAll =
    args.startedAt !== undefined && args.endedAt !== undefined && args.note !== undefined
  const kept = sentAll
    ? null
    : await db.timeEntry.findFirst({
        where: { id: args.id, organizationId: ctx.organizationId },
        select: { startedAt: true, endedAt: true, note: true },
      })
  if (!sentAll && !kept) throw new TimeEntryError('job_not_found', 'That entry no longer exists.')
  const entry = await updateEntry({
    organizationId: ctx.organizationId,
    id: args.id,
    startedAt:
      args.startedAt !== undefined
        ? parseWorkshopDateTime(args.startedAt, timeZone)
        : (kept?.startedAt as Date),
    endedAt:
      args.endedAt !== undefined
        ? args.endedAt
          ? parseWorkshopDateTime(args.endedAt, timeZone)
          : null
        : (kept?.endedAt ?? null),
    note: args.note !== undefined ? args.note : kept?.note,
    editedByUserId: ctx.userId,
  })
  const [sheet] = await toSheetEntries([entry])
  return sheet
}

export async function stopTimeEntryService(ctx: ServiceCtx, id: string) {
  const existing = await db.timeEntry.findFirst({
    where: { id, organizationId: ctx.organizationId, endedAt: null },
    select: { startedAt: true },
  })
  if (!existing) throw new Error('That clock is not running.')
  const entry = await updateEntry({
    organizationId: ctx.organizationId,
    id,
    startedAt: existing.startedAt,
    endedAt: new Date(),
    editedByUserId: ctx.userId,
  })
  const [sheet] = await toSheetEntries([entry])
  return sheet
}

export async function deleteTimeEntryService(ctx: ServiceCtx, id: string) {
  const removed = await deleteEntry(ctx.organizationId, id)
  // fork: the tombstone an API client syncing time entries learns the delete from.
  await db.deletedRecord.create({
    data: {
      organizationId: ctx.organizationId,
      entityType: 'time_entry',
      entityId: removed.id,
      actorUserId: ctx.userId,
    },
  })
  return { id: removed.id }
}
