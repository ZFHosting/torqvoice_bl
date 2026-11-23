/**
 * Payments (MAPPING §6.5): one Torqvoice `Payment` per succeeded Shopmonkey payment on an order that
 * loaded as a work order. Refunds are negative; a charge's own `refundedAmountCents` is archive only, so
 * a refund is never counted twice. `externalId` + `provider: "shopmonkey"` make reruns safe.
 */
import { centsToAmount } from '../money'
import { date, type FieldSpec, num, str, unmappedFields, warn } from './fields'
import type { Row, TransformContext, TransformResult, Warning } from './types'

export const PAYMENT_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'orderId',
    'amountCents',
    'transactionType',
    'chargeId',
    'recordedDate',
    'createdDate',
    'paymentType',
    'checkNumber',
    'cardDigits',
    'note',
    'status',
    'deposit',
    'refundReason',
  ],
  archive: [
    'bulkPaymentId',
    'companyId',
    'locationId',
    'metadata',
    'paymentMode',
    'provider',
    'receiptNumber',
    'refunded',
    'refundedAmountCents',
    'statementId',
    'updatedDate',
  ],
}

export interface PaymentRow {
  amount: number
  date: Date
  method: 'cash' | 'card' | 'transfer' | 'other'
  note: string | null
  provider: 'shopmonkey'
  externalId: string
  serviceRecordId: string
}

const TRANSFER = new Set(['ACH', 'Zelle', 'Interac', 'Venmo', 'PayPal'])

export function paymentMethod(type: string | null): PaymentRow['method'] {
  if (type === 'Cash') return 'cash'
  if (type === 'Card') return 'card'
  if (type && TRANSFER.has(type)) return 'transfer'
  return 'other'
}

/**
 * The order's payments. Null rows (with no warning) for one that isn't imported: not succeeded, or on an
 * order that didn't load as a work order (an estimate, a deleted order).
 */
export function transformPayment(
  payment: Row,
  ctx: TransformContext
): TransformResult<PaymentRow | null> {
  const remoteId = String(payment.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(payment, PAYMENT_FIELDS)
  if (payment.status !== 'Succeeded') return { rows: null, warnings, unmapped }
  // §6.5 covers charges and refunds. Anything else (a dispute, a transfer) isn't money in or out of the
  // order the way a payment is: kept in the archive, and said so.
  if (payment.transactionType !== 'Charge' && payment.transactionType !== 'Refund') {
    warnings.push(
      warn(
        'payment',
        remoteId,
        'payment_type_unsupported',
        `A ${String(payment.transactionType)} is kept in the archive only`,
        'transactionType'
      )
    )
    return { rows: null, warnings, unmapped }
  }
  const paidOn = date(payment.recordedDate) ?? date(payment.createdDate)
  if (!paidOn) {
    warnings.push(
      warn('payment', remoteId, 'payment_missing_date', 'No payment date', 'recordedDate')
    )
    return { rows: null, warnings, unmapped }
  }
  const orderId = str(payment.orderId)
  const serviceRecordId = orderId ? ctx.resolve('order', orderId) : null
  if (!serviceRecordId) {
    warnings.push(
      warn(
        'payment',
        remoteId,
        'payment_order_not_loaded',
        'Its order is not a loaded work order',
        'orderId'
      )
    )
    return { rows: null, warnings, unmapped }
  }

  const refund = payment.transactionType === 'Refund'
  const cents = num(payment.amountCents) ?? 0
  // PROVISIONAL(M0:S5): refunds look stored negative already; -abs is right either way.
  const amount = centsToAmount(refund ? -Math.abs(cents) : cents)
  const type = str(payment.paymentType)
  const parts = [
    refund ? `Refund${str(payment.chargeId) ? ` of ${str(payment.chargeId)}` : ''}` : null,
    payment.deposit === true ? 'Deposit' : null,
    `Shopmonkey: ${type ?? 'unknown'}`,
    str(payment.checkNumber) ? `check ${str(payment.checkNumber)}` : null,
    str(payment.cardDigits) ? `card ending ${str(payment.cardDigits)}` : null,
    refund && str(payment.refundReason) ? `reason: ${str(payment.refundReason)}` : null,
    str(payment.note),
  ].filter((part): part is string => !!part)

  return {
    rows: {
      amount,
      date: paidOn,
      method: paymentMethod(type),
      note: parts.join(' · '),
      provider: 'shopmonkey',
      externalId: remoteId,
      serviceRecordId,
    },
    warnings,
    unmapped,
  }
}

/**
 * An order whose refunds bring what was paid to zero or below shows unpaid with its whole total due in
 * upstream Torqvoice (RESULTS T2): the reconciliation report lists it.
 */
export function refundWarnings(orderId: string, payments: PaymentRow[]): Warning[] {
  const hasRefund = payments.some((p) => p.amount < 0)
  const net = payments.reduce((sum, p) => sum + Math.round(p.amount * 100), 0)
  return hasRefund && net <= 0
    ? [warn('order', orderId, 'refund_net_nonpositive', `Net paid ${net / 100} after refunds`)]
    : []
}
