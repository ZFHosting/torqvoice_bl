'use server'

import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the write bodies and their audit events live beside the payment service (A2)
import { createPaymentEvent, deletePaymentEvent } from '../Lib/paymentAuditEvents'
import { createPaymentService, deletePaymentService } from '../Lib/paymentService.server'

export async function createPayment(input: unknown) {
  return withAuth(
    // fork: the body is createPaymentService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createPaymentService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.BILLING },
      ],
      audit: ({ result }) => createPaymentEvent(result),
    }
  )
}

export async function deletePayment(paymentId: string) {
  return withAuth(
    // fork: the body is deletePaymentService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deletePaymentService({ organizationId, userId, actor: 'user' }, paymentId),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.BILLING },
      ],
      audit: ({ result }) => deletePaymentEvent(result),
    }
  )
}

/**
 * How much has been paid on one invoice, for the pay code dialog to watch
 * while a customer pays on their own phone. The payment is booked by the
 * vendor's webhook, not by this browser, so the page has to ask; asking for
 * one sum every few seconds is a great deal cheaper than re-rendering the
 * work order to find out.
 */
export async function getPaidTotal(serviceRecordId: string) {
  return withAuth(
    async ({ organizationId }) => {
      const record = await db.serviceRecord.findFirst({
        where: { id: serviceRecordId, organizationId },
        select: { manuallyPaid: true, payments: { select: { amount: true } } },
      })
      if (!record) throw new Error('Service record not found')
      return {
        paid: Math.round(record.payments.reduce((sum, p) => sum + p.amount, 0) * 100) / 100,
        payments: record.payments.length,
        manuallyPaid: record.manuallyPaid,
      }
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SERVICES }],
    }
  )
}
