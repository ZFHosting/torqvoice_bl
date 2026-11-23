/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import type { AuditEvent } from '@/lib/audit'
import type { createPaymentService, deletePaymentService } from './paymentService.server'

export function createPaymentEvent(
  result: Awaited<ReturnType<typeof createPaymentService>>
): AuditEvent {
  return {
    action: 'payment.create',
    entity: 'Payment',
    entityId: result.id,
    details: {
      key: 'payment_create',
      params: { amount: result.amount, serviceRecordId: result.serviceRecordId },
    },
    metadata: {
      paymentId: result.id,
      serviceRecordId: result.serviceRecordId,
      amount: result.amount,
      method: result.method,
    },
  }
}

export function deletePaymentEvent(
  result: Awaited<ReturnType<typeof deletePaymentService>>
): AuditEvent {
  return {
    action: 'payment.delete',
    entity: 'Payment',
    entityId: result.paymentId,
    details: { key: 'payment_delete', params: { id: result.paymentId } },
    metadata: { paymentId: result.paymentId },
  }
}
