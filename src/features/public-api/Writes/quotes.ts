/**
 * Quote writes (docs/fork/API.md §4): create, change, delete, and `POST /quotes/{id}/convert` (into a work order,
 * through the app's own conversion). Each with the action's audit event.
 */
import 'server-only'
import { z } from 'zod'
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
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { writeRoute } from '../Lib/writeRoute'
import { quotesResource } from '../Resources/quotes'
import { workOrdersResource } from '../Resources/workOrders'
import { answerWith, deleted, withId } from './common'

const subject = PermissionSubject.QUOTES
const current = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.quote.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createQuotePOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject },
  run: (svc, body) => createQuoteService(svc, body),
  audit: (result) => createQuoteEvent(result),
  respond: async (result, ctx) => answerWith(quotesResource, ctx.organizationId, result.id, 201),
})

export const updateQuotePATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject },
  current,
  run: (svc, body, { id }) => updateQuoteService(svc, withId(body, id)),
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
const convertSchema = z.object({ vehicleId: z.string().min(1).optional() }).strict()

export const convertQuotePOST = writeRoute('POST', {
  // The app asks for creating a work order, which is what converting does.
  permission: { action: PermissionAction.CREATE, subject: PermissionSubject.SERVICES },
  run: async (svc, body, { id }: { id: string }) => {
    const { vehicleId } = convertSchema.parse(body)
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
