/**
 * fork (A5, docs/fork/API.md §5): the events a clock sends, for the clocks that log none of their own (the app's own
 * My clock, the technician app's start and stop) and for the clock a start closes. A start that only taps the clock
 * already running on that job changes nothing and sends nothing (`startEntry`'s `fresh`).
 */
import 'server-only'
import { auditDetails, logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { timeEntryStartEvent } from './forkRecordAuditEvents'

type Ctx = { userId: string; organizationId: string }

/** `time_entry.stop` for a clock that stopped: the app's own stop event (`timeEntry.update`, key `timeEntry_stop`). */
export async function logClockStop(ctx: Ctx, entryId: string): Promise<void> {
  const entry = await db.timeEntry.findFirst({
    where: { id: entryId, organizationId: ctx.organizationId },
    select: {
      id: true,
      durationMinutes: true,
      technician: { select: { name: true } },
      serviceRecord: { select: { title: true } },
    },
  })
  if (!entry) return
  await logAudit(ctx, {
    action: 'timeEntry.update',
    entity: 'timeEntry',
    entityId: entry.id,
    details: auditDetails('timeEntry_stop', {
      technician: entry.technician.name,
      job: entry.serviceRecord.title,
      minutes: entry.durationMinutes ?? 0,
    }),
  })
}

/** `time_entry.start` for a clock that started, after the stop of the clock it closed. Nothing for a no-op start. */
export async function logClockStart(
  ctx: Ctx,
  started: {
    entry: { id: string; technicianId: string; serviceRecordId: string }
    closed: { id: string } | null
    fresh?: boolean
  }
): Promise<void> {
  if (started.fresh === false) return
  if (started.closed) await logClockStop(ctx, started.closed.id)
  await logAudit(
    ctx,
    timeEntryStartEvent({
      id: started.entry.id,
      technicianId: started.entry.technicianId,
      serviceRecordId: started.entry.serviceRecordId,
      closedEntryId: started.closed?.id ?? null,
    })
  )
}
