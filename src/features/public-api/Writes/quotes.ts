/**
 * Quote writes (docs/fork/API.md §4): create, change, delete, and `POST /quotes/{id}/convert` (into a work order,
 * through the app's own conversion). Each with the action's audit event.
 */
import 'server-only'
import {
  convertQuoteToServiceRecordEvent,
  createQuoteEvent,
  deleteQuoteEvent,
  updateQuoteEvent,
} from '@/features/quotes/Lib/quoteAuditEvents'
import {
  convertQuoteToServiceRecordService,
  createQuoteService,
  deleteQuoteService,
  updateQuoteService,
} from '@/features/quotes/Lib/quoteService.server'
import { retotalQuote } from '@/features/fork-records/Lib/retotalQuote.server'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { writeRoute } from '../Lib/writeRoute'
import { quotesResource } from '../Resources/quotes'
import { convertQuoteSchema } from '../Schema/quotes'
import { workOrdersResource } from '../Resources/workOrders'
import { answerWith, deleted, withId } from './common'
import { documentBody, touchesMoney } from './documentBody'

const subject = PermissionSubject.QUOTES
const current = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.quote.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createQuotePOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject },
  // Totals from the lines (documentBody.ts).
  run: async (svc, body) => {
    const result = await createQuoteService(svc, documentBody(body))
    await retotalQuote(result.id)
    return result
  },
  audit: (result) => createQuoteEvent(result),
  respond: async (result, ctx) => answerWith(quotesResource, ctx.organizationId, result.id, 201),
})

export const updateQuotePATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject },
  current,
  run: async (svc, body, { id }) => {
    const result = await updateQuoteService(svc, withId(documentBody(body), id))
    if (touchesMoney(body)) await retotalQuote(id)
    return result
  },
  audit: (result) => updateQuoteEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(quotesResource, ctx.organizationId, id),
})

export const deleteQuoteDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.DELETE, subject },
  current,
  run: (svc, _body, { id }) => deleteQuoteService(svc, id),
  audit: (result) => deleteQuoteEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})

/** The vehicle the work order is for: the quote's own unless the body names another of the workshop's. */

export const convertQuotePOST = writeRoute('POST', {
  // The app asks for creating a work order, which is what converting does.
  permission: { action: PermissionAction.CREATE, subject: PermissionSubject.SERVICES },
  run: async (svc, body, { id }: { id: string }) => {
    const { vehicleId } = convertQuoteSchema.parse(body)
    const quote = await db.quote.findFirst({
      where: { id, organizationId: svc.organizationId },
      select: { vehicleId: true },
    })
    if (!quote) throw new Error('Quote not found')
    const target = vehicleId ?? quote.vehicleId
    if (!target) throw new Error('The quote has no vehicle: send the vehicleId to convert it for')
    return convertQuoteToServiceRecordService(svc, id, target)
  },
  audit: (result) => convertQuoteToServiceRecordEvent(result),
  respond: async (result, ctx) =>
    answerWith(workOrdersResource, ctx.organizationId, result.id, 201),
})
