/**
 * fork (A5, docs/fork/API.md §5): the events a clock sends, for the clocks that log none of their own (the app's own
 * My clock, the technician app's start, stop and finishing a job) and for the clock a start closes. Never fails the
 * clock change it reports: that has committed already. A start that only taps the clock
 * already running on that job changes nothing and sends nothing (`startEntry`'s `fresh`).
 */
import 'server-only'
import { auditDetails, logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { timeEntryStartEvent } from './forkRecordAuditEvents'

type Ctx = { userId: string; organizationId: string }

/** Logs a clock's events without ever failing the clock change: it has already committed. */
async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.error('[time-tracking] could not log a clock event', {
      what,
      error: err instanceof Error ? err.name : 'unknown',
    })
  }
}

/** `time_entry.stop` for a clock that stopped: the app's own stop event (`timeEntry.update`, key `timeEntry_stop`). */
export async function logClockStop(ctx: Ctx, entryId: string): Promise<void> {
  await safely('stop', () => stopEvent(ctx, entryId))
}

async function stopEvent(ctx: Ctx, entryId: string): Promise<void> {
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
  await safely('start', () =>
    logAudit(
      ctx,
      timeEntryStartEvent({
        id: started.entry.id,
        technicianId: started.entry.technicianId,
        serviceRecordId: started.entry.serviceRecordId,
        closedEntryId: started.closed?.id ?? null,
      })
    )
  )
}
