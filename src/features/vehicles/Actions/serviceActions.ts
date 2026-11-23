'use server'

// fork: the write bodies and their audit events live beside the service record service (A2)
import {
  createServiceRecordEvent,
  deleteServiceRecordEvent,
  updateInternalNotesEvent,
  updateServiceRecordEvent,
  updateServiceRecordTitleEvent,
  updateServiceStatusEvent,
} from '../Lib/serviceRecordAuditEvents'
import {
  createServiceRecordService,
  deleteServiceAttachmentService,
  deleteServiceRecordService,
  generatePublicLinkService,
  revokePublicLinkService,
  toggleManuallyPaidService,
  updateInternalNotesService,
  updateServiceRecordService,
  updateServiceRecordTitleService,
  updateServiceStatusService,
} from '../Lib/serviceRecordService.server'
import { gateFleetNumber, isFleetNumberEnabled } from '@/features/vehicles/Lib/fleetNumberSetting'
import {
  gateCustomerReference,
  gatePoRequired,
  isCustomerReferenceEnabled,
} from '@/features/customer-reference/Lib/referenceSetting'
import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { endOfWorkshopDay } from '@/lib/workshop-datetime'
import { zonedDayKey } from '@/lib/timezone'
import { serviceDateOrderBy } from '@/lib/date-sort'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { typeKeySearch } from '@/features/vehicles/Lib/typeKeySetting'
import { ACTIVE_HELPERS } from '@/features/workboard/Lib/jobTeam'

export async function getServiceRecords(vehicleId: string) {
  return withAuth(
    async ({ organizationId }) => {
      const vehicle = await db.vehicle.findFirst({
        where: { id: vehicleId, organizationId },
      })
      if (!vehicle) throw new Error('Vehicle not found')

      return db.serviceRecord.findMany({
        where: { vehicleId },
        include: {
          _count: { select: { partItems: true, laborItems: true } },
        },
        orderBy: [{ startDateTime: { sort: 'desc', nulls: 'last' } }, { serviceDate: 'desc' }],
      })
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SERVICES }],
    }
  )
}

export async function getServiceRecordsPaginated(
  vehicleId: string,
  params: {
    page?: number
    pageSize?: number
    search?: string
    type?: string
  }
) {
  return withAuth(
    async ({ organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 10
      const skip = (page - 1) * pageSize

      const vehicle = await db.vehicle.findFirst({
        where: { id: vehicleId, organizationId },
      })
      // Deleted or foreign-org vehicle: empty result instead of an error, since
      // this runs during the post-delete re-render of the vehicle page.
      if (!vehicle) {
        return { records: [], total: 0, page, pageSize, totalPages: 0 }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { vehicleId }

      if (params.search) {
        where.OR = [
          { title: { contains: params.search, mode: 'insensitive' } },
          { description: { contains: params.search, mode: 'insensitive' } },
          { concerns: { some: { description: { contains: params.search, mode: 'insensitive' } } } },
          { diagnosticNotes: { contains: params.search, mode: 'insensitive' } },
          { techName: { contains: params.search, mode: 'insensitive' } },
          { shopName: { contains: params.search, mode: 'insensitive' } },
        ]
      }

      if (params.type && params.type !== 'all') {
        where.type = params.type
      }

      const [records, total] = await Promise.all([
        db.serviceRecord.findMany({
          where,
          include: {
            _count: { select: { partItems: true, laborItems: true, attachments: true } },
            // The first few lines of each job, so a list can say what was
            // done without anybody opening the job.
            laborItems: { take: 4, select: { description: true } },
            partItems: { take: 4, select: { name: true } },
            // The workshop's own status, drawn beside the stage in the lists.
            customStatus: { select: { name: true, color: true } },
          },
          orderBy: [{ startDateTime: { sort: 'desc', nulls: 'last' } }, { serviceDate: 'desc' }],
          skip,
          take: pageSize,
        }),
        db.serviceRecord.count({ where }),
      ])

      return {
        records,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SERVICES }],
    }
  )
}

export async function getAllServiceRecords() {
  return withAuth(
    async ({ organizationId }) => {
      return db.serviceRecord.findMany({
        where: { organizationId },
        include: {
          vehicle: { select: { make: true, model: true, year: true } },
          _count: { select: { partItems: true, laborItems: true } },
        },
        orderBy: [{ startDateTime: { sort: 'desc', nulls: 'last' } }, { serviceDate: 'desc' }],
        take: 50,
      })
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SERVICES }],
    }
  )
}

export async function getAllServiceRecordsPaginated(params: {
  page?: number
  pageSize?: number
  search?: string
  type?: string
  status?: string
}) {
  return withAuth(
    async ({ organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 20
      const skip = (page - 1) * pageSize

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { organizationId }

      if (params.search) {
        where.OR = [
          { title: { contains: params.search, mode: 'insensitive' } },
          { invoiceNumber: { contains: params.search, mode: 'insensitive' } },
          { techName: { contains: params.search, mode: 'insensitive' } },
          { vehicle: { make: { contains: params.search, mode: 'insensitive' } } },
          { vehicle: { model: { contains: params.search, mode: 'insensitive' } } },
          { vehicle: { licensePlate: { contains: params.search, mode: 'insensitive' } } },
          ...(await typeKeySearch(organizationId, params.search)).map((vehicle) => ({ vehicle })),
        ]
      }

      if (params.type && params.type !== 'all') {
        where.type = params.type
      }

      if (params.status && params.status !== 'all') {
        where.status = params.status
      }

      const [records, total] = await Promise.all([
        db.serviceRecord.findMany({
          where,
          include: {
            vehicle: {
              select: {
                id: true,
                make: true,
                model: true,
                year: true,
                licensePlate: true,
                customer: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: [{ startDateTime: { sort: 'desc', nulls: 'last' } }, { serviceDate: 'desc' }],
          skip,
          take: pageSize,
        }),
        db.serviceRecord.count({ where }),
      ])

      return {
        records,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SERVICES }],
    }
  )
}

export async function getServiceRecord(recordId: string) {
  return withAuth(
    async ({ organizationId }) => {
      const record = await db.serviceRecord.findFirst({
        where: { id: recordId, organizationId },
        include: {
          concerns: {
            orderBy: { sortOrder: 'asc' },
            include: { confirmedBy: { select: { name: true } } },
          },
          partItems: true,
          laborItems: true,
          attachments: true,
          payments: { orderBy: { date: 'desc' } },
          // Who opened the job, for the line under its number.
          createdBy: { select: { name: true } },
          // Who is on the job besides its technician.
          helpers: ACTIVE_HELPERS,
          // The inspection it was raised from, for the link beside it: the
          // photos of what is being repaired live there.
          inspection: {
            select: { id: true, createdAt: true, template: { select: { name: true } } },
          },
          // The workshop's own status, archived or not: a job keeps saying
          // what it was called after the status has left the menus.
          customStatus: { select: { id: true, name: true, color: true, stage: true } },
          // A tire job is meaningless without knowing which set and which
          // shelf, so it travels with the record rather than being fetched
          // separately by whatever screen happens to need it.
          tireSet: {
            select: {
              id: true,
              reference: true,
              season: true,
              studded: true,
              size: true,
              brand: true,
              quantity: true,
              withRims: true,
              hasTpms: true,
              status: true,
              location: { select: { code: true, warehouse: { select: { name: true } } } },
              measurements: {
                orderBy: { measuredAt: 'desc' },
                take: 8,
                // The depth too: the banner grades from the millimetres
                // rather than from the stored word.
                select: { treadDepthMm: true, condition: true },
              },
              treatments: { select: { type: true, status: true } },
            },
          },
          customer: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              address: true,
              company: true,
              telegramChatId: true,
              invoiceDesignId: true,
              customerNumber: true,
              taxId: true,
              taxExempt: true,
              reminderOptOut: true,
              poRequired: true,
              notes: true,
              createdAt: true,
            },
          },
          vehicle: {
            select: {
              id: true,
              make: true,
              model: true,
              year: true,
              vin: true,
              licensePlate: true,
              mileage: true,
              // Whose reading the vehicle's is: the reading field's notices.
              readingJobId: true,
              readingBeforeJob: true,
              // The facts card's "More info": what the desk would otherwise
              // open the vehicle page to read (and copy) mid-job.
              color: true,
              fuelType: true,
              transmission: true,
              engineSize: true,
              engineCode: true,
              hsn: true,
              tsn: true,
              fleetNumber: true,
              purchaseDate: true,
              purchasePrice: true,
              inspectionStatus: {
                select: { dueAt: true, lastAt: true, source: true, registered: true },
              },
              customer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  phone: true,
                  address: true,
                  company: true,
                  telegramChatId: true,
                  invoiceDesignId: true,
                  customerNumber: true,
                  taxId: true,
                  taxExempt: true,
                  reminderOptOut: true,
                  poRequired: true,
                  notes: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      })
      if (!record) return record

      // The quotes that became this job, for the links beside its number: the
      // one it was raised from and any added to it since. Oldest first, the
      // order they reached the job in.
      const quotes = await db.quote.findMany({
        where: { organizationId, convertedToId: record.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, quoteNumber: true, title: true },
      })

      // Without the customer's reference / PO, and without "PO required" on
      // its customer, for a workshop that has the field off: the page has no
      // box and no notice for them, so they are not sent there either.
      const referenceOn = await isCustomerReferenceEnabled(organizationId)
      return {
        ...gateCustomerReference(record, referenceOn),
        customer: record.customer && gatePoRequired(record.customer, referenceOn),
        // And without the vehicle's fleet number where that is switched off.
        vehicle: record.vehicle && {
          ...gateFleetNumber(record.vehicle, await isFleetNumberEnabled(organizationId)),
          customer: record.vehicle.customer && gatePoRequired(record.vehicle.customer, referenceOn),
        },
        quotes,
      }
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SERVICES }],
    }
  )
}

export async function createServiceRecord(input: unknown) {
  return withAuth(
    // fork: the body is createServiceRecordService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createServiceRecordService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => createServiceRecordEvent(result),
    }
  )
}

export async function updateServiceRecord(input: unknown) {
  return withAuth(
    // fork: the body is updateServiceRecordService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateServiceRecordService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => updateServiceRecordEvent(result),
    }
  )
}

/**
 * Moves a job along. `customStatusId` names one of the workshop's own
 * statuses, which has to sit under the stage being moved to; without one the
 * job stands at the plain stage and lets go of whatever status it carried,
 * since that belonged to the stage it left. See work-order-statuses/Lib/stages.
 */
export async function updateServiceStatus(
  recordId: string,
  status: string,
  customStatusId: string | null = null
) {
  return withAuth(
    // fork: the body is updateServiceStatusService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateServiceStatusService(
        { organizationId, userId, actor: 'user' },
        recordId,
        status,
        customStatusId
      ),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => updateServiceStatusEvent(result),
    }
  )
}

/**
 * Saves the job's internal notes on their own. The work order's Save goes
 * through updateServiceRecord, which refuses a locked invoice outright; the
 * internal notes are not part of what the lock freezes (they are never printed
 * or shared), so a locked job still takes them through here.
 */
export async function updateInternalNotes(recordId: string, html: string) {
  return withAuth(
    // fork: the body is updateInternalNotesService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateInternalNotesService({ organizationId, userId, actor: 'user' }, recordId, html),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => updateInternalNotesEvent(result),
    }
  )
}

/**
 * Renames a job the moment the title field is left.
 *
 * The title used to travel with the rest of the form on the autosave five
 * seconds later, and a rename followed by the back arrow inside those
 * seconds was lost. It is one column, so it goes straight to the row.
 */
export async function updateServiceRecordTitle(recordId: string, title: string) {
  return withAuth(
    // fork: the body is updateServiceRecordTitleService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateServiceRecordTitleService({ organizationId, userId, actor: 'user' }, recordId, title),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => updateServiceRecordTitleEvent(result),
    }
  )
}

export async function toggleManuallyPaid(recordId: string) {
  return withAuth(
    // fork: the body is toggleManuallyPaidService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      toggleManuallyPaidService({ organizationId, userId, actor: 'user' }, recordId),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
    }
  )
}

export async function getWorkOrders(params: {
  page?: number
  pageSize?: number
  search?: string
  status?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  /** 'today': what the workshop owes a customer by the end of today. */
  due?: string
}) {
  return withAuth(
    async ({ organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 20
      const skip = (page - 1) * pageSize

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { organizationId }
      const referenceOn = await isCustomerReferenceEnabled(organizationId)

      // Promised to a customer for today or earlier, and not handed over.
      // Anything already late belongs to the same answer: it was due before
      // today and is still owed. "Today" is the workshop's own day, not the
      // server's, or a shop an hour ahead loses its evening.
      if (params.due === 'today') {
        const timeZone = await workshopTimeZone(organizationId)
        const endOfToday = endOfWorkshopDay(zonedDayKey(new Date(), timeZone), timeZone)
        if (endOfToday) {
          where.promisedAt = { not: null, lte: endOfToday }
          where.AND = [...(where.AND ?? []), { status: { not: 'completed' } }]
        }
      }

      if (params.status === 'active') {
        where.status = { not: 'completed' }
      } else if (params.status && params.status !== 'all') {
        where.status = params.status
      }

      if (params.search) {
        where.OR = [
          { title: { contains: params.search, mode: 'insensitive' } },
          { invoiceNumber: { contains: params.search, mode: 'insensitive' } },
          { techName: { contains: params.search, mode: 'insensitive' } },
          { vehicle: { licensePlate: { contains: params.search, mode: 'insensitive' } } },
          ...(await typeKeySearch(organizationId, params.search)).map((vehicle) => ({ vehicle })),
          { vehicle: { customer: { name: { contains: params.search, mode: 'insensitive' } } } },
          { customer: { name: { contains: params.search, mode: 'insensitive' } } },
          // The customer's reference / PO, for a workshop that uses the field.
          ...(referenceOn
            ? [{ customerReference: { contains: params.search, mode: 'insensitive' } }]
            : []),
        ]
      }

      const [records, total, statusCounts] = await Promise.all([
        db.serviceRecord.findMany({
          where,
          include: {
            // The workshop's own status, shown beside the stage in the list.
            customStatus: { select: { name: true, color: true } },
            customer: { select: { id: true, name: true, email: true, phone: true } },
            vehicle: {
              select: {
                id: true,
                make: true,
                model: true,
                year: true,
                licensePlate: true,
                customer: { select: { id: true, name: true, email: true, phone: true } },
              },
            },
          },
          orderBy: (() => {
            const dir = params.sortOrder || 'desc'
            switch (params.sortBy) {
              case 'invoiceNumber':
                return { invoiceNumber: dir }
              case 'title':
                return { title: dir }
              case 'status':
                return { status: dir }
              case 'techName':
                return { techName: dir }
              case 'totalAmount':
                return { totalAmount: dir }
              // What the customer was told. A job with no promise made sorts
              // last either way: it is not late, and it is not "soonest".
              case 'promisedAt':
                return {
                  promisedAt: { sort: dir, nulls: 'last' as const },
                }
              // When the job itself was last saved, newest first by default.
              case 'updatedAt':
                return { updatedAt: dir }
              // Column shows "year make model"; sort make, model, year so
              // identical models group together
              case 'vehicle':
                return [
                  { vehicle: { make: dir } },
                  { vehicle: { model: dir } },
                  { vehicle: { year: dir } },
                ]
              case 'customer':
                return { vehicle: { customer: { name: dir } } }
              case 'serviceDate':
              default:
                return serviceDateOrderBy(dir)
            }
          })(),
          skip,
          take: pageSize,
        }),
        db.serviceRecord.count({ where }),
        db.serviceRecord.groupBy({
          by: ['status'],
          where: { organizationId },
          _count: true,
        }),
      ])

      const counts: Record<string, number> = {}
      for (const g of statusCounts) {
        counts[g.status] = g._count
      }

      return {
        records: records.map((record) => gateCustomerReference(record, referenceOn)),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        statusCounts: counts,
      }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.WORK_ORDERS },
      ],
    }
  )
}

export async function deleteServiceRecord(recordId: string) {
  return withAuth(
    // fork: the body is deleteServiceRecordService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteServiceRecordService({ organizationId, userId, actor: 'user' }, recordId),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => deleteServiceRecordEvent(result),
    }
  )
}

export async function deleteServiceAttachment(attachmentId: string) {
  return withAuth(
    // fork: the body is deleteServiceAttachmentService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteServiceAttachmentService({ organizationId, userId, actor: 'user' }, attachmentId),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
    }
  )
}

export async function generatePublicLink(serviceRecordId: string) {
  return withAuth(
    // fork: the body is generatePublicLinkService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      generatePublicLinkService({ organizationId, userId, actor: 'user' }, serviceRecordId),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
    }
  )
}

export async function revokePublicLink(serviceRecordId: string) {
  return withAuth(
    // fork: the body is revokePublicLinkService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      revokePublicLinkService({ organizationId, userId, actor: 'user' }, serviceRecordId),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
    }
  )
}
