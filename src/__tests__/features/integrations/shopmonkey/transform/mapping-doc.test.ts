/**
 * @vitest-environment node
 *
 * fork: MAPPING §11 lists, per table and per nested record, the fields the transforms keep in the archive only
 * (M4, FORK.md: "a transform that ignores a field lists it in MAPPING.md under 'archive only'"). This keeps the
 * document and the field specs (`transform/specs.ts`) from drifting apart.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NESTED_SPECS, TABLE_SPECS } from '@/integrations/shopmonkey/transform/specs'

const SPECS = { ...TABLE_SPECS, ...NESTED_SPECS }

function documented(): Record<string, string[]> {
  const doc = fs
    .readFileSync(path.join(process.cwd(), 'docs/fork/MAPPING.md'), 'utf-8')
    .replace(/\r\n/g, '\n')
  const start = doc.indexOf('## 11. Fields kept in the archive only')
  // §11 only: up to the next section (§12, the reconciliation, has tables of its own).
  const next = doc.indexOf('\n## ', start + 1)
  const section = doc.slice(start, next === -1 ? undefined : next)
  const out: Record<string, string[]> = {}
  for (const m of section.matchAll(/^\| `([^`]+)` \| (.*) \|$/gm)) {
    out[m[1]] = [...m[2].matchAll(/`([^`]+)`/g)].map((f) => f[1])
  }
  return out
}

describe('MAPPING §11', () => {
  it('lists exactly the archive-only fields of every transform', () => {
    const doc = documented()
    expect(Object.keys(doc).sort()).toEqual(Object.keys(SPECS).sort())
    for (const [key, spec] of Object.entries(SPECS)) {
      expect(doc[key], key).toEqual([...new Set(spec.archive)].sort())
    }
  })
})
