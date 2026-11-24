/**
 * fork (A5, docs/fork/API.md §5): the fork's webhook events. Their `data` is the resource as the API serializes it (the
 * A3 serializer, read fresh and scoped by workshop), not the audit metadata, so a subscriber never has to call back
 * for the basics; a delete carries `{ id }`. The app's own time entry actions go out under the API's names:
 * `timeEntry.create` → `time_entry.create`, a stop → `time_entry.stop`, an edit → `time_entry.update`,
 * `timeEntry.delete` → `time_entry.delete` (the API's own clock start logs `time_entry.start`).
 */
import { db } from '@/lib/db'
import { readOne } from './readResource'
import { serializeJob, JOB_SELECT } from '../Serializers/common'
import { CONTACT_SELECT, serializeContact } from '../Serializers/customers'
import { appointmentsResource, shiftsResource, timeEntriesResource } from '../Resources/schedule'
import { techniciansResource } from '../Resources/staff'
import { workOrdersResource } from '../Resources/workOrders'

export const FORK_EVENTS = [
  'appointment.create',
  'appointment.update',
  'appointment.delete',
  'time_entry.start',
  'time_entry.stop',
  'time_entry.create',
  'time_entry.update',
  'time_entry.delete',
  'shift.create',
  'shift.update',
  'shift.delete',
  'technician.create',
  'technician.update',
  'technician.delete',
  'work_order.issue',
  'job.create',
  'job.update',
  'job.delete',
  'contact.create',
  'contact.update',
  'contact.delete',
] as const

const FORK = new Set<string>(FORK_EVENTS)

/** The API's name for an app action that has one of its own. */
function apiEventName(action: string, data: Record<string, unknown> | null | undefined): string {
  if (action === 'timeEntry.create') return 'time_entry.create'
  if (action === 'timeEntry.delete') return 'time_entry.delete'
  if (action === 'timeEntry.update') {
    const details = (data?.details ?? null) as { key?: string } | null
    return details?.key === 'timeEntry_stop' ? 'time_entry.stop' : 'time_entry.update'
  }
  return action
}

/** The serialized resource an event is about, or `{ id }` when it's gone (or was never readable). */
async function resourceOf(
  event: string,
  organizationId: string,
  id: string
): Promise<Record<string, unknown>> {
  if (event.endsWith('.delete')) return { id }
  const kind = event.slice(0, event.indexOf('.'))
  const one = async <Row extends { id: string; updatedAt: Date }, Out>(
    resource: Parameters<typeof readOne<Row, Out>>[0]
  ) => (await readOne(resource, organizationId, id))?.data as Record<string, unknown> | undefined
  let out: Record<string, unknown> | undefined
  if (kind === 'appointment') out = await one(appointmentsResource)
  else if (kind === 'technician') out = await one(techniciansResource)
  else if (kind === 'shift') out = await one(shiftsResource)
  else if (kind === 'time_entry') out = await one(timeEntriesResource)
  else if (kind === 'work_order') out = await one(workOrdersResource)
  else if (kind === 'job') {
    const job = await db.workJob.findFirst({ where: { id, organizationId }, select: JOB_SELECT })
    out = job ? (serializeJob(job) as unknown as Record<string, unknown>) : undefined
  } else if (kind === 'contact') {
    const contact = await db.customerContact.findFirst({
      where: { id, organizationId },
      select: CONTACT_SELECT,
    })
    out = contact ? (serializeContact(contact) as unknown as Record<string, unknown>) : undefined
  }
  return out ?? { id }
}

/**
 * For the dispatcher: a fork event's API name and its serialized `data`, or null for every other event (which goes
 * out as it always has).
 */
export async function forkEvent(input: {
  event: string
  organizationId: string
  entityId?: string | null
  data?: Record<string, unknown> | null
}): Promise<{ event: string; data: Record<string, unknown> } | null> {
  const event = apiEventName(input.event, input.data)
  if (!FORK.has(event) || !input.entityId) return null
  return { event, data: await resourceOf(event, input.organizationId, input.entityId) }
}
