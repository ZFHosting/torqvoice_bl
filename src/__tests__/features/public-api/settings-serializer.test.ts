/**
 * @vitest-environment node
 *
 * fork: `GET /api/v1/settings`'s serializer (docs/fork/API.md §4): every answer fits the published
 * schema, defaults stand in for settings never saved, and only the allowlisted keys are read.
 */
import { describe, expect, it } from 'vitest'
import { settingsResponseSchema } from '@/features/public-api/Schema/settings'
import { SETTINGS_KEYS, serializeSettings } from '@/features/public-api/Serializers/settings'

describe('the settings serializer', () => {
  it('answers a workshop that never saved a setting with the defaults', () => {
    const body = serializeSettings({}, 'UTC')
    expect(settingsResponseSchema.parse(body)).toEqual(body)
    expect(body).toMatchObject({
      currency: 'USD',
      timeZone: 'UTC',
      unitSystem: 'metric',
      tax: {
        enabled: true,
        rate: 0,
        inclusive: false,
        label: null,
        components: null,
        appliesTo: { parts: true, labor: true, shopFees: true },
      },
      defaultLaborRate: null,
      numbering: { format: '{year}-', startNumber: null },
    })
  })

  it('carries a split tax, a selective one and the numbering as the workshop set them', () => {
    const body = serializeSettings(
      {
        'workshop.currencyCode': 'CAD',
        'workshop.unitSystem': 'imperial',
        'workshop.taxMode': 'split',
        'workshop.defaultTaxRate': '14.975',
        'workshop.taxComponents': JSON.stringify([
          { name: 'GST', rate: 5, registrationNumber: '123456789RT0001' },
          { name: 'QST', rate: 9.975 },
        ]),
        'workshop.taxSelective': 'true',
        'workshop.taxAppliesToLabor': 'false',
        'workshop.taxLabel': 'Taxes',
        'workshop.defaultLaborRate': '120.456',
        'workshop.invoicePrefix': '',
        'workshop.invoiceStartNumber': ' 5001 ',
      },
      'America/Toronto'
    )
    expect(settingsResponseSchema.parse(body)).toEqual(body)
    expect(body.tax.components).toEqual([
      { name: 'GST', rate: 5, compound: false, registrationNumber: '123456789RT0001' },
      { name: 'QST', rate: 9.975, compound: false, registrationNumber: null },
    ])
    expect(body.tax.appliesTo).toEqual({ parts: true, labor: false, shopFees: true })
    expect(body.defaultLaborRate).toBe(120.46)
    // An empty format is what the importer leaves (MAPPING §9), not "use the default".
    expect(body.numbering).toEqual({ format: '', startNumber: '5001' })
    expect(body.unitSystem).toBe('imperial')
  })

  it('leaves out a labor rate that is not a number, and a tax that is switched off', () => {
    const body = serializeSettings(
      { 'workshop.defaultLaborRate': 'about 90', 'workshop.taxEnabled': 'false' },
      'UTC'
    )
    expect(settingsResponseSchema.parse(body)).toEqual(body)
    expect(body.defaultLaborRate).toBeNull()
    expect(body.tax).toMatchObject({ enabled: false, rate: 0, components: null })
  })

  it('reads only workshop display settings, never a secret', () => {
    for (const key of SETTINGS_KEYS) expect(key).toMatch(/^workshop\./)
    const body = serializeSettings(
      { 'payment.stripe.secretKey': 'sk_live_sentinel', 'license.token': 'sentinel' },
      'UTC'
    )
    expect(JSON.stringify(body)).not.toContain('sentinel')
  })
})
