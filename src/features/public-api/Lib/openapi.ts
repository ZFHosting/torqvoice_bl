/**
 * The OpenAPI 3.1 document for the public API (docs/fork/API.md §1.4), generated from the same zod
 * schemas that validate and shape every request and response, and served unauthenticated at
 * `GET /api/v1/openapi.json`.
 *
 * Each resource's schema file (`Schema/<resource>.ts`) exports its operations as `EndpointSpec`s, and
 * RESOURCES below lists them. A test checks the document is valid OpenAPI and that every route
 * under src/app/api/v1 served by withPublicApi is in it.
 */
import { z } from 'zod'
import { catalogEndpoints } from '../Schema/catalog'
import { customerEndpoints } from '../Schema/customers'
import { inspectionEndpoints } from '../Schema/inspections'
import { quoteEndpoints } from '../Schema/quotes'
import { recordEndpoints } from '../Schema/records'
import { scheduleEndpoints } from '../Schema/schedule'
import { settingsEndpoints } from '../Schema/settings'
import { staffEndpoints } from '../Schema/staff'
import { vehicleEndpoints } from '../Schema/vehicles'
import { workOrderEndpoints } from '../Schema/workOrders'

export interface EndpointSpec {
  method: 'get' | 'post' | 'patch' | 'delete'
  /** OpenAPI path under /api/v1, `{id}` style. */
  path: string
  summary: string
  tag: string
  /** Query parameters, as one zod object. */
  query?: z.ZodObject
  body?: z.ZodType
  /** The `data` of the success response. */
  response: z.ZodType
  /** Lists answer with `meta.nextCursor` and `meta.hasMore`. */
  paged?: boolean
  /** Success status; 200 unless set. */
  status?: number
  /** A success body that isn't the JSON envelope (a file download): its media type, the body a binary string. */
  contentType?: string
}

/** Every resource's operations. A new resource adds its list here. */
export const RESOURCES: readonly EndpointSpec[][] = [
  settingsEndpoints,
  customerEndpoints,
  vehicleEndpoints,
  workOrderEndpoints,
  quoteEndpoints,
  inspectionEndpoints,
  staffEndpoints,
  catalogEndpoints,
  scheduleEndpoints,
  recordEndpoints,
]

/** Every refusal's body (src/features/public-api/Lib/errors.ts); `components.schemas.Error`. */
const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})

const pageMetaSchema = z
  .object({ hasMore: z.boolean(), nextCursor: z.string().nullable() })
  .meta({ id: 'PageMeta' })

const ERRORS: Record<string, string> = {
  '400': 'The request was not valid',
  '401': 'The API key is missing, not valid, revoked or expired',
  '403': 'The key may not do this, or not from this address',
  '404': 'Not found in this workshop',
  '409': 'Conflict: a locked document, a restore in progress or a reused Idempotency-Key',
  '412': 'If-Match did not match the current version',
  '429': 'Rate limited; see Retry-After',
}

export function buildOpenApiDocument(endpoints: readonly EndpointSpec[]) {
  const schemas: Record<string, unknown> = {}
  /**
   * JSON Schema for one zod schema. Zod puts every schema with a `.meta({ id })` under `$defs` and
   * points at it with `#/$defs/<id>`; those move to `components.schemas`, and the pointers with
   * them. OpenAPI 3.1 takes JSON Schema 2020-12, zod's own dialect, as it is.
   */
  const toSchema = (schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> => {
    const generated = z.toJSONSchema(schema, { io, unrepresentable: 'any' })
    const rewritten = JSON.parse(
      JSON.stringify(generated).replaceAll('"#/$defs/', '"#/components/schemas/')
    ) as Record<string, unknown> & { $defs?: Record<string, unknown> }
    const { $defs, $schema: _dialect, ...rest } = rewritten
    if ($defs) Object.assign(schemas, $defs)
    return rest
  }

  schemas.Error = toSchema(errorSchema, 'output')

  const paths: Record<string, Record<string, unknown>> = {}
  for (const e of endpoints) {
    const success = e.paged
      ? z.object({ data: z.array(e.response), meta: pageMetaSchema })
      : z.object({ data: e.response })
    const parameters = [
      ...[...e.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...Object.entries((e.query?.shape ?? {}) as Record<string, z.ZodType>).map(
        ([name, schema]) => ({
          name,
          in: 'query',
          required: !schema.safeParse(undefined).success,
          schema: toSchema(schema, 'input'),
        })
      ),
    ]
    paths[e.path] ??= {}
    paths[e.path][e.method] = {
      operationId: `${e.method}${e.path.replace(/\{(\w+)\}/g, 'By-$1').replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string) => (c ? c.toUpperCase() : ''))}`,
      summary: e.summary,
      tags: [e.tag],
      security: [{ apiKey: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(e.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toSchema(e.body, 'input') } },
            },
          }
        : {}),
      responses: {
        [String(e.status ?? 200)]: {
          description: 'Success',
          content: e.contentType
            ? { [e.contentType]: { schema: { type: 'string', format: 'binary' } } }
            : { 'application/json': { schema: toSchema(success, 'output') } },
        },
        ...Object.fromEntries(
          Object.entries(ERRORS).map(([status, description]) => [
            status,
            {
              description,
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Error' } },
              },
            },
          ])
        ),
      },
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Torqvoice public API',
      version: '1.0.0',
      description:
        'Key-authenticated REST API (BlueLabel fork). Send `Authorization: Bearer tvk_…`; keys are made in Settings → API keys.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'tvk_<prefix>_<secret>' },
      },
      schemas,
    },
    paths,
  }
}

let cached: ReturnType<typeof buildOpenApiDocument> | undefined

/** The document for every registered resource, built once per process. */
export function publicApiDocument() {
  cached ??= buildOpenApiDocument(RESOURCES.flat())
  return cached
}
