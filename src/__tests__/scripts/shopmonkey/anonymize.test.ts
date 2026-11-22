/**
 * @vitest-environment node
 *
 * The fixture anonymizer (scripts/shopmonkey/anonymize.ts) is what stands between a recorded
 * Shopmonkey account and git. These tests feed it records shaped like Shopmonkey's, full of
 * recognisable fake personal data, and check that none of it survives, that ids, enums and money are
 * untouched, and that the same input always becomes the same fake. One test builds a record for every
 * table in Shopmonkey's published schemas with every string field filled in, so a field nobody
 * thought of is replaced too.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createAnonymizer,
  ENUM_KEYS,
  FAKE_EMAIL_DOMAIN,
  FAKE_PHONE_PATTERN,
  FAKE_VIN_PREFIX,
  findLeaks,
  SAFE_KEYS,
} from '../../../../scripts/shopmonkey/anonymize'

const SALT = 'test-salt-for-anonymizer-0123456789'

const customer = {
  id: '64b0c1d2e3f4a5b6c7d8e9f0',
  publicId: '1042',
  firstName: 'Bartholomew',
  lastName: 'Quackenbush',
  companyName: 'Quackenbush Plumbing LLC',
  address1: '742 Evergreen Terrace',
  address2: 'Unit 9',
  city: 'Shelbyville',
  state: 'OR',
  postalCode: '97035',
  country: 'US',
  note: 'Prefers texts at 503-555-0187, wife is Marge.',
  emails: [{ id: 'e1', email: 'bart.quackenbush@quackenbush.invalid', primary: true }],
  phoneNumbers: [{ id: 'p1', number: '(503) 555-0142', type: 'Mobile', primary: true }],
  customFields: { favoriteShop: 'Ask for bart.q@mail.invalid' },
  locationIds: ['loc_1'],
  taxExempt: false,
  createdDate: '2021-04-02T15:04:05.000Z',
}

const order = {
  id: 'ord_1',
  number: '1042',
  status: 'Invoice',
  customerId: '64b0c1d2e3f4a5b6c7d8e9f0',
  name: 'Quackenbush brake job',
  generatedName: 'Bartholomew Quackenbush - 2015 Honda Civic',
  generatedCustomerName: 'Bartholomew Quackenbush',
  complaint: 'Grinding noise; call Bart on 5035550187',
  totalCostCents: 27500,
  customer: { id: 'c1', firstName: 'Bartholomew', lastName: 'Quackenbush' },
  vehicle: { id: 'veh_1', vin: '1HGCM82633A004352', licensePlate: 'QCK123', year: 2015 },
  files: [{ id: 'f1', fileName: 'quackenbush-signature.png', url: 'https://cdn.invalid/x.png' }],
  services: [
    {
      id: 'svc_1',
      name: 'Front brakes',
      authorizationStatus: 'Authorized',
      parts: [{ id: 'prt_1', name: 'Brake pads', retailCostCents: 10000 }],
      labors: [{ id: 'lab_1', name: 'Replace pads', technicianId: 'usr_1', rateCents: 10000 }],
    },
  ],
}

describe('createAnonymizer', () => {
  it('replaces names, contact details, addresses and notes, and keeps ids, enums and dates', () => {
    const anon = createAnonymizer(SALT)
    const out = anon.record('customer', customer) as typeof customer
    expect(out.id).toBe(customer.id)
    expect(out.locationIds).toEqual(['loc_1'])
    expect(out.publicId).toBe('1042')
    expect(out.state).toBe('OR')
    expect(out.country).toBe('US')
    expect(out.createdDate).toBe(customer.createdDate)
    for (const field of [
      'firstName',
      'lastName',
      'companyName',
      'address1',
      'address2',
      'city',
      'postalCode',
      'note',
    ] as const) {
      expect(out[field], field).not.toBe(customer[field])
    }
    expect(out.emails[0].email).toMatch(new RegExp(`@${FAKE_EMAIL_DOMAIN.replace('.', '\\.')}$`))
    expect(out.emails[0].id).toBe('e1')
    expect(out.phoneNumbers[0].number).toMatch(FAKE_PHONE_PATTERN)
    expect(out.phoneNumbers[0].type).toBe('Mobile')
    expect(out.customFields.favoriteShop).not.toContain('mail.invalid')
  })

  it('leaves no recognisable personal data anywhere in the output', () => {
    const anon = createAnonymizer(SALT)
    const serialized = JSON.stringify([
      anon.record('customer', customer),
      anon.record('order', order),
    ])
    for (const pii of [
      'Bartholomew',
      'Quackenbush',
      'Evergreen',
      'Shelbyville',
      'quackenbush.invalid',
      'mail.invalid',
      '555-0187',
      '5035550187',
      '555-0142',
      '1HGCM82633A004352',
      'QCK123',
      'Marge',
    ]) {
      expect(serialized.toLowerCase(), pii).not.toContain(pii.toLowerCase())
    }
    expect(findLeaks(serialized, anon.originals())).toEqual([])
  })

  it('keeps order structure, line names, enums and cents, and replaces free-text order names', () => {
    const anon = createAnonymizer(SALT)
    const out = anon.record('order', order) as typeof order
    expect(out.number).toBe('1042')
    expect(out.status).toBe('Invoice')
    expect(out.totalCostCents).toBe(27500)
    expect(out.name).not.toContain('Quackenbush')
    expect(out.services[0].name).toBe('Front brakes')
    expect(out.services[0].authorizationStatus).toBe('Authorized')
    expect(out.services[0].parts[0]).toEqual(order.services[0].parts[0])
    expect(out.services[0].labors[0].technicianId).toBe('usr_1')
    expect(out.vehicle.year).toBe(2015)
    expect(out.vehicle.vin).toHaveLength(17)
    expect(out.vehicle.vin.startsWith(FAKE_VIN_PREFIX)).toBe(true)
    expect(out.files[0].fileName).toMatch(/^file-[0-9a-f]+\.png$/)
    expect(out.files[0].url).not.toContain('cdn.invalid')
  })

  it('zeroes coordinates', () => {
    const out = createAnonymizer(SALT).record('timesheet', {
      clockInLatitude: 45.5,
      clockInLongitude: -122.6,
    }) as Record<string, number>
    expect(out).toEqual({ clockInLatitude: 0, clockInLongitude: 0 })
  })

  it('replaces every documented string field of every table unless it is an id, an enum or a catalog fact', () => {
    // docs/fork/spikes/SHOPMONKEY-SCHEMAS.md: one line per table, `field`: type.
    const schemas = readFileSync(
      path.join(process.cwd(), 'docs/fork/spikes/SHOPMONKEY-SCHEMAS.md'),
      'utf-8'
    )
    const thingNames = new Set([
      'service',
      'labor',
      'part',
      'tire',
      'fee',
      'subcontract',
      'canned_service',
      'canned_service_labor',
      'canned_service_part',
      'canned_service_tire',
      'canned_service_fee',
      'canned_service_subcontract',
      'inventory_part',
      'inventory_tire',
      'inventory_labor',
      'inventory_fee',
      'inventory_category',
      'inspection',
      'inspection_item',
      'inspection_item_status_detail',
      'inspection_template',
      'inspection_template_item',
      'workflow_status',
      'labor_rate',
      'label',
      'referral_source',
      'tax_config',
      'payment_term',
      'tire_model',
      'brand',
      'labor_matrix',
      'pricing_matrix',
      'core_charge',
    ])
    let tables = 0
    const survivors: string[] = []
    for (const line of schemas.split(/\r?\n/)) {
      const table = /^- \*\*\w+\*\* \(`(\w+)`\): (.*)$/.exec(line)
      if (!table) continue
      tables++
      const record: Record<string, unknown> = {}
      for (const field of table[2].split('; ')) {
        const m = /^`([^`]+)`: (.*)$/.exec(field)
        if (!m) continue
        const [, name, type] = m
        const isId = name === 'id' || /Ids?$/.test(name)
        if (isId && name !== 'taxId' && name !== 'externalId') continue
        if (ENUM_KEYS.has(name) || SAFE_KEYS.has(name)) continue
        if (name === 'name' && thingNames.has(table[1])) continue
        if (type.startsWith('string[]')) record[name] = ['Quackenbush']
        else if (type.startsWith('string')) record[name] = `Quackenbush ${name}`
      }
      const out = JSON.stringify(createAnonymizer(SALT).record(table[1], record))
      if (/quackenbush/i.test(out)) survivors.push(`${table[1]}: ${out.slice(0, 200)}`)
    }
    expect(tables).toBeGreaterThan(100)
    expect(survivors).toEqual([])
  })

  it('is deterministic for the same salt and input, so references stay consistent', () => {
    const a = createAnonymizer(SALT).record('customer', customer)
    const b = createAnonymizer(SALT).record('customer', customer)
    expect(a).toEqual(b)
    const viaOrder = createAnonymizer(SALT).record('order', {
      customer: { email: 'BART.quackenbush@quackenbush.invalid ' },
    }) as {
      customer: { email: string }
    }
    expect(viaOrder.customer.email).toBe((a as typeof customer).emails[0].email)
  })

  it('gives different fakes with a different salt', () => {
    const a = createAnonymizer(SALT).record('customer', customer) as typeof customer
    const b = createAnonymizer(`${SALT}-other`).record('customer', customer) as typeof customer
    expect(a.emails[0].email).not.toBe(b.emails[0].email)
  })

  it('does not modify its input', () => {
    const copy = structuredClone(customer)
    createAnonymizer(SALT).record('customer', customer)
    expect(customer).toEqual(copy)
  })

  it('refuses a short salt', () => {
    expect(() => createAnonymizer('short')).toThrow(/salt/)
  })
})

describe('findLeaks', () => {
  it('finds an original value or a deny-listed one as whole words, ignoring case', () => {
    const text = '{"name":"Avery Ashford","shop":"Joes Garage","note":"brakes"}'
    expect(findLeaks(text, ['avery'], [])).toEqual(['avery'])
    expect(findLeaks(text, [], ['Joes Garage'])).toEqual(['Joes Garage'])
    expect(findLeaks(text, ['Brake'], [])).toEqual([])
    expect(findLeaks(text, ['Ashford'], [], ['ashford'])).toEqual([])
  })

  it('sees through apostrophes and sentence punctuation', () => {
    expect(findLeaks('{"n":"orourke"}', ["O'Rourke"])).toEqual(["O'Rourke"])
    expect(findLeaks('{"note":"Ask for Marge."}', ['Marge'])).toEqual(['Marge'])
  })

  it('finds a deny-listed name squashed into a domain', () => {
    expect(findLeaks('{"website":"https://joesgarage.example"}', [], ['Joes Garage'])).toEqual([
      'Joes Garage',
    ])
  })
})
