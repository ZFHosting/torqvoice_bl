/**
 * fork: the importer's own words are written in the workshop's language, Shopmonkey's pass through (M5; AGENTS.md
 * "Whose language").
 */
import { describe, expect, it, vi } from 'vitest'

const locale = vi.hoisted(() => ({ value: 'de' }))
// The real translator, over the setup's English-only stand-in: the point is the other languages.
vi.mock('next-intl', async (importOriginal) => await importOriginal())
vi.mock('@/i18n/locale-from-request', () => ({
  resolveDocumentLocale: async () => locale.value,
}))

import { IMPORT_LABELS, importLabeler } from '@/integrations/shopmonkey/load/labels'

describe('the words a load writes', () => {
  it('are in the workshop’s language', async () => {
    locale.value = 'de'
    const label = await importLabeler('org-1')
    expect(label('Customer type')).toBe('Kundentyp')
    expect(label('Fleet')).toBe('Flotte')
    expect(label('Original Shopmonkey invoice')).toBe('Originalrechnung aus Shopmonkey')
    expect(label('Shopmonkey invoice {id}.pdf', { id: 'syn_ord_1' })).toBe(
      'Shopmonkey-Rechnung syn_ord_1.pdf'
    )
  })

  it('leave Shopmonkey’s own words as they are', async () => {
    locale.value = 'de'
    const label = await importLabeler('org-1')
    expect(label('Waiting on parts')).toBe('Waiting on parts')
  })

  it('read in English exactly as the transforms write them', async () => {
    locale.value = 'en'
    const label = await importLabeler('org-1')
    for (const english of Object.keys(IMPORT_LABELS)) {
      expect(label(english, { id: '{id}' })).toBe(english)
    }
  })
})
