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
  constructor(readonly connectors: string[]) {
    super(
      `Turn off ${connectors.join(', ')} before importing: issuing the imported invoices would send the whole history to it.`
    )
    this.name = 'LoadRefused'
  }
}

/**
 * The workshop's active connections whose manifest subscribes to `service.update` (accounting, calendars): from
 * the registry, so a connector added later is covered too.
 */
export async function connectionsHearingInvoices(organizationId: string): Promise<string[]> {
  const active = await db.integrationConnection.findMany({
    where: { organizationId, status: 'active' },
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
 * what the sheet prints. One that fails is counted, not fatal: the record is loaded either way.
 */
export async function issueInvoices(
  organizationId: string,
  ids: string[]
): Promise<{ issued: number; failed: number }> {
  let issued = 0
  let failed = 0
  for (const id of ids) {
    try {
      if (await issueInvoice(id, organizationId, 'backfill')) issued++
    } catch {
      failed++
    }
  }
  return { issued, failed }
}

/** The run's one audit event (`shopmonkey.import` isn't a webhook event, so no webhook fires). */
export async function recordLoad(
  organizationId: string,
  userId: string,
  summary: { runId: string; records: number; counts: Record<string, unknown>; issued: number }
): Promise<void> {
  await logAudit(
    { userId, organizationId },
    {
      action: 'shopmonkey.import',
      entity: 'integration_connection',
      details: auditDetails('shopmonkey_import', { records: summary.records }),
      metadata: { runId: summary.runId, counts: summary.counts, issued: summary.issued },
    }
  )
}
