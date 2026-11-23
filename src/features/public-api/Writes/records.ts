/**
 * Finding and webhook writes (docs/fork/API.md §4), through the services the vehicle page and the webhook settings
 * run (A2), with their own audit events.
 *
 * - A finding's job is `workOrderId` here, as the read says it (the service's `serviceRecordId`); a vehicle, job or
 *   concern of another workshop is not found. `POST /findings/{id}/resolve` is the app's "resolved".
 * - A webhook is made with the URL checks the settings page runs (no private or loopback addresses), and answers
 *   with its signing secret this once. A change is the webhook as stored with the fields sent laid over it.
 */
import 'server-only'
import {
  createFindingEvent,
  deleteFindingEvent,
  resolveFindingEvent,
  updateFindingEvent,
} from '@/features/vehicles/Lib/findingAuditEvents'
import {
  createFindingService,
  deleteFindingService,
  resolveFindingService,
  updateFindingService,
} from '@/features/vehicles/Lib/findingService.server'
import {
  createWebhookEvent,
  deleteWebhookEvent,
  updateWebhookEvent,
} from '@/features/webhooks/Lib/webhookAuditEvents'
import {
  createWebhookService,
  deleteWebhookService,
  updateWebhookService,
} from '@/features/webhooks/Lib/webhookService.server'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { publicApiError } from '../Lib/errors'
import { readOne } from '../Lib/readResource'
import { writeRoute } from '../Lib/writeRoute'
import { findingsResource, webhooksResource } from '../Resources/records'
import { createFindingSchema, resolveFindingSchema, updateFindingSchema } from '../Schema/records'
import { answerWith, deleted } from './common'

/* ---------- findings ---------- */

// The app asks for changing vehicles to record, change or remove a finding.
const vehicles = PermissionSubject.VEHICLES

const currentFinding = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.vehicleFinding.findFirst({
    where: { id, vehicle: { organizationId: ctx.organizationId } },
    select: { id: true, updatedAt: true },
  })

/** The body with the API's `workOrderId` under the service's name for it. */
function asService(body: Record<string, unknown>): Record<string, unknown> {
  const { workOrderId, ...rest } = body
  return workOrderId === undefined ? rest : { ...rest, serviceRecordId: workOrderId }
}

export const createFindingPOST = writeRoute('POST', {
  permission: { action: PermissionAction.UPDATE, subject: vehicles },
  run: (svc, body) => createFindingService(svc, asService(createFindingSchema.parse(body))),
  audit: (result) => createFindingEvent(result),
  respond: async (result, ctx) => answerWith(findingsResource, ctx.organizationId, result.id, 201),
})

export const updateFindingPATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject: vehicles },
  current: currentFinding,
  run: (svc, body, { id }) => {
    updateFindingSchema.parse(body)
    // The body as sent (not as parsed), so a field left out stays left out.
    return updateFindingService(svc, { ...asService(body as Record<string, unknown>), id })
  },
  audit: (result) => updateFindingEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(findingsResource, ctx.organizationId, id),
})

export const resolveFindingPOST = writeRoute('POST', {
  permission: { action: PermissionAction.UPDATE, subject: vehicles },
  current: currentFinding,
  run: (svc, body, { id }: { id: string }) => {
    const { workOrderId } = resolveFindingSchema.parse(body)
    return resolveFindingService(svc, { id, resolvedServiceRecordId: workOrderId })
  },
  audit: (result) => resolveFindingEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(findingsResource, ctx.organizationId, id),
})

export const deleteFindingDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.UPDATE, subject: vehicles },
  current: currentFinding,
  run: (svc, _body, { id }) => deleteFindingService(svc, id),
  audit: (result) => deleteFindingEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})

/* ---------- webhooks ---------- */

// Every webhook write in the app asks for changing settings.
const settings = { action: PermissionAction.UPDATE, subject: PermissionSubject.SETTINGS }

const currentWebhook = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.webhook.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createWebhookPOST = writeRoute('POST', {
  permission: settings,
  run: (svc, body) => createWebhookService(svc, body),
  audit: (result) => createWebhookEvent(result),
  respond: async (result, ctx) => {
    const one = await readOne(webhooksResource, ctx.organizationId, result.id)
    if (!one) return publicApiError(404, 'not_found', 'Not found.')
    return Response.json(
      { data: { ...one.data, secret: result.secret } },
      { status: 201, headers: { ETag: one.etag } }
    )
  },
})

export const updateWebhookPATCH = writeRoute('PATCH', {
  permission: settings,
  current: currentWebhook,
  run: async (svc, body, { id }: { id: string }) => {
    const own = await db.webhook.findFirst({
      where: { id, organizationId: svc.organizationId },
      select: { name: true, url: true, description: true, events: true, isActive: true },
    })
    if (!own) throw new Error('Webhook not found')
    const sent = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    return updateWebhookService(svc, {
      name: own.name,
      url: own.url,
      description: own.description,
      events: JSON.parse(own.events) as unknown,
      isActive: own.isActive,
      ...sent,
      id,
    })
  },
  audit: (result) => updateWebhookEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(webhooksResource, ctx.organizationId, id),
})

export const deleteWebhookDELETE = writeRoute('DELETE', {
  permission: settings,
  current: currentWebhook,
  run: (svc, _body, { id }) => deleteWebhookService(svc, id),
  audit: (result) => deleteWebhookEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})
