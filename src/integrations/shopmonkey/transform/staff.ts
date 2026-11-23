/**
 * Staff and statuses (MAPPING §3): a Shopmonkey user becomes a Technician (logins are invited by hand,
 * never created); workflow statuses become WorkOrderStatus rows, each filed under a stage.
 */
import { date, type FieldSpec, num, str, unmappedFields } from './fields'
import type { Row, Stage, TransformContext, TransformResult } from './types'

export const USER_FIELDS: FieldSpec = {
  mapped: ['id', 'firstName', 'lastName', 'email', 'active', 'color', 'createdDate'],
  archive: [
    'assignedServiceWriter',
    'assignedTechnician',
    'canTrackTime',
    'companyIds',
    'customFields',
    'laborRateId',
    'locationIds',
    'phone',
    'roleIds',
    'updatedDate',
  ],
}

export interface TechnicianRow {
  name: string
  color: string | undefined
  isActive: boolean
  organizationId: string
  createdAt: Date | undefined
}

/** A user's display name: first and last, else the part of the email before the @, else the id. */
export function userName(user: Row): string {
  const name = [str(user.firstName), str(user.lastName)].filter(Boolean).join(' ')
  if (name) return name
  const email = str(user.email)
  return email ? email.split('@')[0] : String(user.id)
}

/**
 * Shopmonkey names a user's colour (`blue`); Torqvoice keeps a hex value. PROVISIONAL(M0:S4): the names
 * are a reading of the fixtures. An unknown name keeps the column's default.
 */
const COLOR_HEX: Record<string, string> = {
  blue: '#3b82f6',
  green: '#22c55e',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  purple: '#a855f7',
  pink: '#ec4899',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  indigo: '#6366f1',
  gray: '#6b7280',
  grey: '#6b7280',
  brown: '#92400e',
  black: '#111827',
  aqua: '#22d3ee',
}

export function technicianColor(value: unknown): string | undefined {
  const color = str(value)?.toLowerCase()
  if (!color) return undefined
  if (/^#[0-9a-f]{6}$/.test(color)) return color
  return COLOR_HEX[color]
}

export function transformUser(user: Row, ctx: TransformContext): TransformResult<TechnicianRow> {
  return {
    rows: {
      name: userName(user),
      color: technicianColor(user.color),
      isActive: user.active !== false,
      organizationId: ctx.organizationId,
      createdAt: date(user.createdDate) ?? undefined,
    },
    warnings: [],
    unmapped: unmappedFields(user, USER_FIELDS),
  }
}

export const WORKFLOW_STATUS_FIELDS: FieldSpec = {
  mapped: ['id', 'name', 'position', 'repairOrderWorkflow', 'invoiceWorkflow', 'createdDate'],
  archive: [
    'archiveWhenInactive',
    'archiveWhenPaid',
    'companyId',
    'daysToArchive',
    'inactiveOrderWarningThreshold',
    'locationId',
    'metadata',
    'updatedDate',
  ],
}

export interface WorkflowStatusRow {
  remoteId: string
  name: string
  stage: Stage
  sortOrder: number
  organizationId: string
}

/**
 * The stage a status goes under until the operator maps it (RESULTS S9, blocker B6): a status in the
 * invoice workflow is completed; in the repair-order workflow the first by position is pending and the
 * rest are in progress. PROVISIONAL(M0:S9).
 */
export function defaultStages(statuses: Row[]): Map<string, Stage> {
  const out = new Map<string, Stage>()
  const repair = statuses
    .filter((s) => s.invoiceWorkflow !== true)
    .sort((a, b) => (num(a.position) ?? 0) - (num(b.position) ?? 0))
  for (const s of statuses) if (s.invoiceWorkflow === true) out.set(String(s.id), 'completed')
  repair.forEach((s, i) => out.set(String(s.id), i === 0 ? 'pending' : 'in-progress'))
  return out
}

export function transformWorkflowStatuses(
  statuses: Row[],
  ctx: TransformContext
): TransformResult<WorkflowStatusRow[]> {
  const defaults = defaultStages(statuses)
  const unmapped = new Set<string>()
  const rows = [...statuses]
    .sort((a, b) => (num(a.position) ?? 0) - (num(b.position) ?? 0))
    .map((s): WorkflowStatusRow => {
      for (const key of unmappedFields(s, WORKFLOW_STATUS_FIELDS)) unmapped.add(key)
      const id = String(s.id)
      return {
        remoteId: id,
        name: str(s.name) ?? id,
        stage: ctx.settings.statusStageMap[id] ?? defaults.get(id) ?? 'in-progress',
        sortOrder: Math.trunc(num(s.position) ?? 0),
        organizationId: ctx.organizationId,
      }
    })
  return { rows, warnings: [], unmapped: [...unmapped].sort() }
}
