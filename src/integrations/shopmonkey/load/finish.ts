/**
 * What a load does around its records (M5 tasks 6 and 8): it refuses to start while a connection that hears
 * `service.update` is active (issuing an imported invoice notifies it, and the workshop's whole history would land in
 * its accounting system or calendar), issues the imported invoices once their transactions have committed, and
 * records one audit event for the run.
 */
import { issueInvoice } from '@/features/invoices/Lib/issueInvoice'
import { getManifest } from '@/integrations/registry'
import { auditDetails, logAudit } from '@/lib/audit'
import { db } from '@/lib/db'

export class LoadRefused extends Error {
  constructor(
    readonly connectors: string[],
    message = `Turn off ${connectors.join(', ')} before importing: issuing the imported invoices would send the whole history to it.`
  ) {
    super(message)
    this.name = 'LoadRefused'
  }
}

/**
 * The workshop's connections whose manifest subscribes to `service.update` (accounting, calendars) and that would
 * be sent it: the statuses `notifyIntegrations` queues jobs for (`features/integrations/Lib/events.ts`), so one in
 * `error` (an expired token) counts too, since its jobs wait and run once it's fixed. From the registry, so a
 * connector added later is covered too.
 */
export const NOTIFIED_STATUSES = ['active', 'error']

export async function connectionsHearingInvoices(organizationId: string): Promise<string[]> {
  const active = await db.integrationConnection.findMany({
    where: { organizationId, status: { in: NOTIFIED_STATUSES } },
    select: { connectorId: true },
  })
  return active
    .map((c) => getManifest(c.connectorId))
    .filter((m) => m?.subscriptions?.some((s) => s.event === 'service.update'))
    .map((m) => m?.name ?? '')
    .filter(Boolean)
}

export async function assertNoInvoiceListeners(organizationId: string): Promise<void> {
  const connectors = await connectionsHearingInvoices(organizationId)
  if (connectors.length) throw new LoadRefused(connectors)
}

/**
 * The app's own "freeze older invoices" path (MAPPING §6.1, RESULTS T5): dates `issuedAt` to `sentAt` and freezes
 * what the sheet prints. `ids` is every imported invoice of the run, loaded or unchanged: the ones not issued yet
 * (a run that stopped before this step, an issue that failed) are issued now. One that fails is counted, not fatal:
 * the record is loaded either way, and the next run tries again.
 */
export async function issueInvoices(
  organizationId: string,
  ids: string[]
): Promise<{ issued: number; failed: number; ids: string[] }> {
  const pending: string[] = []
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db.serviceRecord.findMany({
      where: { id: { in: ids.slice(i, i + 1000) }, organizationId, issuedAt: null },
      select: { id: true },
    })
    pending.push(...rows.map((r) => r.id))
  }
  let failed = 0
  const issued: string[] = []
  for (const id of pending) {
    try {
      if (await issueInvoice(id, organizationId, 'backfill')) issued.push(id)
    } catch {
      failed++
    }
  }
  return { issued: issued.length, failed, ids: issued }
}

/** The run's one audit event (`shopmonkey.import` isn't a webhook event, so no webhook fires). */
export async function recordLoad(
  organizationId: string,
  userId: string,
  summary: {
    connectionId: string
    runId: string
    records: number
    counts: Record<string, unknown>
    issued: number
    /** Invoices whose issue failed: still unlocked, tried again by the next run. */
    issueFailed: number
    /** The setting keys the run applied from its proposals. */
    applied: string[]
  }
): Promise<void> {
  await logAudit(
    { userId, organizationId },
    {
      action: 'shopmonkey.import',
      entity: 'integration_connection',
      entityId: summary.connectionId,
      details: auditDetails('shopmonkey_import', { records: summary.records }),
      metadata: {
        runId: summary.runId,
        counts: summary.counts,
        issued: summary.issued,
        issueFailed: summary.issueFailed,
        applied: summary.applied,
      },
    }
  )
}

/** An undo's one audit event (`shopmonkey.import_undo` isn't a webhook event either): what it removed and kept. */
export async function recordUndo(
  organizationId: string,
  userId: string,
  summary: {
    connectionId: string
    runId: string
    removed: Record<string, number>
    kept: Record<string, number>
  }
): Promise<void> {
  const records = Object.values(summary.removed).reduce((a, n) => a + n, 0)
  await logAudit(
    { userId, organizationId },
    {
      action: 'shopmonkey.import_undo',
      entity: 'integration_connection',
      entityId: summary.connectionId,
      details: auditDetails('shopmonkey_import_undo', { records }),
      metadata: { runId: summary.runId, removed: summary.removed, kept: summary.kept },
    }
  )
}
