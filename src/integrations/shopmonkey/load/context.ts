/**
 * One load run's shared state (M5): the scope, the resolver the transforms read, the counts and warnings for the
 * summary, the run's import batches, and how a unit of work runs: in its own transaction, or (a dry run) inside one
 * outer transaction under a savepoint, so later stages still see what earlier ones made and nothing is kept.
 */
import type { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import type { Stage } from '@/features/work-order-statuses/Lib/stages'
import type { TransformContext, Warning } from '../transform/types'
import type { LoadScope } from './links'
import type { Resolver } from './resolver'

export type Tx = Prisma.TransactionClient

export interface Counts {
  created: number
  updated: number
  unchanged: number
  skipped: number
  failed: number
}

export interface LoadContext {
  scope: LoadScope
  runUserId: string
  resolver: Resolver
  transform: TransformContext
  counts: Record<string, Counts>
  warnings: Warning[]
  /** Records that failed to load, by table and id, with the error's name: never its message (it may quote data). */
  failures: { table: string; remoteId: string; error: string }[]
  /** ImportBatch ids of this run, by entity, created on first use. */
  batches: Partial<Record<'customers' | 'vehicles' | 'services' | 'inspections', string>>
  /** Invoiced work orders to issue once committed (MAPPING §6.1). */
  toIssue: string[]
  /** Staged copies of files that loaded, removed when the run is over. */
  placedFiles: string[]
  /** Set during a dry run: every unit runs in it, under a savepoint. */
  dryTx: Tx | null
  now: Date
  /** The importer's own words, in the workshop's language (`labels.ts`); anything else unchanged. */
  label: Labeler
}

export type Labeler = (english: string, values?: Record<string, string>) => string

/** Where reads and writes outside a unit go: the dry run's transaction, or the database. */
export function clientOf(lc: LoadContext): Tx {
  return lc.dryTx ?? (db as unknown as Tx)
}

export function newCounts(): Counts {
  return { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
}

export function countsFor(lc: LoadContext, table: string): Counts {
  lc.counts[table] ??= newCounts()
  return lc.counts[table]
}

export function createLoadContext(input: {
  scope: LoadScope
  runUserId: string
  resolver: Resolver
  timeZone: string
  countryCode: string
  statusStageMap: Record<string, Stage>
  technicianMap?: Record<string, string | 'create'>
  now?: Date
  label?: Labeler
}): LoadContext {
  return {
    scope: input.scope,
    runUserId: input.runUserId,
    resolver: input.resolver,
    transform: {
      organizationId: input.scope.organizationId,
      runUserId: input.runUserId,
      timeZone: input.timeZone,
      countryCode: input.countryCode,
      resolve: (table, remoteId) => input.resolver.resolve(table, remoteId),
      settings: { statusStageMap: input.statusStageMap, technicianMap: input.technicianMap ?? {} },
    },
    counts: {},
    warnings: [],
    failures: [],
    batches: {},
    toIssue: [],
    placedFiles: [],
    dryTx: null,
    now: input.now ?? new Date(),
    label: input.label ?? ((english) => english),
  }
}

/**
 * One unit of work (a customer, an order with everything on it): its own transaction, so a failure rolls back that
 * record alone and the run carries on. In a dry run, a savepoint in the outer transaction instead.
 */
export async function unit<T>(lc: LoadContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const dry = lc.dryTx
  if (!dry) {
    return db.$transaction((tx) => fn(tx as Tx), {
      maxWait: 30_000,
      timeout: 120_000,
    }) as Promise<T>
  }
  await dry.$executeRawUnsafe('SAVEPOINT shopmonkey_unit')
  try {
    const out = await fn(dry)
    await dry.$executeRawUnsafe('RELEASE SAVEPOINT shopmonkey_unit')
    return out
  } catch (err) {
    await dry.$executeRawUnsafe('ROLLBACK TO SAVEPOINT shopmonkey_unit')
    throw err
  }
}

/**
 * Runs a unit for one record, counting what happened, and noting a failure without stopping the run. True when it
 * committed (or, in a dry run, its savepoint was kept).
 */
export async function loadOne(
  lc: LoadContext,
  table: string,
  remoteId: string,
  fn: (tx: Tx) => Promise<'created' | 'updated' | 'unchanged' | 'skipped'>
): Promise<boolean> {
  const counts = countsFor(lc, table)
  try {
    counts[await unit(lc, fn)]++
    return true
  } catch (err) {
    counts.failed++
    lc.failures.push({ table, remoteId, error: err instanceof Error ? err.name : 'Error' })
    return false
  }
}

export const BATCH_ENTITIES = ['customers', 'vehicles', 'services', 'inspections'] as const

/**
 * The run's import batches (one per entity, `source: shopmonkey`), opened before any unit: a batch created inside a
 * unit that then rolled back would leave later rows pointing at nothing. Created rows carry their batch, which is
 * what undo follows (MAPPING, M5 task 3).
 */
export async function openBatches(lc: LoadContext): Promise<void> {
  const client = clientOf(lc)
  for (const entity of BATCH_ENTITIES) {
    const batch = await client.importBatch.create({
      data: {
        organizationId: lc.scope.organizationId,
        userId: lc.runUserId,
        source: 'shopmonkey',
        entity,
        // What Settings → Data lists; the run it belongs to is in `mapping`, which undo looks it up by.
        fileName: lc.label('Shopmonkey import'),
        mapping: { shopmonkeyRunId: lc.scope.runId },
      },
      select: { id: true },
    })
    lc.batches[entity] = batch.id
  }
}

/** Each batch's counts, and the batches nothing was created in removed. */
export async function closeBatches(
  lc: LoadContext,
  created: Partial<Record<(typeof BATCH_ENTITIES)[number], number>>
): Promise<void> {
  const client = clientOf(lc)
  for (const entity of BATCH_ENTITIES) {
    const id = lc.batches[entity]
    if (!id) continue
    const count = created[entity] ?? 0
    if (count === 0) {
      await client.importBatch.deleteMany({
        where: { id, organizationId: lc.scope.organizationId },
      })
      delete lc.batches[entity]
    } else {
      await client.importBatch.updateMany({
        where: { id, organizationId: lc.scope.organizationId },
        data: { created: count, totalRows: count },
      })
    }
  }
}
