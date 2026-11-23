/**
 * @vitest-environment node
 *
 * fork: every source field is either mapped or listed as archive only (M4 acceptance): this enumerates
 * the keys of every fixture record, nested lines included, and fails on one that's in neither list, so a
 * field can't vanish silently (FORK.md, "Lossless by construction"). And the transforms never touch the
 * database.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CANNED_SERVICE_FIELDS,
  CATALOG_LINE_FIELDS,
  INVENTORY_PART_FIELDS,
} from '@/integrations/shopmonkey/transform/catalog'
import { CUSTOMER_FIELDS } from '@/integrations/shopmonkey/transform/customer'
import { type FieldSpec, unknownFields } from '@/integrations/shopmonkey/transform/fields'
import {
  INSPECTION_FIELDS,
  INSPECTION_TEMPLATE_FIELDS,
} from '@/integrations/shopmonkey/transform/inspection'
import { LINE_FIELDS, SERVICE_FIELDS } from '@/integrations/shopmonkey/transform/lines'
import { ORDER_FIELDS } from '@/integrations/shopmonkey/transform/order'
import { PAYMENT_FIELDS } from '@/integrations/shopmonkey/transform/payment'
import { REFERENCE_FIELDS } from '@/integrations/shopmonkey/transform/reference'
import { USER_FIELDS, WORKFLOW_STATUS_FIELDS } from '@/integrations/shopmonkey/transform/staff'
import { APPOINTMENT_FIELDS, TIMESHEET_FIELDS } from '@/integrations/shopmonkey/transform/time'
import { VEHICLE_FIELDS } from '@/integrations/shopmonkey/transform/vehicle'
import { fixtures } from './context'

const SPECS: Record<string, FieldSpec> = {
  customer: CUSTOMER_FIELDS,
  vehicle: VEHICLE_FIELDS,
  user: USER_FIELDS,
  workflow_status: WORKFLOW_STATUS_FIELDS,
  order: ORDER_FIELDS,
  order_service: SERVICE_FIELDS,
  payment: PAYMENT_FIELDS,
  timesheet: TIMESHEET_FIELDS,
  appointment: APPOINTMENT_FIELDS,
  inventory_part: INVENTORY_PART_FIELDS,
  inventory_tire: INVENTORY_PART_FIELDS,
  inventory_labor: CATALOG_LINE_FIELDS,
  inventory_fee: CATALOG_LINE_FIELDS,
  canned_service: CANNED_SERVICE_FIELDS,
  inspection_template: INSPECTION_TEMPLATE_FIELDS,
  inspection: INSPECTION_FIELDS,
  ...REFERENCE_FIELDS,
}

describe('every source field', () => {
  it('has a spec for every fixture table', () => {
    expect(
      Object.keys(fixtures)
        .filter((table) => !SPECS[table])
        .sort()
    ).toEqual([])
  })

  it.each(Object.keys(fixtures).sort())('of %s is mapped or archived', (table) => {
    const unknown = new Set<string>()
    for (const record of fixtures[table])
      for (const key of unknownFields(record, SPECS[table])) unknown.add(key)
    expect([...unknown].sort()).toEqual([])
  })

  it.each(Object.keys(LINE_FIELDS))('of a %s line is mapped or archived', (kind) => {
    const unknown = new Set<string>()
    for (const service of [...fixtures.order_service, ...fixtures.canned_service]) {
      const lines = service[kind]
      if (!Array.isArray(lines)) continue
      for (const line of lines)
        for (const key of unknownFields(line, LINE_FIELDS[kind])) unknown.add(key)
    }
    expect([...unknown].sort()).toEqual([])
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
