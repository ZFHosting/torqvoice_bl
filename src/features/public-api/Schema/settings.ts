/**
 * `GET /api/v1/settings` (docs/fork/API.md §4): the workshop facts an integration needs to read
 * every other resource right: its currency, time zone, units, tax setup, default labor rate and
 * job numbering.
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'

export const settingsTaxComponentSchema = z
  .object({
    name: z.string().describe('Printed on the invoice, e.g. GST'),
    rate: z.number().describe('Percent'),
    compound: z.boolean().describe('Charged on the price plus the taxes listed before it'),
    registrationNumber: z.string().nullable(),
  })
  .meta({ id: 'SettingsTaxComponent' })

export const settingsResponseSchema = z
  .object({
    currency: z.string().describe('ISO 4217 code every amount is in'),
    timeZone: z.string().describe('IANA zone the workshop works in'),
    unitSystem: z.enum(['metric', 'imperial']),
    tax: z.object({
      enabled: z.boolean(),
      rate: z
        .number()
        .describe('Default rate in percent; the components’ combined rate when split'),
      inclusive: z.boolean().describe('Prices include tax'),
      label: z.string().nullable(),
      components: z
        .array(settingsTaxComponentSchema)
        .nullable()
        .describe('Set only when the workshop splits its tax'),
      appliesTo: z
        .object({ parts: z.boolean(), labor: z.boolean(), shopFees: z.boolean() })
        .describe('Which kinds of line a new line is taxed for'),
    }),
    defaultLaborRate: z.number().nullable(),
    numbering: z.object({
      format: z
        .string()
        .describe('Prefix of new job numbers; {year} and {month} are the workshop’s own date'),
      startNumber: z.string().nullable().describe('Where the running number starts when set'),
    }),
  })
  .meta({ id: 'Settings' })

export type SettingsResponse = z.infer<typeof settingsResponseSchema>

export const settingsEndpoints: EndpointSpec[] = [
  {
    method: 'get',
    path: '/settings',
    summary: 'The workshop’s currency, time zone, tax setup, labor rate and numbering',
    tag: 'Settings',
    response: settingsResponseSchema,
  },
]
