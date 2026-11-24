/**
 * fork (A5, docs/fork/API.md §5): the fork's webhook events. Their `data` is the resource as the API serializes it (the
 * A3 serializer, read fresh and scoped by workshop), not the audit metadata, so a subscriber never has to call back
 * for the basics; a delete carries `{ id }`. Either way a record with no endpoint of its own carries the ids that find
 * it (a contact its `customerId`, a job its `workOrderId` or `quoteId`), and a clock start the clock it closed. The
 * app's own time entry actions go out under the API's names (`eventNames.ts`).
 */
import 'server-only'
import { db } from '@/lib/db'
import { readOne } from './readResource'
import { serializeJob, JOB_SELECT } from '../Serializers/common'
import { CONTACT_SELECT, serializeContact } from '../Serializers/customers'
import { appointmentsResource, shiftsResource, timeEntriesResource } from '../Resources/schedule'
import { techniciansResource } from '../Resources/staff'
import { workOrdersResource } from '../Resources/workOrders'
import { forkEventName, parentIdsOf } from './eventNames'

export { FORK_EVENTS } from './eventNames'

/** The serialized resource an event is about, or nothing when it's gone (or was never readable). */
async function resourceOf(
  event: string,
  organizationId: string,
  id: string
): Promise<Record<string, unknown> | undefined> {
  if (event.endsWith('.delete')) return undefined
  const kind = event.slice(0, event.indexOf('.'))
  const one = async <Row extends { id: string; updatedAt: Date }, Out>(
    resource: Parameters<typeof readOne<Row, Out>>[0]
  ) => (await readOne(resource, organizationId, id))?.data as Record<string, unknown> | undefined
  if (kind === 'appointment') return one(appointmentsResource)
  if (kind === 'technician') return one(techniciansResource)
  if (kind === 'shift') return one(shiftsResource)
  if (kind === 'time_entry') return one(timeEntriesResource)
  if (kind === 'work_order') return one(workOrdersResource)
  if (kind === 'job') {
    const job = await db.workJob.findFirst({ where: { id, organizationId }, select: JOB_SELECT })
    return job ? (serializeJob(job) as unknown as Record<string, unknown>) : undefined
  }
  if (kind === 'contact') {
    const contact = await db.customerContact.findFirst({
      where: { id, organizationId },
      select: CONTACT_SELECT,
    })
    return contact ? (serializeContact(contact) as unknown as Record<string, unknown>) : undefined
  }
  return undefined
}

/**
 * A fork event's `data`: the resource, or `{ id }` when it's gone, with the ids that find it. `event` is the API's
 * name; `metadata` the audit event's.
 */
export async function forkEventData(input: {
  event: string
  organizationId: string
  entityId: string
  metadata?: Record<string, unknown> | null
}): Promise<Record<string, unknown>> {
  const parents = parentIdsOf(input.event, input.metadata)
  const resource = await resourceOf(input.event, input.organizationId, input.entityId)
  return { ...(resource ?? { id: input.entityId }), ...parents }
}

/** For tests and callers that start from the audit event: its API name and `data`, or null for any other event. */
export async function forkEvent(input: {
  event: string
  organizationId: string
  entityId?: string | null
  data?: Record<string, unknown> | null
}): Promise<{ event: string; data: Record<string, unknown> } | null> {
  const event = forkEventName(input.event, input.data)
  if (!event || !input.entityId) return null
  return {
    event,
    data: await forkEventData({
      event,
      organizationId: input.organizationId,
      entityId: input.entityId,
      metadata: input.data,
    }),
  }
}
