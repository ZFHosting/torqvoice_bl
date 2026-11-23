/**
 * fork: a quote re-totalled from its stored lines (A4), as `retotalServiceRecord` does a work order: the lines a
 * customer is still offered (not `excluded`), the quote's discount rule and tax settings, through the same
 * `discountAmountFor` and `documentTotals` the editor and the work order use. The public API calls it after a quote
 * write that sends lines or money, so a quote's total always matches its lines. A percentage shop fee line is not
 * re-priced here (the quote editor does that); its stored total counts like any line's.
 */
import 'server-only'
import { documentTotals } from '@/features/settings/Lib/workshopTax'
import { db, type TxClient } from '@/lib/db'
import { roundMoney } from '@/lib/money'
import { discountAmountFor } from '@/lib/tax'

export async function retotalQuote(quoteId: string, tx: TxClient | typeof db = db): Promise<void> {
  const quote = await tx.quote.findUnique({
    where: { id: quoteId },
    select: {
      discountType: true,
      discountValue: true,
      taxRate: true,
      taxInclusive: true,
      taxComponents: true,
    },
  })
  if (!quote) return
  const offered = { quoteId, excluded: false }
  const [parts, labor, taxableParts, taxableLabor] = await Promise.all([
    tx.quotePart.aggregate({ where: offered, _sum: { total: true } }),
    tx.quoteLabor.aggregate({ where: offered, _sum: { total: true } }),
    tx.quotePart.aggregate({ where: { ...offered, taxable: true }, _sum: { total: true } }),
    tx.quoteLabor.aggregate({ where: { ...offered, taxable: true }, _sum: { total: true } }),
  ])
  const subtotal = (parts._sum.total || 0) + (labor._sum.total || 0)
  const discountAmount = discountAmountFor(subtotal, quote.discountType, quote.discountValue)
  const { taxAmount, totalAmount, taxComponents, taxableSubtotal } = documentTotals({
    subtotal,
    discountAmount,
    taxRate: quote.taxRate,
    taxInclusive: quote.taxInclusive,
    taxComponents: quote.taxComponents,
    taxableSubtotal: roundMoney((taxableParts._sum.total || 0) + (taxableLabor._sum.total || 0)),
  })
  await tx.quote.update({
    where: { id: quoteId },
    data: { subtotal, discountAmount, taxAmount, totalAmount, taxComponents, taxableSubtotal },
  })
}
