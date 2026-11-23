/**
 * @vitest-environment node
 *
 * fork: Shopmonkey's cents to Torqvoice's amounts (M2, MAPPING §6).
 */
import { describe, expect, it } from 'vitest'
import { centsToAmount } from '@/integrations/shopmonkey/money'

describe('centsToAmount', () => {
  it.each([
    [12345, 123.45],
    [1, 0.01],
    [99, 0.99],
    [100, 1],
    [0, 0],
    [-2500, -25],
    [-1, -0.01],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER / 100],
  ])('%d cents is %d', (cents, amount) => {
    expect(centsToAmount(cents)).toBe(amount)
  })

  it('treats missing or broken values as nothing', () => {
    expect(centsToAmount(null)).toBe(0)
    expect(centsToAmount(undefined)).toBe(0)
    expect(centsToAmount(Number.NaN)).toBe(0)
    expect(centsToAmount(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('rounds a stray fraction of a cent, and never gives negative zero', () => {
    expect(centsToAmount(10.6)).toBe(0.11)
    expect(Object.is(centsToAmount(-0.4), 0)).toBe(true)
  })
})
