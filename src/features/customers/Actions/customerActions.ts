'use server'

import { getRecordCustomFieldsForPrint } from '@/features/custom-fields/Lib/getCustomFieldsForPrint'
import { gateFleetNumber, isFleetNumberEnabled } from '@/features/vehicles/Lib/fleetNumberSetting'
import {
  gatePoRequired,
  isCustomerReferenceEnabled,
} from '@/features/customer-reference/Lib/referenceSetting'
import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
// fork: the write bodies and their audit events live beside the customer service (A2)
import {
  customerCreatedEvent,
  customerDeletedEvent,
  customerUpdatedEvent,
} from '../Lib/customerAuditEvents'
import {
  createCustomerService,
  deleteCustomerService,
  deleteCustomersService,
  updateCustomerService,
} from '../Lib/customerService.server'
import { revalidatePath } from 'next/cache'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { createDraftServiceRecord } from '@/features/vehicles/Actions/createDraftServiceRecord'
import { serviceDateOrderBy } from '@/lib/date-sort'
import { clearedToNull } from '@/lib/clearable'
import { Prisma } from '@/generated/prisma/client'
import { NAME_FOLD, foldName, normalizeName } from '@/lib/name-similarity'
import { requestTitle } from '@/features/portal/Lib/requestText'

export async function getCustomers() {
  return withAuth(
    async ({ userId, organizationId }) => {
      const customers = await db.customer.findMany({
        where: { organizationId },
        include: {
          _count: { select: { vehicles: true } },
        },
        orderBy: { updatedAt: 'desc' },
      })
      const referenceOn = await isCustomerReferenceEnabled(organizationId)
      return customers.map((customer) => gatePoRequired(customer, referenceOn))
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

export async function getCustomer(customerId: string) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const customer = await db.customer.findFirst({
        where: { id: customerId, organizationId },
        include: {
          // The name, so the page can say which design this customer's
          // invoices print with rather than only that one was chosen.
          invoiceDesign: { select: { id: true, name: true } },
          vehicles: {
            where: { isArchived: false },
            include: {
              _count: { select: { serviceRecords: true } },
            },
            orderBy: { updatedAt: 'desc' },
          },
          serviceRequests: {
            include: {
              vehicle: { select: { id: true, make: true, model: true, year: true } },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      })

      // Missing or foreign-org customer yields null rather than an error: the
      // page renders its not-found state, and this also runs during the
      // post-delete re-render of the customer route.
      if (!customer) return customer
      // Never "PO required" for a workshop that has the Reference / PO field
      // off, and no fleet number on its vehicles where that is off.
      const fleetNumberOn = await isFleetNumberEnabled(organizationId)
      return {
        ...gatePoRequired(customer, await isCustomerReferenceEnabled(organizationId)),
        vehicles: customer.vehicles.map((vehicle) => gateFleetNumber(vehicle, fleetNumberOn)),
        // The workshop's own fields for this customer: none unless it defined some.
        customFields: await getRecordCustomFieldsForPrint(organizationId, {
          customerId: customer.id,
        }),
      }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

export async function createCustomer(input: unknown) {
  return withAuth(
    // fork: the body is createCustomerService (A2), shared with the public API
    async ({ userId, organizationId }) =>
      createCustomerService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.CUSTOMERS },
      ],
      audit: ({ result }) => customerCreatedEvent(result),
    }
  )
}

export async function updateCustomer(input: unknown) {
  return withAuth(
    // fork: the body is updateCustomerService (A2), shared with the public API
    async ({ userId, organizationId }) =>
      updateCustomerService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.CUSTOMERS },
      ],
      audit: ({ result }) => customerUpdatedEvent(result),
    }
  )
}

export async function deleteCustomer(customerId: string) {
  return withAuth(
    // fork: the body is deleteCustomerService (A2), shared with the public API
    async ({ userId, organizationId }) =>
      deleteCustomerService({ organizationId, userId, actor: 'user' }, customerId),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.CUSTOMERS },
      ],
      audit: ({ result }) => customerDeletedEvent(result),
    }
  )
}

export async function deleteCustomers(customerIds: string[]) {
  return withAuth(
    // fork: the body is deleteCustomersService (A2), shared with the public API
    async ({ userId, organizationId }) =>
      deleteCustomersService({ organizationId, userId, actor: 'user' }, customerIds),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

/** How many customers still have no number: what the list's assign button shows. */
export async function countUnnumberedCustomers() {
  return withAuth(
    async ({ organizationId }) =>
      db.customer.count({ where: { organizationId, customerNumber: null } }),
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

/**
 * Assigns sequential numbers to every customer that has none, oldest first,
 * continuing after the highest existing numeric number (min 1001). Customers
 * that already have a number — auto or manual — are never touched.
 */
export async function backfillCustomerNumbers() {
  return withAuth(
    async ({ organizationId }) => {
      const [numbered, unnumbered] = await Promise.all([
        db.customer.findMany({
          where: { organizationId, customerNumber: { not: null } },
          select: { customerNumber: true },
        }),
        db.customer.findMany({
          where: { organizationId, customerNumber: null },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        }),
      ])

      let next =
        numbered.reduce((acc, c) => {
          const n = Number.parseInt(c.customerNumber ?? '', 10)
          return Number.isFinite(n) && n > acc ? n : acc
        }, 1000) + 1

      await db.$transaction(
        unnumbered.map((c) =>
          db.customer.update({
            where: { id: c.id },
            data: { customerNumber: String(next++) },
          })
        )
      )

      revalidatePath('/customers')
      return { assigned: unnumbered.length }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.CUSTOMERS },
      ],
      audit: ({ result }) => ({
        action: 'customer.backfillNumbers',
        entity: 'Customer',
        details: { key: 'customer_backfillNumbers', params: { count: result.assigned } },
        metadata: { assigned: result.assigned },
      }),
    }
  )
}

export async function getCustomersPaginated(params: {
  page?: number
  pageSize?: number
  search?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 20
      const skip = (page - 1) * pageSize

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { organizationId }

      if (params.search) {
        const words = params.search.trim().split(/\s+/).filter(Boolean)
        if (words.length > 1) {
          where.AND = words.map((word: string) => ({
            OR: [
              { name: { contains: word, mode: 'insensitive' } },
              { email: { contains: word, mode: 'insensitive' } },
              { phone: { contains: word, mode: 'insensitive' } },
              { company: { contains: word, mode: 'insensitive' } },
              { customerNumber: { contains: word, mode: 'insensitive' } },
            ],
          }))
        } else {
          where.OR = [
            { name: { contains: params.search, mode: 'insensitive' } },
            { email: { contains: params.search, mode: 'insensitive' } },
            { phone: { contains: params.search, mode: 'insensitive' } },
            { company: { contains: params.search, mode: 'insensitive' } },
            { customerNumber: { contains: params.search, mode: 'insensitive' } },
          ]
        }
      }

      const [customers, total] = await Promise.all([
        db.customer.findMany({
          where,
          include: {
            _count: { select: { vehicles: true } },
          },
          orderBy: (() => {
            const dir = params.sortOrder || 'desc'
            const nullable = { sort: dir, nulls: 'last' } as const
            switch (params.sortBy) {
              case 'number':
                return { customerNumber: { sort: dir, nulls: 'last' as const } }
              case 'name':
                return { name: dir }
              case 'company':
                return { company: nullable }
              case 'phone':
                return { phone: nullable }
              case 'email':
                return { email: nullable }
              case 'vehicles':
                return { vehicles: { _count: dir } }
              default:
                return { updatedAt: 'desc' as const }
            }
          })(),
          skip,
          take: pageSize,
        }),
        db.customer.count({ where }),
      ])

      const referenceOn = await isCustomerReferenceEnabled(organizationId)
      return {
        customers: customers.map((customer) => gatePoRequired(customer, referenceOn)),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

/**
 * Pending booking requests from the customer portal, newest first.
 *
 * These are customers asking for work. Until now they only reached the shop
 * as an alert on the way in and a tab on one customer's page, so a missed
 * alert meant a request nobody was looking for. The dashboard needs them in
 * one place, which is what this feeds.
 */
export async function getPendingServiceRequests(limit = 5) {
  return withAuth(
    async ({ organizationId }) => {
      return db.serviceRequest.findMany({
        where: { organizationId, status: 'pending' },
        select: {
          id: true,
          description: true,
          preferredDate: true,
          attachments: true,
          createdAt: true,
          customer: { select: { id: true, name: true } },
          vehicle: {
            select: { id: true, make: true, model: true, year: true, licensePlate: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

export async function updateServiceRequest(
  requestId: string,
  data: { status?: string; adminNotes?: string }
) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const result = await db.serviceRequest.updateMany({
        where: { id: requestId, organizationId },
        data: { status: data.status, adminNotes: clearedToNull(data.adminNotes) },
      })
      if (result.count === 0) throw new Error('Service request not found')
      revalidatePath('/customers')
      return { id: requestId }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

export async function createWorkOrderFromRequest(requestId: string) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const request = await db.serviceRequest.findFirst({
        where: { id: requestId, organizationId },
        include: { vehicle: { select: { id: true } } },
      })
      if (!request) throw new Error('Service request not found')
      if (request.status === 'converted')
        throw new Error('Work order already created for this request')

      const vehicleId = request.vehicleId

      // The customer named a day, not a time: book the first free slot from
      // that day on. Passed as the start time, it booked the job at midnight.
      const result = await createDraftServiceRecord(
        vehicleId,
        undefined,
        undefined,
        undefined,
        undefined,
        request.preferredDate ?? undefined
      )
      if (!result.success || !result.data) {
        throw new Error(result.error ?? 'Failed to create work order')
      }
      const record = result.data

      const truncatedTitle = requestTitle(request.description)

      await db.serviceRecord.update({
        where: { id: record.id },
        data: {
          title: truncatedTitle,
          description: request.description,
          // The job description is told as concerns, the first step of which
          // is the customer's own words. Without one the job opened with
          // "Not written yet" and the request text only in the cut-short title.
          concerns: { create: { description: request.description, sortOrder: 0 } },
        },
      })

      const existingNotes = request.adminNotes ? `${request.adminNotes}\n` : ''
      await db.serviceRequest.update({
        where: { id: requestId },
        data: {
          status: 'converted',
          adminNotes: `${existingNotes}Work Order: ${record.id}`,
        },
      })

      revalidatePath('/customers')
      return { vehicleId, serviceRecordId: record.id }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

export async function searchCustomers(search?: string, limit = 20, offset = 0) {
  return withAuth(
    async ({ organizationId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { organizationId }
      if (search) {
        const words = search.trim().split(/\s+/).filter(Boolean)
        if (words.length > 1) {
          // Every word must match in at least one field
          where.AND = words.map((word) => ({
            OR: [
              { name: { contains: word, mode: 'insensitive' } },
              { email: { contains: word, mode: 'insensitive' } },
              { phone: { contains: word, mode: 'insensitive' } },
              { company: { contains: word, mode: 'insensitive' } },
              { customerNumber: { contains: word, mode: 'insensitive' } },
            ],
          }))
        } else {
          where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
            { company: { contains: search, mode: 'insensitive' } },
          ]
        }
      }
      return db.customer.findMany({
        where,
        select: { id: true, name: true, company: true },
        orderBy: { name: 'asc' },
        skip: offset,
        take: limit,
      })
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

/** One customer's name and company, for a selector that was given only the id. */
export async function getCustomerOption(customerId: string) {
  return withAuth(
    async ({ organizationId }) => {
      const customer = await db.customer.findFirst({
        where: { id: customerId, organizationId },
        select: { id: true, name: true, company: true },
      })
      if (!customer) throw new Error('Customer not found')
      return customer
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

/** How many possible owners are sent back for the fuzzy comparison. */
const OWNER_CANDIDATE_LIMIT = 50

/**
 * Customers who could be the keeper named on a scanned document, for the
 * vehicle form to compare with `nameSimilarity`.
 *
 * Name and company are compared with accents and case folded by `foldName`,
 * so papers that say "Muller" find "Müller" and the other way round. Every
 * word of two letters or more is looked for, so "Bo Li" is found, and the
 * customers matching the most words come first, so the right one is not
 * pushed past the limit by others sharing a surname.
 */
export async function findOwnerCandidates(ownerName: string) {
  return withAuth(
    async ({ organizationId }) => {
      const allWords = [...new Set(foldName(normalizeName(ownerName)).split(' ').filter(Boolean))]
      const longer = allWords.filter((word) => word.length >= 2)
      const words = (longer.length ? longer : allWords).slice(0, 6)
      if (!words.length) return []

      const folded = Prisma.sql`lower(translate(c.name || ' ' || coalesce(c.company, ''), ${NAME_FOLD.from}, ${NAME_FOLD.to}))`
      // normalizeName leaves only letters and digits, so no word holds a LIKE wildcard
      const hits = words.map((word) => Prisma.sql`(${folded} LIKE ${`%${word}%`})`)
      return db.$queryRaw<{ id: string; name: string; company: string | null }[]>(Prisma.sql`
        SELECT c.id, c.name, c.company
        FROM "public"."customers" c
        WHERE c."organizationId" = ${organizationId}
          AND (${Prisma.join(hits, ' OR ')})
        ORDER BY (${Prisma.join(
          hits.map((hit) => Prisma.sql`${hit}::int`),
          ' + '
        )}) DESC, c.name ASC
        LIMIT ${OWNER_CANDIDATE_LIMIT}
      `)
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.CUSTOMERS },
      ],
    }
  )
}

/// Every invoice belonging to a customer: the ones raised directly against
/// them (parts-only counter sales, which carry no vehicle) plus every invoice
/// on a vehicle they own. Without the OR, parts-only sales are invisible from
/// the customer page — the vehicle tab is the only way in and they have no
/// vehicle to sit under.
export async function getCustomerInvoices(customerId: string) {
  return withAuth(
    async ({ organizationId }) => {
      return db.serviceRecord.findMany({
        where: {
          organizationId,
          OR: [{ customerId }, { vehicle: { customerId } }],
        },
        select: {
          id: true,
          title: true,
          status: true,
          cost: true,
          totalAmount: true,
          invoiceNumber: true,
          invoiceDate: true,
          startDateTime: true,
          serviceDate: true,
          vehicleId: true,
          vehicle: { select: { make: true, model: true, year: true, licensePlate: true } },
        },
        orderBy: serviceDateOrderBy('desc'),
      })
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.WORK_ORDERS },
      ],
    }
  )
}

/// Same reasoning as getCustomerInvoices: a quote is reachable either through
/// its own customer link or through the vehicle it was written for.
export async function getCustomerQuotes(customerId: string) {
  return withAuth(
    async ({ organizationId }) => {
      return db.quote.findMany({
        where: {
          organizationId,
          OR: [{ customerId }, { vehicle: { customerId } }],
        },
        select: {
          id: true,
          title: true,
          status: true,
          quoteNumber: true,
          totalAmount: true,
          createdAt: true,
          vehicle: { select: { make: true, model: true, year: true, licensePlate: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.QUOTES }],
    }
  )
}
