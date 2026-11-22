/**
 * @vitest-environment node
 *
 * Guards the Shopmonkey fixtures the importer is tested against
 * (src/__tests__/features/integrations/fixtures/shopmonkey/). Every file says whether it is synthetic or
 * recorded-and-anonymized, nothing in them looks like real contact data or a real VIN, and the order
 * money agrees with its services, so the importer's money assertions test the importer and not a typo.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(process.cwd(), 'src/__tests__/features/integrations/fixtures/shopmonkey')

interface Fixture {
  table: string
  source: 'synthetic' | 'recorded'
  synthetic?: boolean
  anonymized?: boolean
  total: number | null
  records: Record<string, unknown>[]
}

function load(set: string): Map<string, Fixture> {
  const dir = path.join(ROOT, set)
  const out = new Map<string, Fixture>()
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    out.set(name.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(dir, name), 'utf-8')))
  }
  return out
}

const sets = ['synthetic', 'recorded']
  .map((set) => [set, load(set)] as const)
  .filter(([, f]) => f.size)

describe.each(sets)('Shopmonkey fixtures: %s', (set, fixtures) => {
  it('label themselves', () => {
    for (const [name, f] of fixtures) {
      expect(f.table, name).toBe(name)
      if (set === 'synthetic') expect(f.synthetic && f.source === 'synthetic', name).toBe(true)
      else expect(f.anonymized && f.source === 'recorded', name).toBe(true)
      expect(Array.isArray(f.records), name).toBe(true)
    }
  })

  it('hold no real-looking emails, phones or VINs', () => {
    const text = [...fixtures.values()].map((f) => JSON.stringify(f.records)).join('\n')
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
    expect(emails.filter((e) => !e.endsWith('@example.test'))).toEqual([])
    const phones = text.match(/\+\d{11}/g) ?? []
    expect(phones.filter((p) => !/^\+1202555 ?01\d\d$/.test(p))).toEqual([])
    const vins = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) ?? []
    expect(vins.filter((v) => !v.startsWith('TVFX'))).toEqual([])
    expect(text).not.toMatch(/@(gmail|yahoo|hotmail|outlook|icloud)\./i)
  })

  it('keep every order total equal to the sum of the services that count toward it', () => {
    const orders = fixtures.get('order')?.records ?? []
    const services = fixtures.get('order_service')?.records ?? []
    expect(orders.length).toBeGreaterThan(0)
    for (const order of orders) {
      const counted = services.filter(
        (s) => s.orderId === order.id && s.authorizationStatus !== 'Declined' && !s.deferredDate
      )
      const sum = (key: string) => counted.reduce((a, s) => a + (s[key] as number), 0)
      const n = String(order.number)
      expect(order.laborCents, n).toBe(sum('calculatedLaborCents'))
      expect(order.partsCents, n).toBe(sum('calculatedPartsCents'))
      expect(order.tiresCents, n).toBe(sum('calculatedTiresCents'))
      expect(order.subcontractsCents, n).toBe(sum('calculatedSubcontractsCents'))
      expect(order.feesCents, n).toBe(sum('calculatedFeeCents'))
      expect(order.taxCents, n).toBe(sum('calculatedTaxCents'))
      const subtotal =
        (order.laborCents as number) +
        (order.partsCents as number) +
        (order.tiresCents as number) +
        (order.subcontractsCents as number) +
        (order.feesCents as number) +
        (order.epaCents as number) +
        (order.shopSuppliesCents as number)
      expect(order.totalCostCents, n).toBe(
        subtotal - (order.discountCents as number) + (order.taxCents as number)
      )
    }
  })

  it('cover the cases the importer must handle', () => {
    const orders = fixtures.get('order')?.records ?? []
    const services = fixtures.get('order_service')?.records ?? []
    const payments = fixtures.get('payment')?.records ?? []
    expect(new Set(orders.map((o) => o.status))).toEqual(
      new Set(['Estimate', 'RepairOrder', 'Invoice'])
    )
    expect(orders.some((o) => o.deleted === true)).toBe(true)
    expect(services.some((s) => s.authorizationStatus === 'Declined')).toBe(true)
    expect(services.some((s) => s.deferredDate)).toBe(true)
    expect(services.some((s) => (s.calculatedEpaCents as number) > 0)).toBe(true)
    expect(services.some((s) => (s.calculatedShopSuppliesCents as number) > 0)).toBe(true)
    expect(services.some((s) => (s.fees as unknown[]).length > 0)).toBe(true)
    expect(services.some((s) => (s.tires as unknown[]).length > 0)).toBe(true)
    expect(services.some((s) => (s.subcontracts as unknown[]).length > 0)).toBe(true)
    expect(payments.some((p) => p.transactionType === 'Refund')).toBe(true)
    expect(payments.some((p) => p.deposit === true)).toBe(true)
    expect(payments.some((p) => p.status !== 'Succeeded')).toBe(true)
    // A complex order: several services, a fee, a discount, a partial payment and a refund.
    const complex = orders.find((o) => {
      const svcs = services.filter((s) => s.orderId === o.id)
      const pays = payments.filter((p) => p.orderId === o.id)
      const anyDiscount = svcs.some((s) =>
        (s.labors as { discountCents: number }[]).some((l) => l.discountCents > 0)
      )
      return (
        svcs.length >= 3 &&
        svcs.some((s) => (s.fees as unknown[]).length > 0) &&
        anyDiscount &&
        pays.some((p) => p.transactionType === 'Refund') &&
        (o.remainingCostCents as number) > 0 &&
        (o.paidCostCents as number) > 0
      )
    })
    expect(complex?.number).toBeDefined()
  })
})
