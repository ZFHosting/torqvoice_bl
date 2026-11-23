'use server'

import { getRecordCustomFieldsForPrint } from '@/features/custom-fields/Lib/getCustomFieldsForPrint'
import {
  fleetNumberMatch,
  gateFleetNumber,
  isFleetNumberEnabled,
} from '@/features/vehicles/Lib/fleetNumberSetting'
import { equipmentEnabled } from '@/features/equipment/Lib/equipmentGate.server'
import { equipmentSerialMatch } from '@/features/equipment/Lib/equipmentSearch'
import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the write bodies and their audit events live beside the vehicle service (A2)
import {
  vehicleCreatedEvent,
  vehicleDeletedEvent,
  vehicleUpdatedEvent,
} from '../Lib/vehicleAuditEvents'
import {
  createVehicleService,
  deleteVehicleService,
  updateVehicleService,
} from '../Lib/vehicleService.server'
import { searchYear } from '@/features/vehicles/Lib/searchYear'
import { searchWordsOf, typeKeySearchTerms } from '../Lib/typeKey'
import { isTypeKeyEnabled } from '../Lib/typeKeySetting'

export async function getVehicles() {
  return withAuth(
    async ({ organizationId }) => {
      const vehicles = await db.vehicle.findMany({
        where: { organizationId, isArchived: false },
        include: {
          customer: { select: { id: true, name: true, company: true } },
          _count: {
            select: { serviceRecords: true, notes: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
      })
      const fleetNumberOn = await isFleetNumberEnabled(organizationId)
      return vehicles.map((vehicle) => gateFleetNumber(vehicle, fleetNumberOn))
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.VEHICLES }],
    }
  )
}

export async function getVehicle(vehicleId: string) {
  return withAuth(
    async ({ organizationId }) => {
      const vehicle = await db.vehicle.findFirst({
        where: { id: vehicleId, organizationId },
        include: {
          customer: { select: { id: true, name: true, company: true, email: true, phone: true } },
          inspectionStatus: {
            select: { dueAt: true, lastAt: true, source: true, checkedAt: true, registered: true },
          },
          serviceRecords: {
            orderBy: [{ startDateTime: { sort: 'desc', nulls: 'last' } }, { serviceDate: 'desc' }],
            take: 10,
            include: {
              _count: { select: { partItems: true, laborItems: true } },
            },
          },
          notes: { orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }] },
          reminders: {
            orderBy: [{ isCompleted: 'asc' }, { dueDate: 'asc' }],
            select: {
              id: true,
              title: true,
              description: true,
              dueDate: true,
              // Whether the time of day was chosen, and which channels were
              // asked for. Left out of this select, the tab showed every
              // reminder as day-only and its edit form opened with the time
              // blank and the channels back at their defaults, so saving an
              // 08:00 email reminder rewrote it to noon with no email.
              hasDueTime: true,
              notifyInApp: true,
              notifyEmail: true,
              dueMileage: true,
              isCompleted: true,
              createdAt: true,
            },
          },
          aiMessages: {
            select: { type: true, content: true, updatedAt: true },
          },
          _count: {
            select: {
              serviceRecords: true,
              notes: true,
              reminders: { where: { isCompleted: false } },
              findings: { where: { status: 'open' } },
            },
          },
        },
      })

      // Missing or foreign-org vehicle yields null rather than an error: the
      // page renders its not-found state, and this also runs during the
      // post-delete re-render of the vehicle route.
      if (!vehicle) return vehicle

      // What the vehicle has cost over all its work orders. `serviceRecords`
      // above holds only the ten most recent, and the page used to add those
      // up, so a car with a longer history showed less than it had spent.
      const spend = await db.serviceRecord.findMany({
        where: { vehicleId: vehicle.id, vehicle: { organizationId } },
        select: { totalAmount: true, cost: true },
      })
      const lifetimeSpend = spend.reduce(
        (sum, r) => sum + (r.totalAmount > 0 ? r.totalAmount : r.cost),
        0
      )

      // Without the fleet number for a workshop that has that field off.
      return {
        ...gateFleetNumber(vehicle, await isFleetNumberEnabled(organizationId)),
        lifetimeSpend,
        // The workshop's own fields for this vehicle: none unless it defined
        // some. Its owner's fields belong on the customer's page, not here.
        customFields: await getRecordCustomFieldsForPrint(
          organizationId,
          { vehicleId: vehicle.id },
          { owner: false }
        ),
      }
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.VEHICLES }],
    }
  )
}

export async function getVehiclesPaginated(params: {
  page?: number
  pageSize?: number
  search?: string
  archived?: boolean
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  /** Periodic inspection filter: overdue, or due within this many days. */
  inspectionDue?: 'overdue' | 30 | 90
}) {
  return withAuth(
    async ({ organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 20
      const skip = (page - 1) * pageSize

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { organizationId, isArchived: params.archived ?? false }

      if (params.search) {
        const words = searchWordsOf(params.search)
        const typeKeyOn = await isTypeKeyEnabled(organizationId)
        const fleetNumberOn = await isFleetNumberEnabled(organizationId)
        // A serial number of equipment on the vehicle now finds it, for a
        // workshop that records equipment; off, the query is unchanged.
        const equipmentOn = await equipmentEnabled(organizationId)
        const fieldMatch = (word: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const conditions: any[] = [
            { make: { contains: word, mode: 'insensitive' } },
            { model: { contains: word, mode: 'insensitive' } },
            { licensePlate: { contains: word, mode: 'insensitive' } },
            { vin: { contains: word, mode: 'insensitive' } },
            ...(typeKeyOn ? typeKeySearchTerms(word) : []),
            ...fleetNumberMatch(word, fleetNumberOn),
            ...equipmentSerialMatch(organizationId, word, equipmentOn),
            { customer: { name: { contains: word, mode: 'insensitive' } } },
          ]
          const year = searchYear(word)
          if (year !== null) {
            conditions.push({ year })
          }
          return conditions
        }
        if (words.length > 1) {
          where.AND = words.map((word: string) => ({ OR: fieldMatch(word) }))
        } else {
          where.OR = fieldMatch(words[0])
        }
      }

      if (params.inspectionDue) {
        const now = new Date()
        where.inspectionStatus =
          params.inspectionDue === 'overdue'
            ? { dueAt: { lt: now } }
            : { dueAt: { lt: new Date(now.getTime() + params.inspectionDue * 86_400_000) } }
      }

      const [vehicles, total, archivedCount, inspectionDataCount] = await Promise.all([
        db.vehicle.findMany({
          where,
          include: {
            customer: { select: { id: true, name: true, company: true } },
            inspectionStatus: { select: { dueAt: true, source: true } },
            _count: { select: { serviceRecords: true } },
          },
          orderBy: (() => {
            const dir = params.sortOrder || 'desc'
            // A due-date filter reads soonest first unless a column was chosen.
            if (params.inspectionDue && !params.sortBy) {
              return { inspectionStatus: { dueAt: 'asc' as const } }
            }
            switch (params.sortBy) {
              case 'plate':
                return { licensePlate: { sort: dir, nulls: 'last' as const } }
              // The column shows "year make model" as one value; sort by make,
              // then model, then year so identical models group together
              case 'vehicle':
                return [{ make: dir }, { model: dir }, { year: dir }]
              case 'customer':
                return { customer: { name: dir } }
              case 'mileage':
                return { mileage: dir }
              case 'services':
                return { serviceRecords: { _count: dir } }
              default:
                return { updatedAt: 'desc' as const }
            }
          })(),
          skip,
          take: pageSize,
        }),
        db.vehicle.count({ where }),
        db.vehicle.count({ where: { organizationId, isArchived: true } }),
        db.vehicleInspectionStatus.count({ where: { organizationId, dueAt: { not: null } } }),
      ])

      const fleetNumberShown = await isFleetNumberEnabled(organizationId)
      return {
        vehicles: vehicles.map((vehicle) => gateFleetNumber(vehicle, fleetNumberShown)),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        archivedCount,
        /** Whether any vehicle here has an inspection date, which is when the filter is worth showing. */
        hasInspectionData: inspectionDataCount > 0,
      }
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.VEHICLES }],
    }
  )
}

export async function createVehicle(input: unknown) {
  return withAuth(
    // fork: the body is createVehicleService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createVehicleService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.VEHICLES },
      ],
      audit: ({ result }) => vehicleCreatedEvent(result),
    }
  )
}

export async function updateVehicle(input: unknown) {
  return withAuth(
    // fork: the body is updateVehicleService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateVehicleService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.VEHICLES },
      ],
      audit: ({ result }) => vehicleUpdatedEvent(result),
    }
  )
}

export async function deleteVehicle(vehicleId: string) {
  return withAuth(
    // fork: the body is deleteVehicleService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteVehicleService({ organizationId, userId, actor: 'user' }, vehicleId),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.VEHICLES },
      ],
      audit: ({ result }) => vehicleDeletedEvent(result),
    }
  )
}

export async function searchVehicles(search?: string, limit = 20, offset = 0, customerId?: string) {
  return withAuth(
    async ({ organizationId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { organizationId, isArchived: false }
      if (customerId) where.customerId = customerId
      // The fleet / unit number finds the vehicle and is shown on its row,
      // for a workshop that uses it; null on every row otherwise.
      const fleetNumberOn = await isFleetNumberEnabled(organizationId)
      if (search) {
        const words = searchWordsOf(search)
        const typeKeyOn = await isTypeKeyEnabled(organizationId)
        // A serial number of equipment on the vehicle now finds it, for a
        // workshop that records equipment; off, the query is unchanged.
        const equipmentOn = await equipmentEnabled(organizationId)
        const fieldMatch = (word: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const conditions: any[] = [
            { make: { contains: word, mode: 'insensitive' } },
            { model: { contains: word, mode: 'insensitive' } },
            { licensePlate: { contains: word, mode: 'insensitive' } },
            { vin: { contains: word, mode: 'insensitive' } },
            ...(typeKeyOn ? typeKeySearchTerms(word) : []),
            ...fleetNumberMatch(word, fleetNumberOn),
            ...equipmentSerialMatch(organizationId, word, equipmentOn),
            { customer: { name: { contains: word, mode: 'insensitive' } } },
          ]
          const year = searchYear(word)
          if (year !== null) {
            conditions.push({ year })
          }
          return conditions
        }
        if (words.length > 1) {
          where.AND = words.map((word) => ({ OR: fieldMatch(word) }))
        } else {
          where.OR = fieldMatch(words[0])
        }
      }
      const vehicles = await db.vehicle.findMany({
        where,
        select: {
          id: true,
          make: true,
          model: true,
          year: true,
          licensePlate: true,
          fleetNumber: true,
          customerId: true,
          customer: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: offset,
        take: limit,
      })
      return vehicles.map((vehicle) => gateFleetNumber(vehicle, fleetNumberOn))
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.VEHICLES }],
    }
  )
}
