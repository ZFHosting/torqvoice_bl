import { publicApiError, publicApiOk } from '@/features/public-api/Lib/errors'
import { withPublicApi } from '@/features/public-api/Lib/withPublicApi'
import {
  CONTACT_ORDER,
  CONTACT_SELECT,
  serializeContact,
} from '@/features/public-api/Serializers/customers'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/v1/customers/{id}/contacts` (docs/fork/API.md §4): a customer's emails and phones beyond the primary
 * ones (X4). The customer is checked to be the key's workshop's first: another workshop's id is a 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPublicApi(
    request,
    async ({ organizationId }) => {
      const { id } = await params
      const customer = await db.customer.findFirst({
        where: { id, organizationId },
        select: { id: true },
      })
      if (!customer) return publicApiError(404, 'not_found', 'Not found.')
      const contacts = await db.customerContact.findMany({
        where: { customerId: customer.id, organizationId },
        select: CONTACT_SELECT,
        orderBy: [...CONTACT_ORDER],
      })
      return publicApiOk(contacts.map(serializeContact))
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}
