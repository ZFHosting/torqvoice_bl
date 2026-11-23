/**
 * A load run (M5): every staged table written into the workshop in the plan's order, each record (each order with
 * everything on it) in its own transaction. A dry run does all of it inside one transaction (a savepoint per record)
 * and rolls it back, so it reports exactly what a real run would change and keeps nothing.
 */
import { randomUUID } from 'node:crypto'
import type { Stage } from '@/features/work-order-statuses/Lib/stages'
import { db } from '@/lib/db'
import { defaultStages } from '../transform/staff'
import type { Warning } from '../transform/types'
import {
  type Counts,
  closeBatches,
  createLoadContext,
  type LoadContext,
  openBatches,
  type Tx,
} from './context'
import { loadInventory, loadPresets } from './catalog'
import { removePlaced } from './files'
import { loadAppointments, loadInspections, loadInspectionTemplates, loadTime } from './history'
import { loadOrders } from './orders'
import {
  loadCustomers,
  loadTechnicians,
  loadVehicles,
  loadWorkflowStatuses,
  stagedAll,
} from './people'
import { loadResolver } from './resolver'

export interface LoadOptions {
  organizationId: string
  connectionId: string
  /** The member running the import: `userId` on created customers, vehicles, quotes, inventory. */
  runUserId: string
  dryRun?: boolean
  timeZone?: string
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
  const resolver = await loadResolver(scope)
  const statuses = await db.sourceRecord.findMany({
    where: { organizationId: scope.organizationId, source: 'shopmonkey', table: 'workflow_status' },
    select: { payload: true },
  })
  const statusStageMap: Record<string, Stage> = {
    ...Object.fromEntries(defaultStages(statuses.map((s) => s.payload as Record<string, unknown>))),
    ...(options.statusStageMap ?? {}),
  }
  const lc = createLoadContext({
    scope,
    runUserId: options.runUserId,
    resolver,
    timeZone: options.timeZone ?? 'UTC',
    countryCode: options.countryCode ?? 'US',
    statusStageMap,
    technicianMap: options.technicianMap,
    now: options.now,
  })
  let mileageUnit: string | null = null
  if (options.dryRun) {
    try {
      await db.$transaction(
        async (tx) => {
          lc.dryTx = tx as Tx
          ;({ mileageUnit } = await stages(lc))
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
  }
  return {
    runId: scope.runId,
    dryRun: options.dryRun === true,
    counts: lc.counts,
    warnings: countWarnings(lc.warnings),
    failures: lc.failures,
    batches: options.dryRun ? {} : lc.batches,
    issued: 0,
    mileageUnit,
  }
}

/** For tests and the CLI: the staged tables a load reads, so a caller can tell an empty archive. */
export { stagedAll }
