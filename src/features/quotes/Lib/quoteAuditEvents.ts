/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import type { AuditEvent } from '@/lib/audit'
import type {
  createQuoteService,
  updateQuoteService,
  updateQuoteStatusService,
  deleteQuoteService,
  convertQuoteToServiceRecordService,
} from './quoteService.server'

export function createQuoteEvent(
  result: Awaited<ReturnType<typeof createQuoteService>>
): AuditEvent {
  return {
    action: 'quote.create',
    entity: 'Quote',
    entityId: result.id,
    details: { key: 'quote_create', params: { ref: result.quoteNumber || result.id } },
    metadata: { quoteId: result.id },
  }
}

export function updateQuoteEvent(
  result: Awaited<ReturnType<typeof updateQuoteService>>
): AuditEvent {
  return {
    action: 'quote.update',
    entity: 'Quote',
    entityId: result.id,
    details: { key: 'quote_update', params: { ref: result.id } },
    metadata: { quoteId: result.id },
  }
}

export function updateQuoteStatusEvent(
  result: Awaited<ReturnType<typeof updateQuoteStatusService>>
): AuditEvent {
  return {
    action: 'quote.status',
    entity: 'Quote',
    entityId: result.quoteId,
    details: { key: 'quote_status', params: { status: result.status } },
    metadata: { quoteId: result.quoteId, status: result.status },
  }
}

export function deleteQuoteEvent(
  result: Awaited<ReturnType<typeof deleteQuoteService>>
): AuditEvent {
  return {
    action: 'quote.delete',
    entity: 'Quote',
    entityId: result.quoteId,
    details: { key: 'quote_delete', params: { ref: result.quoteId } },
    metadata: { quoteId: result.quoteId },
  }
}

export function convertQuoteToServiceRecordEvent(
  result: Awaited<ReturnType<typeof convertQuoteToServiceRecordService>>
): AuditEvent {
  return {
    action: 'quote.convert',
    entity: 'Quote',
    entityId: result.convertedFromQuoteId,
    details: {
      key: 'quote_convert',
      params: { ref: result.convertedFromQuoteId, serviceRecordId: result.id },
    },
    metadata: { quoteId: result.convertedFromQuoteId, serviceRecordId: result.id },
  }
}
