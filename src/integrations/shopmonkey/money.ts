/**
 * Shopmonkey keeps money as integer cents (`totalCents`, `priceCents`, ...); Torqvoice keeps major
 * units as a decimal number (src/lib/money.ts). One conversion, rounded to 2 places, used by every
 * transform so a total can't drift by a cent between two of them.
 */
/**
 * Shopmonkey's subtotal of an order, in cents: the per-category cents of the services that count (MAPPING §6.1). The
 * load and the reconciliation read it the same way. PROVISIONAL(M0:S5).
 */
export function orderSubtotalCents(order: Record<string, unknown>): number {
  const cents = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
    return Number.isFinite(n) ? Math.round(n) : 0
  }
  return (
    cents(order.laborCents) +
    cents(order.partsCents) +
    cents(order.tiresCents) +
    cents(order.subcontractsCents) +
    cents(order.feesCents) +
    cents(order.epaCents) +
    cents(order.shopSuppliesCents)
  )
}

export function centsToAmount(cents: number | null | undefined): number {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 0
  // Shopmonkey sends whole cents; rounding first means a stray fraction never reaches a total.
  const amount = Math.round(cents) / 100
  // No negative zero: -0.4 cents rounds to -0, which prints as "-0.00".
  return amount === 0 ? 0 : amount
}
