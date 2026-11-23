/** `/api/v1/customers`: how it reads (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { customFieldsOf } from '../Lib/customFields.server'
import type { ReadResource } from '../Lib/readResource'
import { type CustomerOut, customersSpec } from '../Schema/customers'
import { type CustomerRow, customerSelect, serializeCustomer } from '../Serializers/customers'

export const customersResource: ReadResource<CustomerRow, CustomerOut> = {
  ...customersSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
  scope: (organizationId) => ({ organizationId }),
  where: ({ q }) => {
    if (typeof q !== 'string') return {}
    return {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { company: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { customerNumber: { equals: q } },
        { contacts: { some: { value: { contains: q, mode: 'insensitive' } } } },
      ],
    }
  },
  select: customerSelect,
  findMany: (args) => db.customer.findMany(args as never) as unknown as Promise<CustomerRow[]>,
  findFirst: (args) =>
    db.customer.findFirst(args as never) as unknown as Promise<CustomerRow | null>,
  expand: async (rows, ctx, includes) =>
    includes.has('customFields')
      ? customFieldsOf(
          ctx.organizationId,
          'customer',
          rows.map((r) => r.id)
        )
      : new Map(),
  serialize: (row, _ctx, includes, extra) => serializeCustomer(row, includes, extra),
}
