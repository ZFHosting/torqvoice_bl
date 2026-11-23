/**
 * @vitest-environment node
 *
 * fork: the public API's serializers build each response field by field (docs/fork/milestones/A3-read-endpoints.md):
 * a spread row would send whatever a column added later holds (a share token, a secret) without anyone deciding
 * to. Spreading a row's field (`[...row.tags]`) or a constant (`...JOB_SELECT`) is fine; spreading a row isn't.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SERIALIZERS = path.join(process.cwd(), 'src', 'features', 'public-api', 'Serializers')

/** `...name` where `name` is a lower-case identifier not followed by `.`: a whole object spread into another. */
const SPREAD_OBJECT = /\.\.\.(?!\()([a-z]\w*)(?![\w.])/g

describe('the public API serializers', () => {
  const files = fs.readdirSync(SERIALIZERS).filter((f) => f.endsWith('.ts'))

  it('are there', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files)('%s spreads no row', (file) => {
    const source = fs.readFileSync(path.join(SERIALIZERS, file), 'utf-8')
    const spreads = [...source.matchAll(SPREAD_OBJECT)].map((m) => m[0])
    expect(spreads).toEqual([])
    expect(source).not.toMatch(/\.\.\.(row|record)\b(?!\.)/)
  })

  it('would catch one', () => {
    expect('return { ...row, id: row.id }'.match(SPREAD_OBJECT)).toEqual(['...row'])
    expect('tags: [...row.tags]'.match(SPREAD_OBJECT)).toBeNull()
    expect('{ ...JOB_SELECT }'.match(SPREAD_OBJECT)).toBeNull()
  })
})
