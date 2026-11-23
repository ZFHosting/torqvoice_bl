'use server'

import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the bodies and their audit events live beside the draft service (A2)
import {
  createDraftCounterSaleEvent,
  createDraftServiceRecordEvent,
} from '../Lib/serviceRecordAuditEvents'
import {
  createDraftCounterSaleService,
  createDraftServiceRecordService,
} from '../Lib/draftServiceRecordService.server'

export async function createDraftServiceRecord(
  vehicleId: string,
  startDateTime?: Date,
  endDateTime?: Date,
  technicianId?: string,
  workBayId?: string,
  /** The day the job is wanted, when no time was given; see createDraftRecord. */
  bookFrom?: Date
) {
  return withAuth(
    // fork: the body is createDraftServiceRecordService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createDraftServiceRecordService(
        { organizationId, userId, actor: 'user' },
        vehicleId,
        startDateTime,
        endDateTime,
        technicianId,
        workBayId,
        bookFrom
      ),
    {
      requiredPermissions: [
        {
          action: PermissionAction.CREATE,
          subject: PermissionSubject.SERVICES,
        },
      ],
      audit: ({ result }) => createDraftServiceRecordEvent(result),
    }
  )
}

export async function createDraftCounterSale(customerId: string) {
  return withAuth(
    // fork: the body is createDraftCounterSaleService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createDraftCounterSaleService({ organizationId, userId, actor: 'user' }, customerId),
    {
      requiredPermissions: [
        {
          action: PermissionAction.CREATE,
          subject: PermissionSubject.SERVICES,
        },
      ],
      audit: ({ result }) => createDraftCounterSaleEvent(result),
    }
  )
}
