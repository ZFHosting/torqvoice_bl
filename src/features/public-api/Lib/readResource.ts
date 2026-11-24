/**
 * The route handlers of one read resource (docs/fork/milestones/A3-read-endpoints.md), from its declaration in
 * `Resources/<resource>.ts`: what it publishes (`Schema/`, a `ReadSpec`) and how it reads and serializes
 * (`Serializers/`). Every resource reads the same way: scoped to the key's workshop on every query, lookups by id
 * included; paged over `(updatedAt, id)`; filtered by `updatedSince`; serialized field by field; an `ETag` on each
 * single record; and the READ permission of its subject. Another workshop's id answers exactly like an id that
 * doesn't exist: 404.
 */
import 'server-only'
import {
  hasPermission,
  PermissionAction,
  type PermissionInput,
  PermissionSubject,
} from '@/lib/permissions'
import { publicApiError, publicApiOk } from './errors'
import { etagFor } from './etag'
import { pageArgs, pageMeta } from './pagination'
import { allowedIncludes, getQuerySchema, listQuerySchema, type ReadSpec } from './readSpec'
import { type SerializeContext, serializeContext } from './serializeContext'
import { sourcesOf } from './sources.server'
import { type PublicApiContext, withPublicApi } from './withPublicApi'

type Where = Record<string, unknown>

export interface ReadResource<Row extends { id: string; updatedAt: Date }, Out>
  extends ReadSpec<Out> {
  permission: PermissionInput
  /** The workshop scope, on every query: `{ organizationId }`, or a relation where the model has no column. */
  scope: (organizationId: string) => Where
  /** Extra `where` from the parsed filters. */
  where?: (query: Record<string, unknown>) => Where
  /** The Prisma `select` for the includes asked for. Never everything. */
  select: (includes: ReadonlySet<string>) => Record<string, unknown>
  findMany: (args: {
    where: Where
    orderBy: unknown
    take: number
    select: Record<string, unknown>
  }) => Promise<Row[]>
  findFirst: (args: { where: Where; select: Record<string, unknown> }) => Promise<Row | null>
  /**
   * What an include needs from outside the row (custom field values, kept by entity id), read for the whole page
   * at once and handed to `serialize` by row id.
   */
  expand?: (
    rows: Row[],
    ctx: SerializeContext,
    includes: ReadonlySet<string>
  ) => Promise<Map<string, Record<string, unknown>>>
  serialize: (
    row: Row,
    ctx: SerializeContext,
    includes: ReadonlySet<string>,
    extra: Record<string, unknown>
  ) => Out
}

export function queryObject(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams)
}

async function serializeAll<Row extends { id: string; updatedAt: Date }, Out>(
  resource: ReadResource<Row, Out>,
  rows: Row[],
  ctx: SerializeContext,
  includes: ReadonlySet<string>
): Promise<Out[]> {
  const extras = resource.expand
    ? await resource.expand(rows, ctx, includes)
    : new Map<string, Record<string, unknown>>()
  const out = rows.map((row) => resource.serialize(row, ctx, includes, extras.get(row.id) ?? {}))
  // fork (A5): `include=source`, the archived record each imported row came from.
  if (!includes.has('source') || !resource.sourceModel) return out
  const sources = await sourcesOf(
    ctx.organizationId,
    resource.sourceModel,
    rows.map((r) => r.id)
  )
  // `sourceRecord`, not `source`: a time entry's and a shift's `source` already says where they came from.
  return out.map((o, i) => ({ ...o, sourceRecord: sources.get(rows[i].id) ?? null }) as Out)
}

/**
 * fork (A5): `include=source` hands out the source's raw payload, which can hold more than the resource shows (an
 * order's internal notes): the same `read:settings` as `/api/v1/source-records`.
 */
function sourceRefused(ctx: PublicApiContext, includes: ReadonlySet<string>) {
  if (!includes.has('source') || ctx.isAdmin) return null
  const may = hasPermission(ctx.permissions, {
    action: PermissionAction.READ,
    subject: PermissionSubject.SETTINGS,
  })
  return may
    ? null
    : publicApiError(403, 'forbidden', '`include=source` needs the settings read permission.')
}

export function listRoute<Row extends { id: string; updatedAt: Date }, Out>(
  resource: ReadResource<Row, Out>
) {
  const schema = listQuerySchema(resource)
  return (request: Request) =>
    withPublicApi(
      request,
      async (ctx: PublicApiContext) => {
        const query = schema.parse(queryObject(request)) as Record<string, unknown> & {
          include: ReadonlySet<string>
          limit: number
        }
        const refused = sourceRefused(ctx, query.include)
        if (refused) return refused
        const page = pageArgs(query as Parameters<typeof pageArgs>[0])
        const rows = await resource.findMany({
          where: {
            AND: [resource.scope(ctx.organizationId), page.where, resource.where?.(query) ?? {}],
          },
          orderBy: page.orderBy,
          take: page.take,
          select: resource.select(query.include),
        })
        const { rows: pageRows, meta } = pageMeta(rows, query.limit)
        const data = await serializeAll(
          resource,
          pageRows,
          await serializeContext(ctx.organizationId),
          query.include
        )
        return publicApiOk(data, { meta })
      },
      { requiredPermissions: [resource.permission] }
    )
}

export function getRoute<Row extends { id: string; updatedAt: Date }, Out>(
  resource: ReadResource<Row, Out>
) {
  const schema = getQuerySchema(allowedIncludes(resource))
  return (request: Request, { params }: { params: Promise<{ id: string }> }) =>
    withPublicApi(
      request,
      async (ctx: PublicApiContext) => {
        const { id } = await params
        const { include } = schema.parse(queryObject(request))
        const refused = sourceRefused(ctx, include)
        if (refused) return refused
        const row = await resource.findFirst({
          where: { AND: [resource.scope(ctx.organizationId), { id }] },
          select: resource.select(include),
        })
        // Another workshop's id answers exactly like an id that doesn't exist.
        if (!row) return publicApiError(404, 'not_found', 'Not found.')
        const [data] = await serializeAll(
          resource,
          [row],
          await serializeContext(ctx.organizationId),
          include
        )
        return publicApiOk(data, { headers: { ETag: etagFor(row) } })
      },
      { requiredPermissions: [resource.permission] }
    )
}

/** One record as its read endpoint serializes it, or null when it isn't the workshop's: what a write answers with. */
export async function readOne<Row extends { id: string; updatedAt: Date }, Out>(
  resource: ReadResource<Row, Out>,
  organizationId: string,
  id: string,
  includes: ReadonlySet<string> = new Set()
): Promise<{ data: Out; etag: string } | null> {
  const row = await resource.findFirst({
    where: { AND: [resource.scope(organizationId), { id }] },
    select: resource.select(includes),
  })
  if (!row) return null
  const [data] = await serializeAll(
    resource,
    [row],
    await serializeContext(organizationId),
    includes
  )
  return { data, etag: etagFor(row) }
}
