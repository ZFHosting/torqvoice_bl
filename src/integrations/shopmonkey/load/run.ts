/**
 * A load run (M5): every staged table written into the workshop in the plan's order, each record (each order with
 * everything on it) in its own transaction. A dry run does all of it inside one transaction (a savepoint per record)
 * and rolls it back, so it reports exactly what a real run would change and keeps nothing.
 */
import { randomUUID } from 'node:crypto'
import { SETTING_KEYS } from '@/features/settings/Schema/settingsSchema'
import type { Stage } from '@/features/work-order-statuses/Lib/stages'
import { db } from '@/lib/db'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { defaultStages } from '../transform/staff'
import type { Warning } from '../transform/types'
import {
  type Counts,
  clientOf,
  closeBatches,
  createLoadContext,
  type LoadContext,
  openBatches,
  type Tx,
} from './context'
import { loadInventory, loadPresets } from './catalog'
import { removePlaced } from './files'
import { assertNoInvoiceListeners, issueInvoices, recordLoad } from './finish'
import { loadAppointments, loadInspections, loadInspectionTemplates, loadTime } from './history'
import { loadOrders } from './orders'
import {
  loadCustomers,
  loadTechnicians,
  loadVehicles,
  loadWorkflowStatuses,
  stagedAll,
} from './people'
import { applySettingChanges, type Proposals, proposeNumbering, proposeSettings } from './proposals'
import { importLabeler } from './labels'
import { loadResolver } from './resolver'

export interface LoadOptions {
  organizationId: string
  connectionId: string
  /** The member running the import: `userId` on created customers, vehicles, quotes, inventory. */
  runUserId: string
  dryRun?: boolean
  /** Apply the numbering proposal (MAPPING §9) after the load. Never on a dry run. */
  applyNumbering?: boolean
  /** Apply the settings proposal (tax, labor rate, units, time zone) after the load. Never on a dry run. */
  applySettings?: boolean
  /** The workshop's own zone unless given. */
  timeZone?: string
  /** For phone numbers without one: the workshop's default country unless given, else US (Shopmonkey's market). */
  countryCode?: string
  /** The operator's stage per workflow status (M8); the rest take the default (RESULTS S9). */
  statusStageMap?: Record<string, Stage>
  technicianMap?: Record<string, string | 'create'>
  now?: Date
}

export interface LoadSummary {
  runId: string
  dryRun: boolean
  counts: Record<string, Counts>
  /** Warning codes and how often each came up (the M6 report has them in full). */
  warnings: Record<string, number>
  failures: LoadContext['failures']
  batches: LoadContext['batches']
  /** Work orders that were issued as invoices after their transaction. */
  issued: number
  /** Shopmonkey's unit system for mileage, from the oldest vehicle: proposed to the workshop. */
  mileageUnit: string | null
  /** What the load proposes to the workshop's numbering and settings (task 9). */
  proposals: Proposals
  /** The setting keys this run wrote, from the proposals the operator asked to apply. */
  applied: string[]
}

class DryRunDone extends Error {}

async function stages(lc: LoadContext): Promise<{ mileageUnit: string | null }> {
  await openBatches(lc)
  await loadTechnicians(lc)
  await loadWorkflowStatuses(lc)
  const customers = await loadCustomers(lc)
  const vehicles = await loadVehicles(lc)
  await loadInventory(lc)
  await loadPresets(lc)
  const orders = await loadOrders(lc)
  await loadAppointments(lc)
  await loadInspectionTemplates(lc)
  const inspections = await loadInspections(lc)
  await loadTime(lc)
  await closeBatches(lc, {
    customers,
    vehicles: vehicles.created,
    services: orders.createdServiceRecords,
    inspections,
  })
  return { mileageUnit: vehicles.mileageUnit }
}

function countWarnings(warnings: Warning[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const w of warnings) out[w.code] = (out[w.code] ?? 0) + 1
  return out
}

export async function runLoad(options: LoadOptions): Promise<LoadSummary> {
  const scope = {
    organizationId: options.organizationId,
    connectionId: options.connectionId,
    runId: randomUUID(),
  }
  // Issuing an imported invoice notifies whatever hears `service.update`: nothing is written while one is on.
  if (!options.dryRun) await assertNoInvoiceListeners(scope.organizationId)
  const resolver = await loadResolver(scope)
  const statuses = await db.sourceRecord.findMany({
    where: { organizationId: scope.organizationId, source: 'shopmonkey', table: 'workflow_status' },
    select: { payload: true },
  })
  const statusStageMap: Record<string, Stage> = {
    ...Object.fromEntries(defaultStages(statuses.map((s) => s.payload as Record<string, unknown>))),
    ...(options.statusStageMap ?? {}),
  }
  const country = await db.appSetting.findFirst({
    where: {
      organizationId: scope.organizationId,
      key: SETTING_KEYS.WORKSHOP_DEFAULT_COUNTRY_CODE,
    },
    select: { value: true },
  })
  const lc = createLoadContext({
    scope,
    runUserId: options.runUserId,
    resolver,
    timeZone: options.timeZone ?? (await workshopTimeZone(scope.organizationId)),
    countryCode: options.countryCode ?? (country?.value || 'US'),
    statusStageMap,
    technicianMap: options.technicianMap,
    now: options.now,
    label: await importLabeler(scope.organizationId),
  })
  let mileageUnit: string | null = null
  let proposals: Proposals | null = null
  const propose = async (client: Tx): Promise<Proposals> => ({
    numbering: await proposeNumbering(client, scope.organizationId),
    ...(await proposeSettings(client, scope.organizationId, { mileageUnit })),
  })
  if (options.dryRun) {
    try {
      await db.$transaction(
        async (tx) => {
          lc.dryTx = tx as Tx
          ;({ mileageUnit } = await stages(lc))
          // Inside the transaction: the numbers it would have imported are still there.
          proposals = await propose(clientOf(lc))
          throw new DryRunDone()
        },
        { maxWait: 30_000, timeout: 60 * 60_000 }
      )
    } catch (err) {
      if (!(err instanceof DryRunDone)) throw err
    }
  } else {
    ;({ mileageUnit } = await stages(lc))
    // The staged copies of files that loaded: uploads has them now.
    await removePlaced(lc.placedFiles)
    proposals = await propose(clientOf(lc))
  }
  const proposed = proposals as unknown as Proposals
  const applied = options.dryRun
    ? []
    : await applySettingChanges(scope.organizationId, options.runUserId, [
        ...(options.applyNumbering ? proposed.numbering.changes : []),
        ...(options.applySettings ? proposed.settings : []),
      ])
  const issue = options.dryRun
    ? { issued: 0, failed: 0 }
    : await issueInvoices(scope.organizationId, lc.toIssue)
  if (!options.dryRun) {
    const records = Object.values(lc.counts).reduce((a, c) => a + c.created + c.updated, 0)
    await recordLoad(scope.organizationId, options.runUserId, {
      runId: scope.runId,
      records,
      counts: lc.counts,
      issued: issue.issued,
      applied,
    })
  }
  return {
    runId: scope.runId,
    dryRun: options.dryRun === true,
    counts: lc.counts,
    warnings: countWarnings(lc.warnings),
    failures: lc.failures,
    batches: options.dryRun ? {} : lc.batches,
    issued: issue.issued,
    mileageUnit,
    proposals: proposed,
    applied,
  }
}

/** For tests and the CLI: the staged tables a load reads, so a caller can tell an empty archive. */
export { stagedAll }
