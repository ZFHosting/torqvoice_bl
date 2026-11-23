/**
 * The words the importer writes itself (the transforms' English labels: custom fields it makes, the original
 * invoice's description), in the workshop's language: the workshop and its customers read them, so they follow
 * `resolveDocumentLocale`, never the language of whoever runs the import (AGENTS.md, "Whose language"). Shopmonkey's
 * own words (its custom field names, statuses, notes) pass through unchanged. Strings in
 * `messages/<locale>/integrations.json` under `shopmonkeyImport`.
 */
import { organizationTranslator } from '@/i18n/organization-translator'
import type { Labeler } from './context'

/** English as the transforms and the loader write it → its key under `shopmonkeyImport`. */
export const IMPORT_LABELS: Record<string, string> = {
  'Customer type': 'customerType',
  Fleet: 'fleet',
  Labels: 'labels',
  'Referral source': 'referralSource',
  'Original Shopmonkey invoice': 'originalInvoice',
  'Shopmonkey invoice {id}.pdf': 'invoiceFileName',
  'Shopmonkey import': 'importName',
  EPA: 'epa',
  'Shop supplies': 'shopSupplies',
  Deferred: 'deferred',
  'Deferred ({reason})': 'deferredBecause',
  Refund: 'refund',
  'Refund of {charge}': 'refundOf',
  Deposit: 'deposit',
  'Shopmonkey: {type}': 'paymentType',
  unknown: 'unknownType',
  'check {number}': 'checkNumber',
  'card ending {digits}': 'cardEnding',
  'reason: {reason}': 'refundReason',
  'Shopmonkey note': 'vehicleNote',
  'Shopmonkey customer {id}': 'unnamedCustomer',
}

export async function importLabeler(organizationId: string): Promise<Labeler> {
  const t = await organizationTranslator(organizationId, 'integrations')
  return (english, values) => {
    const key = IMPORT_LABELS[english]
    if (!key) return english.replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? '')
    return t(`shopmonkeyImport.${key}`, values)
  }
}
