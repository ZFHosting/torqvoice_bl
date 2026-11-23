import type { ConnectorManifest } from '@/features/integrations/Lib/types'

/**
 * fork: Shopmonkey, imported from (docs/fork/PLAN.md). A workshop moving off Shopmonkey connects it
 * with an API key made by a Shopmonkey admin (Settings → Integration → API Keys); the importer only
 * ever reads (the client refuses anything else). Self-hosted only: the import is run by whoever runs
 * the install, and the archive it keeps can be large.
 */
export const manifest: ConnectorManifest = {
  id: 'shopmonkey',
  name: 'Shopmonkey',
  category: 'other',
  countries: 'global',
  logo: '/images/integrations/shopmonkey.svg',
  docs: '/docs/integrations/shopmonkey',
  selfHostedOnly: true,
  auth: {
    type: 'api-key',
    fields: [
      { key: 'apiKey', label: 'apiKey', type: 'password', required: true, help: 'apiKeyHelp' },
    ],
  },
  capabilities: ['import.shopmonkey'],
  settings: [
    {
      key: 'locationId',
      type: 'remote-select',
      label: 'locationId',
      help: 'locationIdHelp',
      source: 'locations',
      required: true,
    },
    {
      key: 'includeFiles',
      type: 'boolean',
      label: 'includeFiles',
      help: 'includeFilesHelp',
      default: true,
    },
    {
      key: 'downloadInvoicePdfs',
      type: 'select',
      label: 'downloadInvoicePdfs',
      help: 'downloadInvoicePdfsHelp',
      // B5: the default until BlueLabel says otherwise.
      default: 'last2years',
      options: [
        { value: 'none', label: 'downloadInvoicePdfsNone' },
        { value: 'last2years', label: 'downloadInvoicePdfsLast2Years' },
        { value: 'all', label: 'downloadInvoicePdfsAll' },
      ],
    },
    {
      key: 'includeMessages',
      type: 'boolean',
      label: 'includeMessages',
      help: 'includeMessagesHelp',
      // B4: message history stays in the archive until BlueLabel asks for it.
      default: false,
    },
    { key: 'historyFrom', type: 'date', label: 'historyFrom', help: 'historyFromHelp' },
  ],
}
