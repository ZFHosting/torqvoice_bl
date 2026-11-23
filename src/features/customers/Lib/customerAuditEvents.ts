/**
 * fork: the audit events a customer write logs, in one place for both callers: the server actions
 * pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the same either
 * way (docs/fork/API.md §1.1). Moved unchanged from customerActions.ts.
 */
import type { AuditEvent } from '@/lib/audit'

export function customerCreatedEvent(customer: { id: string; name: string }): AuditEvent {
  return {
    action: 'customer.create',
    entity: 'Customer',
    entityId: customer.id,
    details: { key: 'customer_create', params: { name: customer.name } },
    metadata: { customerId: customer.id },
  }
}

export function customerUpdatedEvent(result: { id: string }): AuditEvent {
  return {
    action: 'customer.update',
    entity: 'Customer',
    entityId: result.id,
    details: { key: 'customer_update', params: { id: result.id } },
    metadata: { customerId: result.id },
  }
}

export function customerDeletedEvent(result: { customerId: string }): AuditEvent {
  return {
    action: 'customer.delete',
    entity: 'Customer',
    entityId: result.customerId,
    details: { key: 'customer_delete', params: { id: result.customerId } },
    metadata: { customerId: result.customerId },
  }
}
