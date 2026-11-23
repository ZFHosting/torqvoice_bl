/**
 * @vitest-environment node
 *
 * fork: MAPPING §11 lists, per table, the fields the transforms keep in the archive only (M4, FORK.md: "a
 * transform that ignores a field lists it in MAPPING.md under 'archive only'"). This keeps the document and the
 * field specs from drifting apart.
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
import type { FieldSpec } from '@/integrations/shopmonkey/transform/fields'
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

const SPECS: Record<string, FieldSpec> = {
  customer: CUSTOMER_FIELDS,
  vehicle: VEHICLE_FIELDS,
  user: USER_FIELDS,
  workflow_status: WORKFLOW_STATUS_FIELDS,
  order: ORDER_FIELDS,
  order_service: SERVICE_FIELDS,
  ...Object.fromEntries(
    Object.entries(LINE_FIELDS).map(([kind, spec]) => [`order_service.${kind}[]`, spec])
  ),
  payment: PAYMENT_FIELDS,
  timesheet: TIMESHEET_FIELDS,
  appointment: APPOINTMENT_FIELDS,
  'inventory_part, inventory_tire': INVENTORY_PART_FIELDS,
  canned_service: CANNED_SERVICE_FIELDS,
  'inventory_labor, inventory_fee': CATALOG_LINE_FIELDS,
  inspection_template: INSPECTION_TEMPLATE_FIELDS,
  inspection: INSPECTION_FIELDS,
  ...REFERENCE_FIELDS,
}

function documented(): Record<string, string[]> {
  const doc = fs
    .readFileSync(path.join(process.cwd(), 'docs/fork/MAPPING.md'), 'utf-8')
    .replace(/\r\n/g, '\n')
  const section = doc.slice(doc.indexOf('## 11. Fields kept in the archive only'))
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
    for (const [table, spec] of Object.entries(SPECS)) {
      expect(doc[table], table).toEqual([...new Set(spec.archive)].sort())
    }
  })
})
