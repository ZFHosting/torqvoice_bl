/**
 * fork (A5, docs/fork/API.md §5): the public API's webhook events by name, worked out from an audit event without
 * reading anything, so the dispatcher can rename an event (and check whether anyone subscribes) before it reads the
 * record. Pure: the dispatcher imports it directly.
 */

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

type Data = Record<string, unknown> | null | undefined

/** The API's name for an app action that has one of its own. */
function apiEventName(action: string, data: Data): string {
  if (action === 'timeEntry.create') return 'time_entry.create'
  if (action === 'timeEntry.delete') return 'time_entry.delete'
  if (action === 'timeEntry.update') {
    const details = (data?.details ?? null) as { key?: string } | null
    return details?.key === 'timeEntry_stop' ? 'time_entry.stop' : 'time_entry.update'
  }
  return action
}

/** A fork event's API name, or null for every other event (which goes out as it always has). */
export function forkEventName(action: string, data: Data): string | null {
  const event = apiEventName(action, data)
  return FORK.has(event) ? event : null
}

/** The payload's `entity` for a fork event: the API's kind (`job`, `contact`, `time_entry`, …), as the samples show. */
export function entityOf(event: string): string {
  return event.slice(0, event.indexOf('.'))
}

/**
 * The ids a subscriber needs to find a record that has no endpoint of its own (a contact is under its customer, a job
 * under its work order or quote), and the clock a start closed: from the audit event's metadata, so a delete carries
 * them too.
 */
export function parentIdsOf(event: string, data: Data): Record<string, string> {
  const pick = (keys: string[]) =>
    Object.fromEntries(
      keys.flatMap((key) =>
        typeof data?.[key] === 'string' && data[key] ? [[key, data[key] as string]] : []
      )
    )
  const kind = entityOf(event)
  if (kind === 'contact') return pick(['customerId'])
  if (kind === 'job') return pick(['workOrderId', 'quoteId'])
  if (event === 'time_entry.start') return pick(['closedEntryId'])
  return {}
}
