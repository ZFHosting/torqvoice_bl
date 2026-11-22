/**
 * @vitest-environment node
 *
 * `sourceExtra` (fork column on line items, docs/fork/MAPPING.md X3) is read leniently, like the
 * upstream JSON columns: a page must never break on an odd value an older import wrote.
 */
import { describe, expect, it } from 'vitest'
import {
  LINE_KINDS,
  readLaborSourceExtra,
  readPartSourceExtra,
} from '@/integrations/shopmonkey/schema/sourceExtra'

describe('sourceExtra', () => {
  it('reads what a Shopmonkey labor or fee line keeps, and passes unknown keys through', () => {
    const extra = readLaborSourceExtra({
      source: 'shopmonkey',
      remoteId: 'lab_1',
      multiplier: 1.5,
      multiplierType: 'Hours',
      feeType: 'PercentService',
      percent: 2,
      somethingNew: { kept: true },
    })
    expect(extra.multiplier).toBe(1.5)
    expect(extra.feeType).toBe('PercentService')
    expect((extra as Record<string, unknown>).somethingNew).toEqual({ kept: true })
  })

  it('reads tire and subcontract fields on a part line', () => {
    const extra = readPartSourceExtra({
      sku: 'AS2254517',
      size: '225/45R17',
      tireIdentificationNumbers: ['TIN1', 'TIN2'],
      federalExciseTaxCents: 0,
      costCents: 6000,
    })
    expect(extra.tireIdentificationNumbers).toEqual(['TIN1', 'TIN2'])
    expect(extra.costCents).toBe(6000)
  })

  it('reads a malformed or missing value as empty instead of throwing', () => {
    expect(readLaborSourceExtra(null)).toEqual({})
    expect(readLaborSourceExtra('not json')).toEqual({})
    expect(readPartSourceExtra({ tireIdentificationNumbers: 'TIN1' })).toEqual({})
    expect(readPartSourceExtra([1, 2])).toEqual({})
  })

  it('names every line kind MAPPING §6.2 uses', () => {
    expect(LINE_KINDS).toEqual([
      'labor',
      'fee',
      'epa',
      'shopSupplies',
      'part',
      'tire',
      'subcontract',
    ])
  })
})
