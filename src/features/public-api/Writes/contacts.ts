/**
 * `POST /customers/{id}/contacts`, `PATCH` and `DELETE /customers/{id}/contacts/{contactId}` (docs/fork/API.md §4):
 * a customer's other emails and phones (X4), through the fork's contact service.
 */
import 'server-only'
import { contactEvent } from '@/features/fork-records/Lib/forkRecordAuditEvents'
import {
  createContactService,
  deleteContactService,
  updateContactService,
} from '@/features/fork-records/Lib/forkRecordServices.server'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { publicApiError } from '../Lib/errors'
import { writeRoute } from '../Lib/writeRoute'
import { CONTACT_SELECT, serializeContact } from '../Serializers/customers'
import { deleted } from './common'

const subject = PermissionSubject.CUSTOMERS

async function answer(organizationId: string, id: string, status = 200) {
  const row = await db.customerContact.findFirst({
    where: { id, organizationId },
    select: CONTACT_SELECT,
  })
  if (!row) return publicApiError(404, 'not_found', 'Not found.')
  return Response.json({ data: serializeContact(row) }, { status })
}

const current = (ctx: { organizationId: string }, p: { id: string; contactId: string }) =>
  db.customerContact.findFirst({
    where: { id: p.contactId, customerId: p.id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createContactPOST = writeRoute('POST', {
  // A customer's details: changing them is updating the customer.
  permission: { action: PermissionAction.UPDATE, subject },
  run: (svc, body, { id }: { id: string }) => createContactService(svc, id, body),
  audit: (result) => contactEvent('create', result),
  respond: async (result, ctx) => answer(ctx.organizationId, result.id, 201),
})

export const updateContactPATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject },
  current,
  run: (svc, body, p) => updateContactService(svc, p.id, p.contactId, body),
  audit: (result) => contactEvent('update', result),
  respond: async (result, ctx) => answer(ctx.organizationId, result.id),
})

export const deleteContactDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.UPDATE, subject },
  current,
  run: (svc, _body, p) => deleteContactService(svc, p.id, p.contactId),
  audit: (result) => contactEvent('delete', result),
  respond: async (result) => deleted(result.id),
})
