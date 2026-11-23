/**
 * A work order's or a quote's body as the public API takes it (docs/fork/API.md §3.1, "Totals"). The app's editor
 * works the totals out in the browser and sends them with the lines; an API client sends the lines, and the totals
 * are worked out here and after the write, so a document's total always matches what it lists:
 *
 * - The document's own totals (`subtotal`, `taxAmount`, `totalAmount`, `taxableSubtotal`, `discountAmount`) are
 *   refused: they follow from the lines, `discountType`/`discountValue` and the tax settings.
 * - Each line's `total` is its quantity × unit price (a part) or hours × rate (labor), to the cent; one sent that
 *   says otherwise is refused, and one left out is filled in.
 *
 * Anything else is passed on as sent, for the service to validate.
 */
import 'server-only'
import { roundMoney } from '@/lib/money'

const COMPUTED = [
  'subtotal',
  'taxAmount',
  'totalAmount',
  'taxableSubtotal',
  'discountAmount',
] as const

/** What makes a document's totals change: its lines, its discount, its tax. */
const MONEY_INPUTS = [
  'partItems',
  'laborItems',
  'discountType',
  'discountValue',
  'taxRate',
  'taxInclusive',
  'taxComponents',
] as const

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function withLineTotals(
  items: unknown,
  path: string,
  quantityKey: 'quantity' | 'hours',
  priceKey: 'unitPrice' | 'rate',
  quantityDefault: number
): unknown {
  if (!Array.isArray(items)) return items
  return items.map((item, index) => {
    if (!isObject(item)) return item
    const quantity = Number(item[quantityKey] ?? quantityDefault)
    const price = Number(item[priceKey] ?? 0)
    // Not numbers: the service's schema says so.
    if (!Number.isFinite(quantity) || !Number.isFinite(price)) return item
    const total = roundMoney(quantity * price)
    if (item.total !== undefined && item.total !== null) {
      const sent = Number(item.total)
      if (!Number.isFinite(sent) || Math.abs(sent - total) >= 0.005) {
        throw new Error(
          `${path}[${index}].total is ${String(item.total)}, but ${quantityKey} × ${priceKey} is ${total}`
        )
      }
    }
    return { ...item, total }
  })
}

/** The body with its line totals filled in; a 400 (a plain Error) for a total that is worked out, not sent. */
export function documentBody(body: unknown): unknown {
  if (!isObject(body)) return body
  const sent = COMPUTED.filter((key) => body[key] !== undefined)
  if (sent.length) {
    throw new Error(
      `${sent.join(', ')} ${sent.length === 1 ? 'is' : 'are'} worked out from the lines, the discount and the tax: send those instead`
    )
  }
  const out: Record<string, unknown> = { ...body }
  if (body.partItems !== undefined) {
    out.partItems = withLineTotals(body.partItems, 'partItems', 'quantity', 'unitPrice', 1)
  }
  if (body.laborItems !== undefined) {
    out.laborItems = withLineTotals(body.laborItems, 'laborItems', 'hours', 'rate', 0)
  }
  return out
}

/** Whether a change touches what the totals follow from, so the document is re-totalled after it. */
export function touchesMoney(body: unknown): boolean {
  return isObject(body) && MONEY_INPUTS.some((key) => body[key] !== undefined)
}
