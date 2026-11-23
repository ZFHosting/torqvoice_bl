/**
 * The OpenAPI entries of a resource's writes (docs/fork/milestones/A4-write-endpoints.md): the request bodies are
 * the services' own zod schemas, the responses the read schema (A3). Pure, like `readSpec.ts`.
 */
import { z } from 'zod'
import type { EndpointSpec } from './openapi'

export const deletedSchema = z
  .object({ id: z.string(), deleted: z.literal(true) })
  .meta({ id: 'Deleted' })

/**
 * A work order's or a quote's body as the API takes it: without the totals it works out from the lines
 * (`Writes/documentBody.ts`), which it refuses.
 */
export function documentBodySchema(schema: z.ZodObject): z.ZodObject {
  const computed = ['subtotal', 'taxAmount', 'totalAmount', 'taxableSubtotal', 'discountAmount']
  const present = Object.fromEntries(
    computed.filter((k) => k in schema.shape).map((k) => [k, true])
  )
  return schema.omit(present as never)
}

/** A PATCH body: the update schema without `id` (it comes from the path), every field optional. */
export function patchBody(schema: z.ZodObject): z.ZodType {
  return schema.omit({ id: true } as never).partial()
}

export function writeEndpoints(spec: {
  path: string
  tag: string
  noun: { one: string; many: string }
  response: z.ZodType
  create?: z.ZodType
  update?: z.ZodType
  remove?: boolean
}): EndpointSpec[] {
  const out: EndpointSpec[] = []
  if (spec.create) {
    out.push({
      method: 'post',
      path: spec.path,
      summary: `Create a ${spec.noun.one}`,
      tag: spec.tag,
      body: spec.create,
      response: spec.response,
      status: 201,
    })
  }
  if (spec.update) {
    out.push({
      method: 'patch',
      path: `${spec.path}/{id}`,
      summary: `Change a ${spec.noun.one} (only the fields sent)`,
      tag: spec.tag,
      body: spec.update,
      response: spec.response,
    })
  }
  if (spec.remove) {
    out.push({
      method: 'delete',
      path: `${spec.path}/{id}`,
      summary: `Delete a ${spec.noun.one}`,
      tag: spec.tag,
      response: deletedSchema,
    })
  }
  return out
}
