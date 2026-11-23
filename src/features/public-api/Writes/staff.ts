/**
 * `POST /technicians`, `PATCH /technicians/{id}`, `DELETE /technicians/{id}` (docs/fork/API.md §4): the work board's
 * technician services (A2), with the actions' own audit events. A delete deactivates the technician, as the app
 * does (their clocked hours stay); it reads on with `active=false`.
 */
import 'server-only'
import {
  createTechnicianEvent,
  deleteTechnicianEvent,
  updateTechnicianEvent,
} from '@/features/workboard/Lib/technicianAuditEvents'
import {
  createTechnicianService,
  deleteTechnicianService,
  updateTechnicianService,
} from '@/features/workboard/Lib/technicianService.server'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { writeRoute } from '../Lib/writeRoute'
import { techniciansResource } from '../Resources/staff'
import { answerWith, deleted, withId } from './common'

const subject = PermissionSubject.WORK_BOARD
const current = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.technician.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createTechnicianPOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject },
  // A `userId` must be a member of the workshop: the service refuses another's as "User not found" (a 404).
  run: (svc, body) => createTechnicianService(svc, body),
  audit: (result) => createTechnicianEvent(result),
  respond: async (result, ctx) =>
    answerWith(techniciansResource, ctx.organizationId, result.id, 201),
})

export const updateTechnicianPATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject },
  current,
  run: (svc, body, { id }) => updateTechnicianService(svc, withId(body, id)),
  audit: (result) => updateTechnicianEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(techniciansResource, ctx.organizationId, id),
})

export const deleteTechnicianDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.DELETE, subject },
  current,
  run: (svc, _body, { id }) => deleteTechnicianService(svc, id),
  audit: (result) => deleteTechnicianEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})
