/**
 * Workshop settings → the `/settings` response, field by field (docs/fork/API.md §1.2). The settings
 * table also holds payment secrets and licence tokens, so only the keys named in SETTINGS_KEYS are
 * ever read, and nothing reaches the response that isn't built here.
 */
import { SETTING_KEYS } from '@/features/settings/Schema/settingsSchema'
import { readWorkshopTax, WORKSHOP_TAX_SETTING_KEYS } from '@/features/settings/Lib/workshopTax'
import { resolveCurrencyCode } from '@/lib/currencies'
import { DEFAULT_JOB_NUMBER_FORMAT } from '@/lib/job-number'
import type { SettingsResponse } from '../Schema/settings'

/** Every key the serializer reads; the route loads these and no others. */
export const SETTINGS_KEYS = [
  SETTING_KEYS.CURRENCY_CODE,
  SETTING_KEYS.UNIT_SYSTEM,
  SETTING_KEYS.TAX_LABEL,
  SETTING_KEYS.DEFAULT_LABOR_RATE,
  SETTING_KEYS.INVOICE_PREFIX,
  SETTING_KEYS.INVOICE_START_NUMBER,
  ...WORKSHOP_TAX_SETTING_KEYS,
] as const

const round2 = (value: number) => Math.round(value * 100) / 100

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function serializeSettings(
  settings: Record<string, string | undefined>,
  timeZone: string
): SettingsResponse {
  const tax = readWorkshopTax(settings)
  const startNumber = settings[SETTING_KEYS.INVOICE_START_NUMBER]?.trim()
  return {
    currency: resolveCurrencyCode(settings[SETTING_KEYS.CURRENCY_CODE]),
    timeZone,
    unitSystem: settings[SETTING_KEYS.UNIT_SYSTEM] === 'imperial' ? 'imperial' : 'metric',
    tax: {
      enabled: tax.enabled,
      rate: tax.rate,
      inclusive: tax.inclusive,
      label: settings[SETTING_KEYS.TAX_LABEL] || null,
      components:
        tax.components?.map((c) => ({
          name: c.name,
          rate: c.rate,
          compound: c.compound === true,
          registrationNumber: c.registrationNumber || null,
        })) ?? null,
      appliesTo: {
        parts: tax.applies.parts,
        labor: tax.applies.labor,
        shopFees: tax.applies.shopFee,
      },
    },
    defaultLaborRate: (() => {
      const rate = numberOrNull(settings[SETTING_KEYS.DEFAULT_LABOR_RATE])
      return rate === null ? null : round2(rate)
    })(),
    numbering: {
      format: settings[SETTING_KEYS.INVOICE_PREFIX] ?? DEFAULT_JOB_NUMBER_FORMAT,
      startNumber: startNumber ? startNumber : null,
    },
  }
}
