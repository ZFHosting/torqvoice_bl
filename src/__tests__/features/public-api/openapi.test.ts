/**
 * @vitest-environment node
 *
 * fork: the public API's OpenAPI document (docs/fork/API.md §1.4) is valid OpenAPI 3.1, and every
 * route under src/app/api/v1 that the public API serves is in it, so the document can't fall
 * behind the code.
 */
import fs from 'node:fs'
import path from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

const { publicApiDocument } = await import('@/features/public-api/Lib/openapi')
const { GET } = await import('@/app/api/v1/openapi.json/route')

const V1 = path.join(process.cwd(), 'src', 'app', 'api', 'v1')

/**
 * Every public API route file, with the methods it exports: those that run in withPublicApi themselves, and the
 * thin ones built from a resource declaration (`export const GET = listRoute(…)`, A3).
 */
function publicRoutes(): { path: string; methods: string[] }[] {
  const found: { path: string; methods: string[] }[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'route.ts') {
        const source = fs.readFileSync(full, 'utf-8')
        const builtFromResource =
          source.includes("from '@/features/public-api/Resources/") ||
          source.includes("from '@/features/public-api/Lib/readResource'")
        if (!source.includes('withPublicApi(') && !builtFromResource) continue
        const route = path
          .relative(V1, path.dirname(full))
          .split(path.sep)
          .map((part) => part.replace(/^\[(\w+)\]$/, '{$1}'))
          .join('/')
        const methods = [
          ...source.matchAll(/export (?:async function|const) (GET|POST|PATCH|DELETE)\b/g),
        ]
        found.push({ path: `/${route}`, methods: methods.map((m) => m[1].toLowerCase()) })
      }
    }
  }
  walk(V1)
  return found
}

describe('the OpenAPI document', () => {
  it('is valid OpenAPI 3.1', async () => {
    const document = structuredClone(publicApiDocument())
    expect(document.openapi).toBe('3.1.0')
    await expect(SwaggerParser.validate(document as never)).resolves.toBeTruthy()
  })

  it('documents every public route and method, and nothing that isn’t one', () => {
    const routes = publicRoutes()
    expect(routes.length).toBeGreaterThan(0)
    const documented = publicApiDocument().paths as Record<string, Record<string, unknown>>
    const expected = routes.flatMap((r) => r.methods.map((m) => `${m} ${r.path}`)).sort()
    const actual = Object.entries(documented)
      .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`))
      .sort()
    expect(actual).toEqual(expected)
  })

  it('carries the settings response schema built from zod', () => {
    const op = (publicApiDocument().paths as Record<string, Record<string, any>>)['/settings'].get
    const schema = op.responses['200'].content['application/json'].schema
    expect(JSON.stringify(schema)).toContain('Settings')
    expect(op.security).toEqual([{ apiKey: [] }])
  })

  it('is served without a key, and may be cached', async () => {
    const response = GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toMatch(/max-age/)
    expect((await response.json()).openapi).toBe('3.1.0')
  })
})
