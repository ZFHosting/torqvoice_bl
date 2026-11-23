/**
 * Serializers several resources share: custom field values, jobs and lines (X2, X3). Field by field, never a
 * spread row (a test checks this folder).
 */
import {
  type LineKind,
  readLaborSourceExtra,
  readPartSourceExtra,
} from '@/integrations/shopmonkey/schema/sourceExtra'
import type { z } from 'zod'
import type { customFieldValueSchema, jobSchema, lineSchema } from '../Schema/common'
import { iso, isoAlways, money, moneyOrNull } from '../Lib/serializeFormat'

export type CustomFieldValueOut = z.infer<typeof customFieldValueSchema>
export type JobOut = z.infer<typeof jobSchema>
export type LineOut = z.infer<typeof lineSchema>

/** The `customFields` an expand put in `extra`, or none. */
export function customFieldsFrom(extra: Record<string, unknown>): CustomFieldValueOut[] {
  return (extra.customFields as CustomFieldValueOut[] | undefined) ?? []
}

export const JOB_SELECT = {
  id: true,
  name: true,
  note: true,
  ordinal: true,
  authorizationStatus: true,
  recommended: true,
  hidden: true,
  lumpSum: true,
  fixedPrice: true,
  deferredDate: true,
  deferredReason: true,
  totalAmount: true,
  discountAmount: true,
  taxAmount: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface JobRow {
  id: string
  name: string
  note: string | null
  ordinal: number
  authorizationStatus: string | null
  recommended: boolean
  hidden: boolean
  lumpSum: boolean
  fixedPrice: number | null
  deferredDate: Date | null
  deferredReason: string | null
  totalAmount: number
  discountAmount: number
  taxAmount: number
  createdAt: Date
  updatedAt: Date
}

export function serializeJob(job: JobRow): JobOut {
  return {
    id: job.id,
    name: job.name,
    note: job.note,
    ordinal: job.ordinal,
    authorizationStatus: job.authorizationStatus,
    recommended: job.recommended,
    hidden: job.hidden,
    lumpSum: job.lumpSum,
    fixedPrice: moneyOrNull(job.fixedPrice),
    deferredDate: iso(job.deferredDate),
    deferredReason: job.deferredReason,
    totalAmount: money(job.totalAmount),
    discountAmount: money(job.discountAmount),
    taxAmount: money(job.taxAmount),
    createdAt: isoAlways(job.createdAt),
    updatedAt: isoAlways(job.updatedAt),
  }
}

/** A part row's columns, on a work order (`ServicePart`) or a quote (`QuotePart`, which adds `excluded`). */
export const PART_LINE_SELECT = {
  id: true,
  partNumber: true,
  name: true,
  quantity: true,
  unit: true,
  unitPrice: true,
  total: true,
  unitCost: true,
  inventoryPartId: true,
  taxable: true,
  jobId: true,
  lineKind: true,
  discountAmount: true,
  note: true,
  sourceExtra: true,
} as const

export const LABOR_LINE_SELECT = {
  id: true,
  description: true,
  hours: true,
  rate: true,
  total: true,
  pricingType: true,
  taxable: true,
  jobId: true,
  lineKind: true,
  technicianId: true,
  completed: true,
  costHours: true,
  costRate: true,
  discountAmount: true,
  sourceExtra: true,
} as const

export interface PartLineRow {
  id: string
  partNumber: string | null
  name: string
  quantity: number
  unit: string | null
  unitPrice: number
  total: number
  unitCost: number
  inventoryPartId: string | null
  taxable: boolean
  jobId: string | null
  lineKind: string | null
  discountAmount: number | null
  note: string | null
  sourceExtra: unknown
  excluded?: boolean
}

export interface LaborLineRow {
  id: string
  description: string
  hours: number
  rate: number
  total: number
  pricingType: string
  taxable: boolean
  jobId: string | null
  lineKind: string | null
  technicianId: string | null
  completed: boolean | null
  costHours: number | null
  costRate: number | null
  discountAmount: number | null
  sourceExtra: unknown
  excluded?: boolean
}

const PART_KINDS: readonly LineKind[] = ['part', 'tire', 'subcontract']
const LABOR_KINDS: readonly LineKind[] = ['labor', 'fee', 'epa', 'shopSupplies']

function partKind(row: PartLineRow): LineKind {
  return PART_KINDS.includes(row.lineKind as LineKind) ? (row.lineKind as LineKind) : 'part'
}

function laborKind(row: LaborLineRow): LineKind {
  if (LABOR_KINDS.includes(row.lineKind as LineKind)) return row.lineKind as LineKind
  // A line made in the app has no source kind: a shop fee is a fee, the rest labor.
  return row.pricingType === 'shopFee' ? 'fee' : 'labor'
}

function extraOrNull(extra: Record<string, unknown>): Record<string, unknown> | null {
  return Object.keys(extra).length ? extra : null
}

export function serializePartLine(row: PartLineRow): LineOut {
  return {
    id: row.id,
    kind: partKind(row),
    description: row.name,
    partNumber: row.partNumber,
    quantity: row.quantity,
    unit: row.unit,
    unitPrice: money(row.unitPrice),
    total: money(row.total),
    discountAmount: moneyOrNull(row.discountAmount),
    taxable: row.taxable,
    pricingType: null,
    jobId: row.jobId,
    technicianId: null,
    completed: null,
    costHours: null,
    costRate: null,
    unitCost: money(row.unitCost),
    inventoryPartId: row.inventoryPartId,
    note: row.note,
    excluded: row.excluded ?? false,
    sourceExtra: row.sourceExtra == null ? null : extraOrNull(readPartSourceExtra(row.sourceExtra)),
  }
}

export function serializeLaborLine(row: LaborLineRow): LineOut {
  return {
    id: row.id,
    kind: laborKind(row),
    description: row.description,
    partNumber: null,
    quantity: row.hours,
    unit: null,
    unitPrice: money(row.rate),
    total: money(row.total),
    discountAmount: moneyOrNull(row.discountAmount),
    taxable: row.taxable,
    pricingType: row.pricingType,
    jobId: row.jobId,
    technicianId: row.technicianId,
    completed: row.completed,
    costHours: row.costHours,
    costRate: moneyOrNull(row.costRate),
    unitCost: null,
    inventoryPartId: null,
    note: null,
    excluded: row.excluded ?? false,
    sourceExtra:
      row.sourceExtra == null ? null : extraOrNull(readLaborSourceExtra(row.sourceExtra)),
  }
}

/** Labor rows first, then parts, each in the order they're stored. */
export function serializeLines(labor: LaborLineRow[], parts: PartLineRow[]): LineOut[] {
  return [...labor.map(serializeLaborLine), ...parts.map(serializePartLine)]
}
