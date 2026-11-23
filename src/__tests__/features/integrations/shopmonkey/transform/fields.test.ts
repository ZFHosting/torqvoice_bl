/**
 * @vitest-environment node
 *
 * fork: every source field is either mapped or listed as archive only (M4 acceptance): this enumerates the keys
 * of every fixture record, and of every record nested in one (emails and phones, service and canned-service
 * lines, inspection and template items, file entries), and fails on one that's in neither list, so a field
 * can't vanish silently (FORK.md, "Lossless by construction"). And the transforms never touch the database.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { unknownFields } from '@/integrations/shopmonkey/transform/fields'
import { NESTED_SPECS, TABLE_SPECS } from '@/integrations/shopmonkey/transform/specs'
import { fixtures } from './context'

type Row = Record<string, unknown>
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((v): v is Row => !!v && typeof v === 'object') : []

/** The fixture records each nested spec covers. */
function nested(key: string): Row[] {
  if (key === 'files[]') {
    return [
      ...fixtures.order.flatMap((o) => rows(o.files)),
      ...fixtures.inspection.flatMap((i) => rows(i.items).flatMap((item) => rows(item.files))),
    ]
  }
  const [, table, field] = /^(\w+)\.(\w+)\[\]$/.exec(key) ?? []
  return (fixtures[table] ?? []).flatMap((record) => rows(record[field]))
}

describe('every source field', () => {
  it('has a spec for every fixture table', () => {
    expect(
      Object.keys(fixtures)
        .filter((table) => !TABLE_SPECS[table])
        .sort()
    ).toEqual([])
  })

  it.each(Object.keys(fixtures).sort())('of %s is mapped or archived', (table) => {
    const unknown = new Set<string>()
    for (const record of fixtures[table]) {
      for (const key of unknownFields(record, TABLE_SPECS[table])) unknown.add(key)
    }
    expect([...unknown].sort()).toEqual([])
  })

  it.each(Object.keys(NESTED_SPECS))('of %s is mapped or archived', (key) => {
    const unknown = new Set<string>()
    for (const record of nested(key)) {
      for (const field of unknownFields(record, NESTED_SPECS[key])) unknown.add(field)
    }
    expect([...unknown].sort()).toEqual([])
  })

  it('covers every nested record the fixtures carry, wherever the parent maps it', () => {
    // An archived field is kept whole; a mapped array of records has its own spec, by `<table>.<key>[]`.
    const found = new Set<string>()
    for (const [table, records] of Object.entries(fixtures)) {
      for (const record of records) {
        for (const [key, value] of Object.entries(record)) {
          if (!rows(value).length) continue
          if (key === 'files') found.add('files[]')
          else if (TABLE_SPECS[table]?.mapped.includes(key)) found.add(`${table}.${key}[]`)
        }
      }
    }
    expect([...found].filter((key) => !NESTED_SPECS[key]).sort()).toEqual([])
  })
})

describe('the transforms', () => {
  it('import nothing from the database', () => {
    const dir = path.join(process.cwd(), 'src/integrations/shopmonkey/transform')
    const offenders = fs
      .readdirSync(dir)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) =>
        /from ['"]@\/lib\/db['"]/.test(fs.readFileSync(path.join(dir, file), 'utf-8'))
      )
    expect(offenders).toEqual([])
  })
})
