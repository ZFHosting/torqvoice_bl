/**
 * fork: tombstones for what a delete takes with it by cascade (A2 review), so an API client syncing
 * `/payments`, `/time-entries`, `/findings` or `/inspections` by `updatedSince` learns those rows are
 * gone too (`GET /api/v1/deleted`). Read before the delete, inside its transaction; the caller writes
 * them after the delete, beside the deleted row's own tombstone.
 *
 * Only the cascades onto the API's top-level resources. What only an API parent serves (a work
 * order's attachments, a vehicle's notes and reminders) follows its parent's tombstone.
 */
import 'server-only'
import type { TxClient } from '@/lib/db'

export interface Tombstone {
  organizationId: string
  entityType: string
  entityId: string
  actorUserId: string
}

interface Cascade {
  /** Work orders being deleted. Every read below is also scoped to the workshop. */
  workOrderIds?: string[]
  /** A vehicle being deleted. Every read below is also scoped to the workshop. */
  vehicleId?: string
}

export async function cascadeTombstones(
  tx: TxClient,
  scope: { organizationId: string; userId: string },
  of: Cascade
): Promise<Tombstone[]> {
  const stone = (entityType: string) => (row: { id: string }) => ({
    organizationId: scope.organizationId,
    entityType,
    entityId: row.id,
    actorUserId: scope.userId,
  })
  const workOrderIds = of.workOrderIds ?? []
  const [payments, timeEntries, findings, inspections] = await Promise.all([
    workOrderIds.length
      ? tx.payment.findMany({
          where: {
            serviceRecordId: { in: workOrderIds },
            serviceRecord: { organizationId: scope.organizationId },
          },
          select: { id: true },
        })
      : [],
    workOrderIds.length
      ? tx.timeEntry.findMany({
          where: { organizationId: scope.organizationId, serviceRecordId: { in: workOrderIds } },
          select: { id: true },
        })
      : [],
    of.vehicleId
      ? tx.vehicleFinding.findMany({
          where: { vehicleId: of.vehicleId, vehicle: { organizationId: scope.organizationId } },
          select: { id: true },
        })
      : [],
    of.vehicleId
      ? tx.inspection.findMany({
          where: { organizationId: scope.organizationId, vehicleId: of.vehicleId },
          select: { id: true },
        })
      : [],
  ])
  return [
    ...payments.map(stone('payment')),
    ...timeEntries.map(stone('time_entry')),
    ...findings.map(stone('finding')),
    ...inspections.map(stone('inspection')),
  ]
}
