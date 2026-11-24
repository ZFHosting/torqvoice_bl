/**
 * The extractor (docs/fork/milestones/M3-extract-and-stage.md): one unit of work per call, either one
 * page of a table's list or one batch of parents' children, then the new state for the caller to save.
 * The job runner calls it again a second later; the CLI calls it in a loop. Everything it needs comes
 * in `deps`, so the jobs, the CLI and the tests drive the same code.
 *
 * Logs name tables, Shopmonkey ids, counts and statuses: never a name, an email, a phone number, a
 * file link (they may be signed) or a payload.
 */
import { parseWorkshopDateTime } from '@/lib/workshop-datetime'
import {
  assertReadOnly,
  type Envelope,
  PAGE_SIZE,
  type Page,
  PagingStalled,
  pageContinues,
  ReadOnlyViolation,
  SHOPMONKEY_BASE_URL,
  type ShopmonkeyClient,
  ShopmonkeyError,
  where,
} from '../client'
import { type FileStager, MAX_PDF_BYTES, type StagedFile, TransientDownloadError } from './files'
import {
  type ChildCounts,
  type ExtractState,
  newCheckpoint,
  type PlanStep,
  planFor,
  type StepCheckpoint,
  type StepCounts,
} from './plan'
import {
  type PendingParent,
  payloadHash,
  remoteIdOf,
  type SourceStore,
  type StagedRow,
} from './stage'
import { type ChildSpec, recordPath, TABLES, type TableSpec, tableSpec } from './tables'

type Row = Record<string, unknown>
type Log = (
  level: 'info' | 'warn' | 'error',
  message: string,
  details?: Record<string, unknown>
) => Promise<void> | void

/** The connection's settings that change what is fetched (manifest.ts). */
export interface ExtractSettings {
  locationId: string | null
  includeFiles: boolean
  downloadInvoicePdfs: 'none' | 'last2years' | 'all'
  /**
   * Orders created before it are staged, but their children aren't fetched. The setting is a date: the
   * instant here is that day's midnight on the workshop's clock (AGENTS.md, "Whose clock").
   */
  historyFrom: string | null
}

function workshopMidnight(value: unknown, timeZone: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return parseWorkshopDateTime(value, timeZone).toISOString()
  } catch {
    return null
  }
}

export function extractSettings(raw: Record<string, unknown>, timeZone = 'UTC'): ExtractSettings {
  const pdfs = raw.downloadInvoicePdfs
  return {
    locationId: typeof raw.locationId === 'string' && raw.locationId ? raw.locationId : null,
    includeFiles: raw.includeFiles !== false,
    downloadInvoicePdfs: pdfs === 'none' || pdfs === 'all' ? pdfs : 'last2years',
    historyFrom: workshopMidnight(raw.historyFrom, timeZone),
  }
}

export interface ExtractDeps {
  client: Pick<ShopmonkeyClient, 'get' | 'listPage' | 'searchPage' | 'download' | 'stats'>
  store: SourceStore
  files: FileStager
  settings: ExtractSettings
  /** The Shopmonkey company the connection belongs to (`externalAccountId`, from `identify`). */
  companyId: string | null
  log: Log
  now?: () => Date
}

export interface StepResult {
  state: ExtractState
  done: boolean
  /** One line for the job log or the CLI. */
  summary: string
}

/**
 * A children unit stops after this many API calls, or this long (downloads aren't calls), so one job run
 * stays well inside the queue's ten minutes before it thinks a job is stuck and runs it again.
 */
const CHILD_CALL_BUDGET = 25
const CHILD_UNIT_MS = 30_000
const PARENTS_PER_UNIT = 10
/** Bump when what a table's children are changes, so every parent's children are fetched again. */
const CHILDREN_VERSION = 1
const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const pathFor = (template: string, id: string) => template.replace(':id', encodeURIComponent(id))

function inLocation(row: Row, spec: TableSpec, locationId: string | null): boolean {
  if (!locationId || !spec.location) return true
  const value = row[spec.location]
  if (spec.location === 'locationIds') {
    return !Array.isArray(value) || value.length === 0 || value.includes(locationId)
  }
  return typeof value !== 'string' || value === locationId
}

function later(a: string | null, b: unknown): string | null {
  if (typeof b !== 'string') return a
  const time = new Date(b).getTime()
  if (Number.isNaN(time)) return a
  return a === null || time > new Date(a).getTime() ? new Date(time).toISOString() : a
}

function tally(counts: StepCounts, rows: StagedRow[]) {
  for (const row of rows) counts[row.result]++
}

/** What a table's children are under these settings; a different answer refetches them all. */
export function childSignature(spec: TableSpec, settings: ExtractSettings): string {
  const kinds = (spec.children ?? []).map((c) => `${c.kind}:${c.table}`)
  const hasFiles = (spec.children ?? []).some((c) => c.kind === 'files' || c.kind === 'itemFiles')
  const hasPdf = (spec.children ?? []).some((c) => c.kind === 'invoicePdf')
  return payloadHash({
    v: CHILDREN_VERSION,
    kinds,
    ...(hasFiles ? { files: settings.includeFiles } : {}),
    ...(hasPdf ? { pdfs: settings.downloadInvoicePdfs } : {}),
    ...(spec.table === 'order' ? { historyFrom: settings.historyFrom } : {}),
  }).slice(0, 16)
}

function invoiceWanted(order: Row, settings: ExtractSettings, now: Date): boolean {
  if (settings.downloadInvoicePdfs === 'none') return false
  // PROVISIONAL(M0:S4): an invoice is `status: Invoice` (or `invoiced`), dated by `invoicedDate`.
  if (order.status !== 'Invoice' && order.invoiced !== true) return false
  if (settings.downloadInvoicePdfs === 'all') return true
  const date = order.invoicedDate ?? order.completedDate ?? order.createdDate
  const time = typeof date === 'string' ? new Date(date).getTime() : Number.NaN
  return !Number.isNaN(time) && now.getTime() - time <= TWO_YEARS_MS
}

function beforeHistory(order: Row, settings: ExtractSettings): boolean {
  return createdBeforeHistory(order, settings.historyFrom)
}

/**
 * An order created before the connection's `historyFrom` (an instant: that day's workshop midnight): staged without
 * its children here, and left out of the load (M6). One rule, so the two never disagree on an order.
 */
export function createdBeforeHistory(order: Row, historyFrom: string | null): boolean {
  if (!historyFrom) return false
  const created = order.createdDate ?? order.orderCreatedDate
  const time = typeof created === 'string' ? new Date(created).getTime() : Number.NaN
  return !Number.isNaN(time) && time < new Date(historyFrom).getTime()
}

/** The children to fetch for this parent under these settings. */
function activeChildren(spec: TableSpec, parent: Row, settings: ExtractSettings, now: Date) {
  const old = spec.table === 'order' && beforeHistory(parent, settings)
  return (spec.children ?? []).filter((child) => {
    if (old && child.kind !== 'ref') return false
    if (child.kind === 'files' || child.kind === 'itemFiles') return settings.includeFiles
    if (child.kind === 'invoicePdf') return invoiceWanted(parent, settings, now)
    return true
  })
}

export async function extractStep(deps: ExtractDeps, input: ExtractState): Promise<StepResult> {
  const state: ExtractState = structuredClone(input)
  const now = deps.now ?? (() => new Date())
  const callsBefore = deps.client.stats.calls
  const plan = planFor(state.only)
  const result = (done: boolean, summary: string): StepResult => {
    state.calls += deps.client.stats.calls - callsBefore
    if (done) state.finishedAt ??= now().toISOString()
    return { state, done, summary }
  }

  while (state.step < plan.length) {
    const step = plan[state.step]
    const spec = tableSpec(step.table)
    state.steps[step.key] ??= newCheckpoint(
      state.since || state.sinceByTable ? 'delta' : 'backfill',
      spec,
      step.list
    )
    const cp = state.steps[step.key]

    if (cp.stage === 'list') {
      await listOnePage(deps, state, spec, cp)
      return result(
        false,
        `${step.key}: ${cp.skip} read${cp.total !== null ? ` of ${cp.total}` : ''}`
      )
    }
    if (cp.stage === 'children') {
      if (await childrenUnit(deps, state, spec, cp, now())) {
        return result(false, `${step.key}: children of ${cp.children.parents} fetched`)
      }
      cp.stage = 'done'
    }
    finishStep(state, step, cp)
    state.step++
  }
  return result(true, `done: ${state.calls + deps.client.stats.calls - callsBefore} calls`)
}

/**
 * Saves a unit's state; false when the run is no longer the connection's (a new start or the CLI
 * replaced it), and the run stops.
 */
export type SaveExtract = (state: ExtractState) => Promise<boolean | void>

/**
 * Units of work until the run is done, `budgetMs` has passed or another run replaced this one, saving
 * the state after each unit, so a job run (once a minute, from the cron) keeps close to Shopmonkey's
 * rate limit instead of doing one page a minute. Returns the last unit's result.
 */
export async function extractFor(
  deps: ExtractDeps,
  state: ExtractState,
  options: { budgetMs: number; save: SaveExtract; clock?: () => number }
): Promise<StepResult & { units: number; replaced: boolean }> {
  const clock = options.clock ?? Date.now
  const started = clock()
  let current = state
  for (let units = 1; ; units++) {
    const result = await extractStep(deps, current)
    if ((await options.save(result.state)) === false) return { ...result, units, replaced: true }
    current = result.state
    if (result.done || clock() - started >= options.budgetMs) {
      return { ...result, units, replaced: false }
    }
  }
}

function finishStep(state: ExtractState, step: PlanStep, cp: StepCheckpoint) {
  if (cp.highWatermark) {
    state.watermarks[step.table] = later(
      state.watermarks[step.table] ?? null,
      cp.highWatermark
    ) as string
  }
}

/** Where a table's delta starts: its own start (the polling backstop), else the run's. */
function sinceOf(state: ExtractState, table: string): string | null {
  return state.sinceByTable?.[table] ?? state.since
}

const timeOf = (value: unknown) =>
  typeof value === 'string' ? new Date(value).getTime() : Number.NaN

/** Whether rows are newest first by `updatedDate`, every one of them dated. */
function newestFirst(rows: Row[]): boolean {
  let previous = Number.POSITIVE_INFINITY
  for (const row of rows) {
    const time = timeOf(row.updatedDate)
    if (Number.isNaN(time) || time > previous) return false
    previous = time
  }
  return true
}

async function listOnePage(
  deps: ExtractDeps,
  state: ExtractState,
  spec: TableSpec,
  cp: StepCheckpoint
): Promise<void> {
  const list = spec.list
  const since = sinceOf(state, spec.table)
  // M7: a large GET list in a delta, newest first, so it can stop at the delta's start.
  const recent = !!since && list.kind === 'get' && spec.recentFirst === true
  if (list.kind === 'none') {
    cp.stage = 'children'
    return
  }
  if (list.kind === 'record') {
    if (deps.companyId) {
      const found = await deps.client.get<unknown>(pathFor(list.path, deps.companyId))
      if (isRow(found.data))
        tally(cp.counts, await deps.store.stage(spec.table, [{ payload: found.data }]))
    } else {
      cp.skippedReason = 'no_company'
    }
    cp.stage = spec.children?.length ? 'children' : 'done'
    return
  }
  let page: Page<unknown>
  try {
    page =
      list.kind === 'search'
        ? await deps.client.searchPage(
            list.path,
            cp.skip,
            since && spec.updatedFilter ? { where: where.updatedSince(since) } : {}
          )
        : await deps.client.listPage(
            list.path,
            cp.skip,
            recent ? { orderby: 'updatedDate desc' } : {}
          )
  } catch (err) {
    if (spec.optional && cp.skip === 0 && err instanceof ShopmonkeyError && err.status === 404) {
      cp.stage = 'done'
      cp.skippedReason = 'not_found'
      await deps.log('warn', `Shopmonkey has no ${spec.table} list; skipped`, {
        table: spec.table,
        status: 404,
        requestId: err.requestId,
      })
      return
    }
    throw err
  }
  if (cp.skip === 0) cp.total = page.total
  const rows = page.rows.filter(isRow)
  const pageKey = rows.length
    ? `${remoteIdOf(spec.table, rows[0])}:${remoteIdOf(spec.table, rows[rows.length - 1])}`
    : null
  // PROVISIONAL(M0:S2): a full page identical to the last one is a skip the server ignores.
  if (rows.length >= PAGE_SIZE && pageKey && pageKey === cp.lastPage) {
    throw new PagingStalled(list.path, cp.skip)
  }
  const kept = rows.filter((row) => inLocation(row, spec, deps.settings.locationId))
  cp.counts.skipped += rows.length - kept.length
  tally(
    cp.counts,
    await deps.store.stage(
      spec.table,
      kept.map((payload) => ({ payload }))
    )
  )
  for (const row of kept) cp.highWatermark = later(cp.highWatermark, row.updatedDate)
  cp.skip += page.rows.length
  if (rows.length >= PAGE_SIZE) cp.lastPage = pageKey
  // M7: newest first and past the delta's start: the rest of the list is older still.
  let reachedStart = false
  if (recent && !cp.unordered && rows.length) {
    if (!newestFirst(rows)) {
      cp.unordered = true
      await deps.log('warn', `Shopmonkey's ${spec.table} list isn't newest first; read whole`, {
        table: spec.table,
      })
    } else {
      reachedStart = timeOf(rows[rows.length - 1].updatedDate) < timeOf(since)
    }
  }
  if (!page.more || reachedStart) cp.stage = spec.children?.length ? 'children' : 'done'
}

/** What a refetch of one record did (M7). */
export interface RefetchResult {
  /**
   * `staged`: read and staged, with its children; `gone`: Shopmonkey has no such record (marked deleted, if it was
   * staged); `elsewhere`: another location's, left out; `not_read`: a table no record is read from by id.
   */
  outcome: 'staged' | 'gone' | 'elsewhere' | 'not_read'
  counts: StepCounts
  children: ChildCounts
}

/**
 * M7: one record read again by its id (a webhook said it changed), staged, and its children read again whatever its
 * own hash says: a webhook may be about a child alone (a service on an order). Children that no longer come back are
 * marked deleted, as a delta's sweep marks them. A 404 marks the record itself deleted.
 */
export async function refetchRecord(
  deps: ExtractDeps,
  table: string,
  remoteId: string
): Promise<RefetchResult> {
  const now = (deps.now ?? (() => new Date()))()
  const spec = TABLES.find((t) => t.table === table)
  const path = recordPath(table)
  const cp = newCheckpoint('delta', spec ?? tableSpec('order'), false)
  const result = (outcome: RefetchResult['outcome']): RefetchResult => ({
    outcome,
    counts: cp.counts,
    children: cp.children,
  })
  if (!spec || !path) return result('not_read')
  let found: Envelope<unknown>
  try {
    found = await deps.client.get<unknown>(pathFor(path, remoteId))
  } catch (err) {
    if (err instanceof ShopmonkeyError && err.status === 404) {
      await deps.store.markDeleted(table, remoteId, now)
      return result('gone')
    }
    throw err
  }
  if (!isRow(found.data)) return result('gone')
  const payload = found.data
  if (!inLocation(payload, spec, deps.settings.locationId)) return result('elsewhere')
  const before = (await deps.store.hashes(table, [remoteId])).get(remoteId) ?? null
  const staged = await deps.store.stage(table, [{ payload }])
  tally(cp.counts, staged)
  if (spec.children?.length && staged.length) {
    const parent: PendingParent = {
      id: '',
      remoteId,
      payload,
      payloadHash: staged[0].hash,
      // Staged before: its children were read before too, so one that's gone is marked.
      childrenHash: before,
    }
    if (await fetchChildren(deps, spec, parent, cp, now)) {
      await deps.store.markChildrenFetched(table, remoteId, staged[0].hash)
    }
  }
  return result('staged')
}

/** One batch of parents' children. False when no parent is waiting. */
async function childrenUnit(
  deps: ExtractDeps,
  state: ExtractState,
  spec: TableSpec,
  cp: StepCheckpoint,
  now: Date
): Promise<boolean> {
  if (!spec.children?.length) return false
  const signature = childSignature(spec, deps.settings)
  const before = state.childSignatures[spec.table]
  if (before !== undefined && before !== signature) {
    // The settings changed what this table's children are: fetch them again for every parent.
    await deps.store.resetChildren(spec.table)
    cp.cursor = null
  }
  state.childSignatures[spec.table] = signature

  const parents = await deps.store.pendingChildren(spec.table, cp.cursor, PARENTS_PER_UNIT)
  if (parents.length === 0) return false
  const started = deps.client.stats.calls
  const startedAt = Date.now()
  for (const parent of parents) {
    // A file that failed for now leaves the parent pending: the next run fetches its children again.
    if (await fetchChildren(deps, spec, parent, cp, now)) {
      await deps.store.markChildrenFetched(spec.table, parent.remoteId, parent.payloadHash)
    } else {
      cp.children.retry++
    }
    cp.cursor = parent.id
    cp.children.parents++
    if (deps.client.stats.calls - started >= CHILD_CALL_BUDGET) break
    if (Date.now() - startedAt >= CHILD_UNIT_MS) break
  }
  return true
}

async function fetchChildren(
  deps: ExtractDeps,
  spec: TableSpec,
  parent: PendingParent,
  cp: StepCheckpoint,
  now: Date
): Promise<boolean> {
  const payload = isRow(parent.payload) ? parent.payload : {}
  let complete = true
  for (const child of activeChildren(spec, payload, deps.settings, now)) {
    try {
      if ((await fetchChild(deps, spec, parent, payload, child, cp, now)) === false)
        complete = false
    } catch (err) {
      // A child Shopmonkey no longer has (a deleted order's services): noted, and the parent goes on.
      if (err instanceof ShopmonkeyError && err.status === 404) {
        cp.children.missing++
        await deps.log('warn', `No ${child.table} for ${spec.table} ${parent.remoteId}`, {
          table: child.table,
          parentTable: spec.table,
          parentId: parent.remoteId,
          status: 404,
          requestId: err.requestId,
        })
        continue
      }
      throw err
    }
  }
  return complete
}

async function fetchChild(
  deps: ExtractDeps,
  spec: TableSpec,
  parent: PendingParent,
  payload: Row,
  child: ChildSpec,
  cp: StepCheckpoint,
  now: Date
): Promise<boolean | void> {
  const id = parent.remoteId
  // Children that went missing are marked only on a refetch: a parent's first fetch has none to lose,
  // and skipping it keeps a backfill from scanning the child table once per parent.
  const refetch = parent.childrenHash !== null
  switch (child.kind) {
    case 'list': {
      const rows = await childList(deps, pathFor(child.path, id))
      tally(
        cp.children,
        await deps.store.stage(
          child.table,
          rows.map((row) => ({ payload: row }))
        )
      )
      if (child.parentField && refetch) {
        await markGone(deps, cp, child.table, [child.parentField], id, rows, now)
      }
      return
    }
    case 'search': {
      const rows = await childSearch(deps, child.path, child.parentField, id)
      tally(
        cp.children,
        await deps.store.stage(
          child.table,
          rows.map((row) => ({ payload: row }))
        )
      )
      if (refetch) await markGone(deps, cp, child.table, [child.parentField], id, rows, now)
      return
    }
    case 'files':
    case 'itemFiles': {
      // PROVISIONAL(M0:S4): files are `files[]` on Find Order and `items[].files[]` on the inspection.
      // Read fresh at download time: the staged parent's links may be signed and hours old.
      const detail = await deps.client.get<Row>(pathFor(child.detailPath, id))
      const fresh = isRow(detail.data) ? detail.data : {}
      const owner = { table: spec.table, remoteId: id }
      const found: { entry: Row; owner: Row & { remoteId: string } }[] = []
      if (child.kind === 'files') {
        for (const entry of rowsOf(fresh.files)) found.push({ entry, owner })
      } else {
        for (const item of rowsOf(fresh.items)) {
          for (const entry of rowsOf(item.files))
            found.push({ entry, owner: { ...owner, itemId: item.id ?? null } })
        }
      }
      let complete = true
      for (const { entry, owner: of } of found) {
        if (!(await stageFile(deps, cp, child.table, entry, of))) complete = false
      }
      if (refetch) {
        const kept = found.map((f) => f.entry)
        await markGone(deps, cp, child.table, ['_parent', 'remoteId'], id, kept, now)
      }
      return complete
    }
    case 'invoicePdf': {
      const file = await downloadOrRetry(deps, child.table, id, () =>
        deps.client.download(
          pathFor(child.path, id),
          { document_type: 'invoice' }, // PROVISIONAL(M0:S4): required, one of invoice, estimate, ...
          { maxBytes: MAX_PDF_BYTES, accept: 'application/pdf' }
        )
      )
      if (file === 'retry') return false
      const staged =
        file === 'refused'
          ? ({ skipped: 'refused_url' } as const)
          : await deps.files.write(child.table, id, file.bytes, file.contentType)
      if ('skipped' in staged) cp.children.skipped++
      const record = { id, orderId: id, documentType: 'invoice', _staged: staged }
      // A new PDF whenever the order changes; the bytes themselves differ per render.
      const hash = payloadHash({ id, documentType: 'invoice', order: parent.payloadHash })
      tally(cp.children, await deps.store.stage(child.table, [{ payload: record, hash }]))
      return
    }
    case 'ref': {
      const refId = payload[child.field]
      if (typeof refId !== 'string' || !refId) return
      if ((await deps.store.hashes(child.table, [refId])).has(refId)) return
      const found = await deps.client.get<Row>(pathFor(child.path, refId))
      if (isRow(found.data))
        tally(cp.children, await deps.store.stage(child.table, [{ payload: found.data }]))
      return
    }
  }
}

async function markGone(
  deps: ExtractDeps,
  cp: StepCheckpoint,
  table: string,
  parentPath: string[],
  parentId: string,
  kept: Row[],
  now: Date
) {
  const keep = kept.map((row) => remoteIdOf(table, row))
  cp.children.gone += await deps.store.markGone(table, parentPath, parentId, keep, now)
}

/** A child GET, every page. PROVISIONAL(M0:S2): sub-resources page like lists; one record is one row. */
async function childList(deps: ExtractDeps, path: string): Promise<Row[]> {
  const out: Row[] = []
  const seen = new Set<string>()
  for (let skip = 0; ; ) {
    const envelope: Envelope<unknown> = await deps.client.get<unknown>(path, {
      orderby: 'id asc',
      limit: PAGE_SIZE,
      skip,
    })
    if (!Array.isArray(envelope.data)) {
      if (isRow(envelope.data)) out.push(envelope.data)
      return out
    }
    const fresh = envelope.data.filter(isRow).filter((row) => !seen.has(String(row.id)))
    for (const row of fresh) seen.add(String(row.id))
    out.push(...fresh)
    if (!pageContinues(envelope.data.length, envelope.meta)) return out
    if (fresh.length === 0) throw new PagingStalled(path, skip)
    skip += envelope.data.length
  }
}

/**
 * A search for one parent's children. Rows that aren't the parent's are left out: a search that ignored
 * its `where` would otherwise file every payment under every order.
 */
async function childSearch(
  deps: ExtractDeps,
  path: string,
  parentField: string,
  parentId: string
): Promise<Row[]> {
  const out: Row[] = []
  const seen = new Set<string>()
  for (let skip = 0; ; ) {
    const page = await deps.client.searchPage<unknown>(path, skip, {
      where: where.equals(parentField, parentId),
    })
    const fresh = page.rows.filter(isRow).filter((row) => !seen.has(String(row.id)))
    for (const row of fresh) seen.add(String(row.id))
    out.push(...fresh.filter((row) => row[parentField] === parentId))
    if (!page.more) return out
    if (fresh.length === 0) throw new PagingStalled(path, skip)
    skip += page.rows.length
  }
}

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRow) : [])

/**
 * A download through the client. `retry` when it failed for now (a 5xx, a timeout, a dropped
 * connection): logged by ids, and the parent stays pending for the next run. `refused` when Shopmonkey
 * answered a redirect or a 4xx that waiting won't change. A 404 and a rate limit go on up: the first is
 * noted as missing, the second reschedules the job.
 */
async function downloadOrRetry<T>(
  deps: ExtractDeps,
  table: string,
  remoteId: string,
  fetch: () => Promise<T>
): Promise<T | 'retry' | 'refused'> {
  try {
    return await fetch()
  } catch (err) {
    if (err instanceof ShopmonkeyError && (err.status === 404 || err.status === 429)) throw err
    if (err instanceof ReadOnlyViolation) throw err
    const status = err instanceof ShopmonkeyError ? err.status : null
    await deps.log('warn', `Could not download ${table} ${remoteId}`, {
      table,
      remoteId,
      ...(err instanceof ShopmonkeyError ? { status, requestId: err.requestId } : {}),
      error: err instanceof Error ? err.name : 'Error',
    })
    return status !== null && status < 500 ? 'refused' : 'retry'
  }
}

/**
 * One file: staged with its owner and where its bytes are, or why it couldn't be (too large, a type the
 * app doesn't take, a link refused or gone). Its hash leaves out the links, which may be signed and
 * change on every read (PROVISIONAL(M0:S4)), so an unchanged file isn't downloaded again. False when the
 * download failed for now: nothing is staged, so the next run tries again.
 */
async function stageFile(
  deps: ExtractDeps,
  cp: StepCheckpoint,
  table: string,
  entry: Row,
  owner: Row & { remoteId: string }
): Promise<boolean> {
  const fileId = remoteIdOf(table, entry)
  const { url, thumbnailUrl: _thumbnail, ...stable } = entry
  const hash = payloadHash({ entry: stable, owner })
  if ((await deps.store.hashes(table, [fileId])).get(fileId) === hash) {
    cp.children.unchanged++
    return true
  }
  let staged: StagedFile | null
  if (typeof url !== 'string' || !url) {
    staged = { skipped: 'not_found' }
  } else if (url.startsWith(`${SHOPMONKEY_BASE_URL}/`)) {
    // On Shopmonkey's API itself: through the read-only client, with the key, read into memory (capped).
    const link = new URL(url)
    try {
      assertReadOnly('GET', link.pathname)
      const file = await downloadOrRetry(deps, table, fileId, () =>
        deps.client.download(link.pathname, Object.fromEntries(link.searchParams), {
          maxBytes: MAX_PDF_BYTES,
        })
      )
      staged =
        file === 'retry'
          ? null
          : file === 'refused'
            ? { skipped: 'refused_url' }
            : await deps.files.write(table, fileId, file.bytes, file.contentType)
    } catch (err) {
      if (!(err instanceof ReadOnlyViolation)) throw err
      staged = { skipped: 'refused_url' }
    }
  } else {
    try {
      staged = await deps.files.fetchUrl(table, fileId, url)
    } catch (err) {
      if (!(err instanceof TransientDownloadError)) throw err
      await deps.log('warn', `Could not download ${table} ${fileId} for now`, {
        table,
        remoteId: fileId,
        error: err.reason,
      })
      staged = null
    }
  }
  if (!staged) return false
  if ('skipped' in staged) cp.children.skipped++
  const record = { ...entry, _parent: owner, _staged: staged }
  tally(cp.children, await deps.store.stage(table, [{ payload: record, hash }]))
  return true
}
