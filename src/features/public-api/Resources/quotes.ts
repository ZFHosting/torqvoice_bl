/** `/api/v1/quotes`: how it reads (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { customFieldsOf } from '../Lib/customFields.server'
import type { ReadResource } from '../Lib/readResource'
import { type QuoteOut, quotesSpec } from '../Schema/quotes'
import { type QuoteRow, quoteSelect, serializeQuote } from '../Serializers/quotes'

export const quotesResource: ReadResource<QuoteRow, QuoteOut> = {
  ...quotesSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.QUOTES },
  scope: (organizationId) => ({ organizationId }),
  where: ({ status, customerId, vehicleId }) => ({
    ...(typeof status === 'string' ? { status } : {}),
    ...(typeof customerId === 'string' ? { customerId } : {}),
    ...(typeof vehicleId === 'string' ? { vehicleId } : {}),
  }),
  select: quoteSelect,
  findMany: (args) => db.quote.findMany(args as never) as unknown as Promise<QuoteRow[]>,
  findFirst: (args) => db.quote.findFirst(args as never) as unknown as Promise<QuoteRow | null>,
  expand: async (rows, ctx, includes) =>
    includes.has('customFields')
      ? customFieldsOf(
          ctx.organizationId,
          'quote',
          rows.map((r) => r.id)
        )
      : new Map(),
  serialize: (row, ctx, includes, extra) => serializeQuote(row, ctx, includes, extra),
}
