/**
 * Shopmonkey keeps money as integer cents (`totalCents`, `priceCents`, ...); Torqvoice keeps major
 * units as a decimal number (src/lib/money.ts). One conversion, rounded to 2 places, used by every
 * transform so a total can't drift by a cent between two of them.
 */
export function centsToAmount(cents: number | null | undefined): number {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 0
  // Shopmonkey sends whole cents; rounding first means a stray fraction never reaches a total.
  const amount = Math.round(cents) / 100
  // No negative zero: -0.4 cents rounds to -0, which prints as "-0.00".
  return amount === 0 ? 0 : amount
}
