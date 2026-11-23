/**
 * `POST /customers`, `PATCH /customers/{id}`, `DELETE /customers/{id}` (docs/fork/API.md §4): the customer
 * services the actions run (A2), with the actions' own audit events.
 */
import 'server-only'
import {
  customerCreatedEvent,
  customerDeletedEvent,
  customerUpdatedEvent,
} from '@/features/customers/Lib/customerAuditEvents'
import {
  createCustomerService,
  deleteCustomerService,
  updateCustomerService,
} from '@/features/customers/Lib/customerService.server'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { writeRoute } from '../Lib/writeRoute'
import { customersResource } from '../Resources/customers'
import { answerWith, deleted, withId } from './common'

const subject = PermissionSubject.CUSTOMERS
const current = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.customer.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createCustomerPOST = writeRoute<Record<string, string>, { id: string; name: string }>(
  'POST',
  {
    permission: { action: PermissionAction.CREATE, subject },
    run: (svc, body) => createCustomerService(svc, body),
    audit: (result) => customerCreatedEvent(result),
    respond: async (result, ctx) =>
      answerWith(customersResource, ctx.organizationId, result.id, 201),
  }
)

export const updateCustomerPATCH = writeRoute<{ id: string }, { id: string }>('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject },
  current,
  run: (svc, body, { id }) => updateCustomerService(svc, withId(body, id)),
  audit: (result) => customerUpdatedEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(customersResource, ctx.organizationId, id),
})

export const deleteCustomerDELETE = writeRoute<{ id: string }, { customerId: string }>('DELETE', {
  permission: { action: PermissionAction.DELETE, subject },
  current,
  run: (svc, _body, { id }) => deleteCustomerService(svc, id),
  audit: (result) => customerDeletedEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})
