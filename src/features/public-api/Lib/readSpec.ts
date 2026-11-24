/**
 * What a read resource publishes (docs/fork/milestones/A3-read-endpoints.md): its path, its response and filters,
 * what it may include, and the query schemas built from them. Pure, so the OpenAPI document (Lib/openapi.ts) and
 * the route handlers (Lib/readResource.ts) are made from the same declaration.
 */
import { z } from 'zod'
import { sourceSchema } from '../Schema/common'
import type { EndpointSpec } from './openapi'
import { pageQuerySchema } from './pagination'

export interface ReadSpec<Out> {
  /** Path under /api/v1, e.g. `/customers`. */
  path: string
  tag: string
  /** What the list and the get are about, for the OpenAPI summaries. */
  noun: { one: string; many: string }
  /** Filters beyond paging; merged with `limit`, `cursor`, `updatedSince` and `include`. */
  filters?: z.ZodObject
  /** What may be named in `?include=` (comma separated). */
  includes?: readonly string[]
  /**
   * fork (A5): the `IntegrationLink` entity type an imported row of this resource is linked by (`Customer`,
   * `ServiceRecord`, ...). It adds `source` to the includes: the archived record the row came from.
   */
  sourceModel?: string
  response: z.ZodType<Out>
}

/** Everything `?include=` may name: the resource's own, and `source` where its rows can be imported. */
export function allowedIncludes(spec: { includes?: readonly string[]; sourceModel?: string }) {
  return [...(spec.includes ?? []), ...(spec.sourceModel ? ['source'] : [])]
}

/** The response, with `source` where the resource has it (for the OpenAPI document). */
function responseOf(spec: ReadSpec<unknown>): z.ZodType {
  return spec.sourceModel && spec.response instanceof z.ZodObject
    ? spec.response.extend({ source: sourceSchema.optional() })
    : spec.response
}

/** `?include=a,b`, each one of `allowed`; an unknown one is a 400, not silently ignored. */
export function includeSchema(allowed: readonly string[]) {
  return z
    .string()
    .optional()
    .describe(allowed.length ? `Comma separated: ${allowed.join(', ')}` : 'Nothing to include')
    .transform((value, ctx) => {
      const asked = (value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      for (const name of asked) {
        if (!allowed.includes(name)) {
          ctx.addIssue({ code: 'custom', message: `Unknown include "${name}"` })
          return z.NEVER
        }
      }
      return new Set(asked) as ReadonlySet<string>
    })
}

/**
 * A list's query: paging, `include` and the resource's filters, and nothing else. A parameter it doesn't know is a
 * 400, like an unknown include: a misspelt or unsupported filter silently ignored would hand back the whole list.
 */
export function listQuerySchema(spec: {
  includes?: readonly string[]
  sourceModel?: string
  filters?: z.ZodObject
}) {
  const base = pageQuerySchema.extend({ include: includeSchema(allowedIncludes(spec)) })
  return (spec.filters ? base.extend(spec.filters.shape) : base).strict()
}

export const getQuerySchema = (allowed: readonly string[]) =>
  z.object({ include: includeSchema(allowed) }).strict()

/** The resource's two operations, for the OpenAPI document. */
export function readEndpoints(spec: ReadSpec<unknown>): EndpointSpec[] {
  return [
    {
      method: 'get',
      path: spec.path,
      summary: `List ${spec.noun.many}`,
      tag: spec.tag,
      query: listQuerySchema(spec) as unknown as z.ZodObject,
      response: responseOf(spec),
      paged: true,
    },
    {
      method: 'get',
      path: `${spec.path}/{id}`,
      summary: `Get one ${spec.noun.one}`,
      tag: spec.tag,
      query: getQuerySchema(allowedIncludes(spec)) as unknown as z.ZodObject,
      response: responseOf(spec),
    },
  ]
}
