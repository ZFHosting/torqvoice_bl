/**
 * @vitest-environment node
 *
 * fork: the transforms other than orders (M4), against the synthetic fixtures: customers, vehicles,
 * staff and statuses, payments (refunds and deposits each have their own test), time, appointments, the
 * catalog, tax settings and inspections. One snapshot per entity, plus the rules MAPPING spells out.
 */
import { describe, expect, it } from 'vitest'
import {
  transformCannedService,
  transformCatalogLine,
  transformInventoryItem,
  transformTaxConfig,
} from '@/integrations/shopmonkey/transform/catalog'
import { composeAddress, transformCustomer } from '@/integrations/shopmonkey/transform/customer'
import {
  condition,
  transformInspection,
  transformInspectionTemplate,
} from '@/integrations/shopmonkey/transform/inspection'
import {
  paymentMethod,
  refundWarnings,
  transformPayment,
} from '@/integrations/shopmonkey/transform/payment'
import { defaultLaborRate } from '@/integrations/shopmonkey/transform/reference'
import {
  defaultStages,
  technicianColor,
  transformUser,
  transformWorkflowStatuses,
} from '@/integrations/shopmonkey/transform/staff'
import { transformAppointment, transformTimesheet } from '@/integrations/shopmonkey/transform/time'
import { currentOwner, transformVehicle } from '@/integrations/shopmonkey/transform/vehicle'
import { context, fixture, fixtures, local } from './context'

const ownersOf = (vehicleId: string) =>
  fixtures.vehicle_owner.filter((o) => o.vehicleId === vehicleId)

describe('customers', () => {
  it('take the primary email and phone, keep every contact, and compose the address', () => {
    const result = transformCustomer(fixture('customer', 'syn_cus_1'), context())
    expect(result.rows?.customer).toMatchObject({
      email: 'dana.dunmore@example.test',
      phone: '+12025550101',
      userId: 'user-run',
      organizationId: 'org-1',
      reminderOptOut: false,
    })
    expect(result.rows?.contacts.map((c) => [c.kind, c.isPrimary])).toEqual([
      ['email', true],
      ['email', false],
      ['phone', true],
      ['phone', false],
    ])
    expect(result.rows?.customerNumberCandidate).toBe('1001')
    expect(result).toMatchSnapshot()
  })

  it('name a company customer after the company, and leave a non-numeric publicId for M5 to number', () => {
    const result = transformCustomer(fixture('customer', 'syn_cus_4'), context())
    expect(result.rows?.customer).toMatchObject({ name: 'Glenhollow Rentals', company: null })
    expect(result.rows?.customerNumberCandidate).toBeNull()
  })

  it('keep a person’s company as the company', () => {
    const result = transformCustomer(fixture('customer', 'syn_cus_2'), context())
    expect(result.rows?.customer.company).toBe('Fairbank Logistics')
    expect(result.rows?.customFields).toContainEqual({
      entityType: 'customer',
      name: 'Customer type',
      value: 'Fleet',
    })
  })

  it('opt out of reminders only on an explicit unsubscribe of the primary email', () => {
    const record = fixture('customer', 'syn_cus_1')
    ;(record.emails as Record<string, unknown>[])[0].subscribed = false
    expect(transformCustomer(record, context()).rows?.customer.reminderOptOut).toBe(true)
  })

  it('are not imported when deleted', () => {
    expect(transformCustomer(fixture('customer', 'syn_cus_3'), context()).rows).toBeNull()
  })

  it('print the address in invoice order', () => {
    expect(
      composeAddress({
        address1: '1 Main St',
        address2: 'Unit 2',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'US',
      })
    ).toBe('1 Main St\nUnit 2\nAustin, TX 78701\nUS')
  })
})

describe('vehicles', () => {
  it('normalise the plate, lowercase the colour, leave fuel unset and keep the exact transmission', () => {
    const result = transformVehicle(
      fixture('vehicle', 'syn_veh_1'),
      ownersOf('syn_veh_1'),
      context()
    )
    expect(result.rows?.vehicle).toMatchObject({
      year: 2018,
      make: 'Honda',
      color: 'blue',
      transmission: 'automatic',
      fuelType: null,
      customerId: local('customer', 'syn_cus_1'),
    })
    expect(result.rows?.customFields).toContainEqual({
      entityType: 'vehicle',
      name: 'Transmission',
      value: 'AutomaticCVT',
    })
    expect(result.rows?.note).toEqual({
      title: 'Shopmonkey note',
      content: 'Customer prefers synthetic oil.',
    })
    expect(result).toMatchSnapshot()
  })

  it('fall back to Unknown with year 0, warned, and take the newest owner', () => {
    const result = transformVehicle(
      fixture('vehicle', 'syn_veh_3'),
      ownersOf('syn_veh_3'),
      context()
    )
    expect(result.rows?.vehicle).toMatchObject({
      year: 0,
      make: 'Unknown',
      model: 'Unknown',
      customerId: local('customer', 'syn_cus_4'),
    })
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      'vehicle_missing_ymm',
      'vehicle_multiple_owners',
    ])
    expect(currentOwner(ownersOf('syn_veh_3'))).toEqual({ customerId: 'syn_cus_4', count: 2 })
  })
})

describe('staff and statuses', () => {
  it('make technicians from users, with their colour as hex', () => {
    const result = transformUser(fixture('user', 'syn_usr_1'), context())
    expect(result.rows).toMatchObject({ name: 'Avery Ashford', color: '#3b82f6', isActive: true })
    expect(technicianColor('#ABCDEF')).toBe('#abcdef')
    expect(technicianColor('chartreuse')).toBeUndefined()
    expect(result).toMatchSnapshot()
  })

  it('file statuses under a stage: invoice workflow completed, the first repair status pending', () => {
    const stages = defaultStages(fixtures.workflow_status)
    const invoice = fixtures.workflow_status.filter((s) => s.invoiceWorkflow === true)
    for (const s of invoice) expect(stages.get(String(s.id))).toBe('completed')
    expect([...stages.values()]).toContain('pending')
    const result = transformWorkflowStatuses(fixtures.workflow_status, context())
    expect(result).toMatchSnapshot()
  })

  it('let the operator’s mapping win over the default', () => {
    const first = String(fixtures.workflow_status[0].id)
    const result = transformWorkflowStatuses(
      fixtures.workflow_status,
      context({ settings: { statusStageMap: { [first]: 'completed' }, technicianMap: {} } })
    )
    expect(result.rows.find((r) => r.remoteId === first)?.stage).toBe('completed')
  })
})

describe('payments', () => {
  const pay = (id: string) => transformPayment(fixture('payment', id), context())

  it('take a refund as a negative amount, naming the charge it refunds', () => {
    const result = pay('syn_pay_1003_3')
    expect(result.rows).toMatchObject({
      amount: -50,
      method: 'card',
      provider: 'shopmonkey',
      externalId: 'syn_pay_1003_3',
    })
    expect(result.rows?.note).toMatch(/^Refund of syn_pay_1003_2/)
  })

  it('take a deposit as a payment on the order, said so in its note', () => {
    const result = pay('syn_pay_1003_1')
    expect(result.rows).toMatchObject({
      amount: 100,
      method: 'cash',
      serviceRecordId: local('order', 'syn_ord_1003'),
    })
    expect(result.rows?.note).toContain('Deposit')
  })

  it('never subtract a charge’s own refunded amount, and leave out a failed charge', () => {
    expect(pay('syn_pay_1003_2').rows?.amount).toBe(500)
    expect(pay('syn_pay_1003_4').rows).toBeNull()
  })

  it('warn when refunds bring what was paid to zero', () => {
    const rows = ['syn_pay_1004_1', 'syn_pay_1004_2']
      .map((id) => pay(id).rows)
      .filter((r) => r !== null)
    expect(refundWarnings('syn_ord_1004', rows).map((w) => w.code)).toEqual([
      'refund_net_nonpositive',
    ])
  })

  it('map payment types to methods', () => {
    expect(['Cash', 'Card', 'Zelle', 'Check', null].map(paymentMethod)).toEqual([
      'cash',
      'card',
      'transfer',
      'other',
      'other',
    ])
  })

  it('match the snapshot', () => {
    expect(
      fixtures.payment.map((p) => transformPayment(structuredClone(p), context()))
    ).toMatchSnapshot()
  })
})

describe('time and appointments', () => {
  it('make a labor timesheet a time entry on its order, and a General one a shift', () => {
    const labor = transformTimesheet(fixture('timesheet', 'syn_tsh_1'), context())
    expect(labor.rows).toMatchObject({
      kind: 'timeEntry',
      row: { durationMinutes: 90, serviceRecordId: local('order', 'syn_ord_1003') },
    })
    const shift = transformTimesheet(fixture('timesheet', 'syn_tsh_3'), context())
    expect(shift.rows).toMatchObject({
      kind: 'shift',
      row: { clockOut: null, durationMinutes: null },
    })
  })

  it('keep a timesheet on an order that isn’t a work order as a shift, warned', () => {
    const result = transformTimesheet(
      fixture('timesheet', 'syn_tsh_1'),
      context({ notLoaded: ['order:syn_ord_1003'] })
    )
    expect(result.rows?.kind).toBe('shift')
    expect(result.warnings.map((w) => w.code)).toEqual(['timesheet_order_not_loaded'])
  })

  it('make appointments, with the order they were booked for', () => {
    const result = transformAppointment(fixture('appointment', 'syn_apt_1'), context())
    expect(result.rows?.orderRemoteId).toBe('syn_ord_1002')
    expect(result).toMatchSnapshot()
  })
})

describe('the catalog and settings', () => {
  const lookups = {
    categories: Object.fromEntries(fixtures.inventory_category.map((c) => [String(c.id), c])),
    vendors: Object.fromEntries(fixtures.vendor.map((v) => [String(v.id), v])),
  }

  it('make inventory parts with the starting count as an import movement', () => {
    const result = transformInventoryItem(
      fixture('inventory_part', 'syn_inv_1'),
      'part',
      lookups,
      context()
    )
    expect(result.rows?.movement?.reason).toBe('import')
    expect(result).toMatchSnapshot()
  })

  it('file tires under Tires with their size in the description', () => {
    const result = transformInventoryItem(
      fixture('inventory_tire', 'syn_itr_1'),
      'tire',
      lookups,
      context()
    )
    expect(result.rows?.part.category).toBe('Tires')
    expect(result.rows?.part.description).toMatch(/^Size /)
  })

  it('make presets from canned services, catalog labor and fees', () => {
    expect(
      transformCannedService(fixture('canned_service', 'syn_can_1'), context())
    ).toMatchSnapshot()
    expect(
      transformCatalogLine(fixture('inventory_labor', 'syn_inl_1'), 'labor', context())
    ).toMatchSnapshot()
    expect(
      transformCatalogLine(fixture('inventory_fee', 'syn_inf_1'), 'fee', context())
    ).toMatchSnapshot()
  })

  it('read the tax config and the default labor rate', () => {
    expect(transformTaxConfig(fixtures.tax_config[0])).toMatchSnapshot()
    expect(defaultLaborRate(fixtures.labor_rate, fixtures.tax_config[0])).not.toBeNull()
  })
})

describe('inspections', () => {
  it('grade Green, Yellow, Red, N/A and ungraded as pass, attention, fail, not applicable, not inspected', () => {
    expect(['Green', 'Yellow', 'Red', 'NotApplicable', null].map(condition)).toEqual([
      'pass',
      'attention',
      'fail',
      'not_applicable',
      'not_inspected',
    ])
  })

  it('make templates on the basic scale, and inspections against them with their photos', () => {
    expect(
      transformInspectionTemplate(fixture('inspection_template', 'syn_itp_1'), context())
    ).toMatchSnapshot()
    const result = transformInspection(
      fixture('inspection', 'syn_ins_1'),
      fixture('order', 'syn_ord_1003'),
      context()
    )
    expect(result.rows?.inspection.vehicleId).toBe(local('vehicle', 'syn_veh_1'))
    expect(result.rows?.items.some((i) => i.photoRemoteIds.length > 0)).toBe(true)
    expect(result).toMatchSnapshot()
  })
})
