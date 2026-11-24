/**
 * fork (A5, docs/fork/API.md §5): what the webhook dispatcher does for the public API's events, in two steps so it
 * reads nothing for an event nobody subscribes to: `forkRename` gives the API's name and kind at once (no reads), and
 * `forkData` reads the record only once a webhook wants it. A record that can't be read goes out as its id (and the
 * ids that find it), never as no delivery at all: a delivery row is what the retry cron works from.
 */
import { entityOf, forkEventName, parentIdsOf } from './eventNames'

type Input = {
  event: string
  organizationId: string
  entity?: string | null
  entityId?: string | null
  // biome-ignore lint/suspicious/noExplicitAny: the dispatcher's own input type
  data?: Record<string, any> | null
}

/** The event under the API's name and kind, or null when it isn't one of the fork's (or names no record). */
export function forkRename<T extends Input>(input: T): T | null {
  const event = forkEventName(input.event, input.data)
  if (!event || !input.entityId) return null
  return { ...input, event, entity: entityOf(event) }
}

/** The renamed event's `data`, read from the original audit event's metadata and the record. */
export async function forkData(renamed: Input, original: Input): Promise<Record<string, unknown>> {
  const entityId = renamed.entityId as string
  try {
    const { forkEventData } = await import('./eventData.server')
    return await forkEventData({
      event: renamed.event,
      organizationId: renamed.organizationId,
      entityId,
      metadata: original.data,
    })
  } catch (err) {
    console.error('[webhooks] could not read a fork event’s record; sending its id', {
      event: renamed.event,
      error: err instanceof Error ? err.name : 'unknown',
    })
    return { id: entityId, ...parentIdsOf(renamed.event, original.data) }
  }
}
