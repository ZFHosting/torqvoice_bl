/**
 * @vitest-environment node
 *
 * The fixture anonymizer (scripts/shopmonkey/anonymize.ts) is what stands between a recorded
 * Shopmonkey account and git. These tests feed it a record shaped like Shopmonkey's, full of
 * recognisable fake PII, and check that none of it survives, that ids and money are untouched, and
 * that the same input always becomes the same fake.
 */
import { describe, expect, it } from 'vitest'
import {
  createAnonymizer,
  FAKE_EMAIL_DOMAIN,
  FAKE_PHONE_PATTERN,
  FAKE_VIN_PREFIX,
  findLeaks,
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
  note: 'Prefers texts at 503-555-8765, wife is Marge',
  emails: [{ id: 'e1', email: 'bart.quackenbush@gmail.com', primary: true }],
  phoneNumbers: [{ id: 'p1', number: '(503) 867-5309', type: 'Mobile', primary: true }],
  customFields: { favoriteShop: 'Ask for bart.q@yahoo.com' },
  locationIds: ['loc_1'],
  taxExempt: false,
  createdDate: '2021-04-02T15:04:05.000Z',
}

const order = {
  id: 'ord_1',
  number: 1042,
  customerId: '64b0c1d2e3f4a5b6c7d8e9f0',
  name: 'Brake job',
  generatedName: 'Bartholomew Quackenbush - 2015 Honda Civic',
  complaint: 'Grinding noise; call Bart on 5038675309',
  totalCostCents: 27500,
  vehicle: { id: 'veh_1', vin: '1HGCM82633A004352', licensePlate: 'QCK123', year: 2015 },
  services: [
    {
      id: 'svc_1',
      name: 'Front brakes',
      parts: [{ id: 'prt_1', name: 'Brake pads', retailCostCents: 10000 }],
      labors: [{ id: 'lab_1', name: 'Replace pads', technicianId: 'usr_1', rateCents: 10000 }],
    },
  ],
}

describe('createAnonymizer', () => {
  it('replaces names, contact details, addresses and notes, and keeps ids and money', () => {
    const anon = createAnonymizer(SALT)
    const out = anon.record('customer', customer) as typeof customer
    expect(out.id).toBe(customer.id)
    expect(out.locationIds).toEqual(['loc_1'])
    expect(out.publicId).toBe('1042')
    expect(out.state).toBe('OR')
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
    expect(out.customFields.favoriteShop).not.toContain('yahoo')
  })

  it('leaves no recognisable PII anywhere in the output', () => {
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
      'gmail.com',
      'yahoo.com',
      '867-5309',
      '8675309',
      '555-8765',
      '1HGCM82633A004352',
      'QCK123',
      'Marge',
    ]) {
      expect(serialized, pii).not.toContain(pii)
    }
    expect(findLeaks(serialized, anon.originals())).toEqual([])
  })

  it('keeps order structure, line names and cents', () => {
    const anon = createAnonymizer(SALT)
    const out = anon.record('order', order) as typeof order
    expect(out.name).toBe('Brake job')
    expect(out.number).toBe(1042)
    expect(out.totalCostCents).toBe(27500)
    expect(out.services[0].parts[0]).toEqual(order.services[0].parts[0])
    expect(out.services[0].labors[0].technicianId).toBe('usr_1')
    expect(out.vehicle.year).toBe(2015)
    expect(out.vehicle.vin).toHaveLength(17)
    expect(out.vehicle.vin.startsWith(FAKE_VIN_PREFIX)).toBe(true)
    expect(out.generatedName).not.toContain('Quackenbush')
  })

  it('is deterministic for the same salt and input, so references stay consistent', () => {
    const a = createAnonymizer(SALT).record('customer', customer)
    const b = createAnonymizer(SALT).record('customer', customer)
    expect(a).toEqual(b)
    const viaOrder = createAnonymizer(SALT).record('order', {
      customer: { email: 'BART.quackenbush@gmail.com ' },
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
  it('finds an original value or a deny-listed one as a whole word, ignoring case', () => {
    const text = '{"name":"Avery Ashford","shop":"Joes Garage","note":"brakes"}'
    expect(findLeaks(text, ['avery'], [])).toEqual(['avery'])
    expect(findLeaks(text, [], ['Joes Garage'])).toEqual(['Joes Garage'])
    expect(findLeaks(text, ['Brake'], [])).toEqual([])
    expect(findLeaks(text, ['Ashford'], [], ['ashford'])).toEqual([])
  })
})
