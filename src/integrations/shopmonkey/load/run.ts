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
import { extractSettings } from '../extract/engine'
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
import { withLoadLock } from './lock'
import { recordSkips, saveLastLoad } from './outcome'
import {
  assertNoInvoiceListeners,
  connectionsHearingInvoices,
  issueInvoices,
  LoadRefused,
  recordLoad,
} from './finish'
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
import { type LoadScope, stampLinks } from './links'
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
  /**
   * The operator's stage per workflow status; the rest take the default (RESULTS S9). Unless given, the mapping saved
   * on the connection's import screen (M8, `state.mapping`), so every load (CLI, screen, sync) loads the same way.
   */
  statusStageMap?: Record<string, Stage>
  technicianMap?: Record<string, string | 'create'>
  now?: Date
  /** M7: a sync's load. When it writes nothing it records no audit event (a sync loads every ten minutes). */
  quiet?: boolean
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
  /** Imported invoices whose issue failed: still unlocked, tried again by the next run. */
  issueFailed: number
  /** Shopmonkey's unit system for mileage, from the oldest vehicle: proposed to the workshop. */
  mileageUnit: string | null
  /** What the load proposes to the workshop's numbering and settings (task 9). */
  proposals: Proposals
  /** The setting keys this run wrote, from the proposals the operator asked to apply. */
  applied: string[]
}

class DryRunDone extends Error {}

/** The mapping the operator saved on the import screen (M8): `state.mapping`. */
export interface SavedMapping {
  statusStageMap?: Record<string, Stage>
  technicianMap?: Record<string, string | 'create'>
}

export function savedMapping(state: unknown): SavedMapping {
  const mapping = (state as { mapping?: SavedMapping } | null)?.mapping
  return mapping && typeof mapping === 'object' ? mapping : {}
}

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

/**
 * A load. A real one holds the connection's load lock (M7: the sync's jobs, the CLI and the cutover never load at
 * once); `LoadBusy` when another holds it. A dry run writes nothing and needs no lock.
 */
export async function runLoad(options: LoadOptions): Promise<LoadSummary> {
  if (options.dryRun) return loadUnlocked(options)
  return withLoadLock(options.connectionId, () => loadUnlocked(options))
}

async function loadUnlocked(options: LoadOptions): Promise<LoadSummary> {
  const scope = {
    organizationId: options.organizationId,
    connectionId: options.connectionId,
    runId: randomUUID(),
  }
  // Links have no workshop column: the connection has to be this workshop's before its links decide anything.
  const connection = await db.integrationConnection.findFirst({
    where: {
      id: scope.connectionId,
      organizationId: scope.organizationId,
      connectorId: 'shopmonkey',
    },
    select: { id: true, settings: true, state: true },
  })
  if (!connection)
    throw new LoadRefused([], 'That is not a Shopmonkey connection of this workshop.')
  // M7: after cutover the workshop is the system of record: nothing from Shopmonkey overwrites it any more.
  if ((connection.state as { cutover?: unknown } | null)?.cutover) {
    throw new LoadRefused([], 'The import is cut over: nothing more is loaded from Shopmonkey.')
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
    ...(savedMapping(connection.state).statusStageMap ?? {}),
    ...(options.statusStageMap ?? {}),
  }
  const country = await db.appSetting.findFirst({
    where: {
      organizationId: scope.organizationId,
      key: SETTING_KEYS.WORKSHOP_DEFAULT_COUNTRY_CODE,
    },
    select: { value: true },
  })
  const warnRecreated: NonNullable<LoadScope['onRecreate']> = (table, model, remoteId) =>
    lc.warnings.push({
      code: 'row_recreated',
      table,
      remoteId,
      message: `Its ${model} was deleted in Torqvoice and is created again.`,
    })
  const warnOverwritten: NonNullable<LoadScope['onOverwrite']> = (table, model, remoteId) =>
    lc.warnings.push({
      code: 'local_edit_overwritten',
      table,
      remoteId,
      message: `Its ${model} was edited in Torqvoice since the last sync; Shopmonkey's change overwrote it.`,
    })
  const timeZone = options.timeZone ?? (await workshopTimeZone(scope.organizationId))
  const lc = createLoadContext({
    scope: { ...scope, onRecreate: warnRecreated, onOverwrite: warnOverwritten },
    runUserId: options.runUserId,
    resolver,
    timeZone,
    // The extract's own reading of the setting: an order it staged without children is one the load leaves out.
    historyFrom: extractSettings((connection.settings as Record<string, unknown>) ?? {}, timeZone)
      .historyFrom,
    countryCode: options.countryCode ?? (country?.value || 'US'),
    statusStageMap,
    technicianMap: options.technicianMap ?? savedMapping(connection.state).technicianMap,
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
    // Why each record left out was left out, for the reconciliation (M6).
    await recordSkips(lc)
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
  // Checked again before issuing: a run can take an hour, and a connection turned on meanwhile would hear every
  // imported invoice. Then nothing is issued; the next run issues them (every unissued import is offered).
  const listeners = options.dryRun ? [] : await connectionsHearingInvoices(scope.organizationId)
  if (listeners.length && lc.toIssue.length) {
    lc.warnings.push({
      code: 'issue_postponed',
      table: 'order',
      remoteId: '',
      message: `Not issued while ${listeners.join(', ')} is on: the next load issues them.`,
    })
  }
  const issue =
    options.dryRun || listeners.length
      ? { issued: 0, failed: 0, ids: [] }
      : await issueInvoices(scope.organizationId, lc.toIssue)
  if (!options.dryRun) {
    // M7: an invoice issued just now, after its order's unit, isn't an edit made in Torqvoice either.
    await stampLinks(db as unknown as Tx, scope, 'ServiceRecord', issue.ids)
    const records = Object.values(lc.counts).reduce((a, c) => a + c.created + c.updated, 0)
    if (!(options.quiet && records === 0))
      await recordLoad(scope.organizationId, options.runUserId, {
        connectionId: scope.connectionId,
        runId: scope.runId,
        records,
        counts: lc.counts,
        issued: issue.issued,
        issueFailed: issue.failed,
        applied,
      })
    await saveLastLoad(scope, lc, {
      runId: scope.runId,
      issued: issue.issued,
      issueFailed: issue.failed,
      now: options.now,
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
    issueFailed: issue.failed,
    mileageUnit,
    proposals: proposed,
    applied,
  }
}

/** For tests and the CLI: the staged tables a load reads, so a caller can tell an empty archive. */
export { stagedAll }
