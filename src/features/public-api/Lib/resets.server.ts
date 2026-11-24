/**
 * fork (A5, docs/fork/API.md §4 "Deletes"): changes no tombstone can describe, told to API clients that sync with
 * `updatedSince` and `GET /api/v1/deleted`. A restore replaces the workshop's rows (tombstones included) and brings
 * rows back with their old `updatedAt`; a bulk delete (the settings' content wipe, removing the sample data, undoing a
 * spreadsheet import or a Shopmonkey load) removes rows, and what cascades with them, without a tombstone each. Each
 * leaves one marker in `DeletedRecord`: `entityType` `restore` or `reset`, `entityId` the reason. A client that reads
 * one resyncs in full. Written after the change commits, so its time is never earlier than a poll that couldn't see
 * the change yet.
 */
import { dispatchWebhookEvent } from '@/features/webhooks/Lib/dispatcher'
import { db } from '@/lib/db'

export const RESET_REASONS = [
  'restore',
  'delete_content',
  'sample_data',
  'import_undo',
  'shopmonkey_undo',
] as const
export type ResetReason = (typeof RESET_REASONS)[number]

/** The marker kinds `/deleted` serves to every key: they name no record. */
export const MARKER_TYPES = ['restore', 'reset'] as const

/** Records the marker. Never throws: the change it describes has already happened and must not fail for it. */
export async function recordReset(
  organizationId: string,
  reason: ResetReason,
  actorUserId?: string | null
): Promise<void> {
  try {
    await db.deletedRecord.create({
      data: {
        organizationId,
        entityType: reason === 'restore' ? 'restore' : 'reset',
        entityId: reason,
        actorUserId: actorUserId ?? null,
      },
    })
  } catch (err) {
    console.error('[public-api] could not record a reset marker', {
      organizationId,
      reason,
      error: err instanceof Error ? err.name : 'unknown',
    })
  }
}

/** `restore.complete` (API.md §5): the restore is done, records and files; the client resyncs in full. */
export async function announceRestore(organizationId: string, actorUserId?: string | null) {
  await dispatchWebhookEvent({
    event: 'restore.complete',
    organizationId,
    entity: 'organization',
    entityId: organizationId,
    userId: actorUserId ?? null,
    data: { restoredAt: new Date().toISOString() },
  }).catch((err) =>
    console.error('[public-api] could not announce a restore', {
      organizationId,
      error: err instanceof Error ? err.name : 'unknown',
    })
  )
}
