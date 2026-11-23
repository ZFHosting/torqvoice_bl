'use server'

import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the body lives in the attachment service (A2)
import { addServiceAttachmentService } from '../Lib/serviceAttachmentService.server'

export async function addServiceAttachment(input: unknown) {
  return withAuth(
    // fork: the body is addServiceAttachmentService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      addServiceAttachmentService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        {
          action: PermissionAction.UPDATE,
          subject: PermissionSubject.SERVICES,
        },
      ],
    }
  )
}
