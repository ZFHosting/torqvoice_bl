/**
 * fork: moved unchanged from the server actions in createDraftServiceRecord.ts (A2), so the actions
 * and the public API share one definition. Callers check permissions and log the audit event
 * (serviceRecordAuditEvents.ts).
 */
import 'server-only'
import { db } from '@/lib/db'
import type { ServiceCtx } from '@/lib/service-context'
import { createDraftRecord } from './createDraftRecord'

export async function createDraftServiceRecordService(
  ctx: ServiceCtx,
  vehicleId: string,
  startDateTime?: Date,
  endDateTime?: Date,
  technicianId?: string,
  workBayId?: string,
  /** The day the job is wanted, when no time was given; see createDraftRecord. */
  bookFrom?: Date
) {
  const { organizationId, userId } = ctx
  const vehicle = await db.vehicle.findFirst({
    where: { id: vehicleId, organizationId },
    include: { customer: { select: { taxExempt: true } } },
  })
  if (!vehicle) throw new Error('Vehicle not found')

  return createDraftRecord(
    { organizationId, userId },
    {
      vehicleId,
      customerId: null,
      customerExempt: vehicle.customer?.taxExempt ?? false,
      // Named from the workshop's title template once the number is known.
      title: null,
      startDateTime,
      endDateTime,
      technicianId,
      workBayId,
      bookFrom,
    }
  )
}

export async function createDraftCounterSaleService(ctx: ServiceCtx, customerId: string) {
  const { organizationId, userId } = ctx
  const customer = await db.customer.findFirst({
    where: { id: customerId, organizationId },
    select: { id: true, taxExempt: true },
  })
  if (!customer) throw new Error('Customer not found')

  return createDraftRecord(
    { organizationId, userId },
    {
      vehicleId: null,
      customerId: customer.id,
      customerExempt: customer.taxExempt,
      title: 'Parts Sale',
    }
  )
}
