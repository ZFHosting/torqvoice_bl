/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { toSafeWorkshopDate } from '@/lib/workshop-datetime'
import { db } from '@/lib/db'
import { issueInvoice } from '@/features/invoices/Lib/issueInvoice'
import { createPaymentSchema } from '../Schema/paymentSchema'
import { revalidatePath } from 'next/cache'
import { getDocumentLockSettings } from '@/lib/document-lock.server'
import { DocumentLockedError, invoiceLockState } from '@/lib/document-lock'
import type { ServiceCtx } from '@/lib/service-context'

export async function createPaymentService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = createPaymentSchema.parse(input)

  // Verify ownership: serviceRecord -> vehicle -> organizationId
  const serviceRecord = await db.serviceRecord.findFirst({
    where: { id: data.serviceRecordId, organizationId },
    select: { id: true, vehicleId: true },
  })
  if (!serviceRecord) throw new Error('Service record not found')

  const payment = await db.payment.create({
    data: {
      serviceRecordId: data.serviceRecordId,
      amount: data.amount,
      date: toSafeWorkshopDate(data.date, await workshopTimeZone(organizationId)) ?? new Date(),
      method: data.method,
      note: data.note || null,
    },
  })
  // Money against it makes the invoice the customer's document, even one
  // handed over on paper and never sent through the app.
  await issueInvoice(data.serviceRecordId, organizationId, 'paid')

  revalidatePath(
    serviceRecord.vehicleId
      ? `/vehicles/${serviceRecord.vehicleId}/service/${data.serviceRecordId}`
      : `/sales/${data.serviceRecordId}`
  )
  return {
    ...payment,
    serviceRecordId: data.serviceRecordId,
    amount: data.amount,
    method: data.method,
  }
}

export async function deletePaymentService(ctx: ServiceCtx, paymentId: string) {
  const { organizationId, userId } = ctx
  const payment = await db.payment.findFirst({
    where: { id: paymentId, serviceRecord: { organizationId } },
    include: {
      serviceRecord: {
        select: {
          vehicleId: true,
          id: true,
          sentAt: true,
          manuallyPaid: true,
          totalAmount: true,
          cost: true,
          editUnlockedAt: true,
          payments: { select: { id: true, amount: true } },
        },
      },
    },
  })
  if (!payment) throw new Error('Payment not found')

  // Recording payments is always allowed, but removing the payment that
  // settled a locked invoice would release the lock — the admin-only
  // unlock in disguise. Deleting a partial payment stays open to everyone,
  // since it never changes the lock.
  const settings = await getDocumentLockSettings(organizationId)
  const before = invoiceLockState(payment.serviceRecord, settings)
  const after = invoiceLockState(
    {
      ...payment.serviceRecord,
      payments: payment.serviceRecord.payments.filter((p) => p.id !== paymentId),
    },
    settings
  )
  if (before.locked && !after.locked && before.reason) {
    throw new DocumentLockedError(before.reason)
  }

  await db.payment.delete({ where: { id: paymentId } })
  // fork: the tombstone an API client syncing payments learns the delete from.
  await db.deletedRecord.create({
    data: { organizationId, entityType: 'payment', entityId: paymentId, actorUserId: userId },
  })

  const { vehicleId, id: serviceId } = payment.serviceRecord
  revalidatePath(vehicleId ? `/vehicles/${vehicleId}/service/${serviceId}` : `/sales/${serviceId}`)
  return { deleted: true, paymentId }
}
