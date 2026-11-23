/** Technicians and work order statuses, field by field (docs/fork/API.md §4). */
import { iso, isoAlways } from '../Lib/serializeFormat'
import type { TechnicianOut, WorkOrderStatusOut } from '../Schema/staff'

export const TECHNICIAN_SELECT = {
  id: true,
  name: true,
  color: true,
  isActive: true,
  sortOrder: true,
  dailyCapacity: true,
  skills: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface TechnicianRow {
  id: string
  name: string
  color: string
  isActive: boolean
  sortOrder: number
  dailyCapacity: number
  skills: string | null
  userId: string | null
  createdAt: Date
  updatedAt: Date
}

export function serializeTechnician(row: TechnicianRow): TechnicianOut {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    dailyCapacity: row.dailyCapacity,
    skills: row.skills,
    userId: row.userId,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}

export const STATUS_SELECT = {
  id: true,
  name: true,
  stage: true,
  color: true,
  sortOrder: true,
  notifyCustomer: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface StatusRow {
  id: string
  name: string
  stage: string
  color: string
  sortOrder: number
  notifyCustomer: boolean
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export function serializeStatus(row: StatusRow): WorkOrderStatusOut {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage,
    color: row.color,
    sortOrder: row.sortOrder,
    notifyCustomer: row.notifyCustomer,
    archivedAt: iso(row.archivedAt),
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}
