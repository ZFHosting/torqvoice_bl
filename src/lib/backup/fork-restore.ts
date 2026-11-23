/**
 * fork: restoring the BlueLabel fork's tables and columns from a backup (prisma/schema/fork.prisma,
 * docs/fork/FORK.md). Kept out of import.ts so upstream's restore carries only one-line calls marked
 * `// fork:`, and an upstream merge touches as little as possible.
 *
 * The same rules as the rest of the restore: every row is stamped with the restoring workshop, a
 * reference to something this restore didn't bring back (a technician, a member, a job) is dropped
 * rather than left dangling, and dates arrive as ISO strings.
 */
import type { Prisma } from '@/generated/prisma/client'
import type { TxClient } from '@/lib/db'
import { toSafeDate } from '@/lib/invoice-utils'

type Row = Record<string, unknown>

function rowsOf(value: unknown): Row[] {
  if (Array.isArray(value)) return value.filter((v): v is Row => !!v && typeof v === 'object')
  return value && typeof value === 'object' ? [value as Row] : []
}
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const int = (value: unknown): number | null => {
  const n = num(value)
  return n === null ? null : Math.round(n)
}
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
const date = (value: unknown): Date | null =>
  typeof value === 'string' ? (toSafeDate(value) ?? null) : null
/** A JSON column: left NULL when absent, since Prisma takes no plain null for one. */
const json = (value: unknown): Prisma.InputJsonValue | undefined =>
  value !== null && typeof value === 'object' ? (value as Prisma.InputJsonValue) : undefined
const kept = (id: unknown, restored: ReadonlySet<string> | undefined): string | null =>
  typeof id === 'string' && restored?.has(id) ? id : null
const stamps = (row: Row) => ({
  createdAt: date(row.createdAt) ?? undefined,
  updatedAt: date(row.updatedAt) ?? undefined,
})

/** The fork's top-level tables a restore clears before writing (manifest `clearOrder`). */
export function forkClearable(
  tx: TxClient,
  organizationId: string
): Record<string, () => Promise<unknown>> {
  return {
    SourceRecord: () => tx.sourceRecord.deleteMany({ where: { organizationId } }),
    DeletedRecord: () => tx.deletedRecord.deleteMany({ where: { organizationId } }),
  }
}

/**
 * A work order's or a quote's jobs (X2). Written before the lines that point at them; returns the
 * ids restored, so a line keeps its job only when the job came back too.
 */
export async function restoreWorkJobs(
  tx: TxClient,
  rows: unknown,
  owner: { organizationId: string; serviceRecordId?: string; quoteId?: string }
): Promise<Set<string>> {
  const jobs = rowsOf(rows).filter((j) => typeof j.id === 'string' && typeof j.name === 'string')
  if (jobs.length > 0) {
    await tx.workJob.createMany({
      data: jobs.map((j) => ({
        id: j.id as string,
        organizationId: owner.organizationId,
        serviceRecordId: owner.serviceRecordId ?? null,
        quoteId: owner.quoteId ?? null,
        name: j.name as string,
        note: text(j.note),
        ordinal: int(j.ordinal) ?? 0,
        authorizationStatus: text(j.authorizationStatus),
        recommended: j.recommended === true,
        hidden: j.hidden === true,
        lumpSum: j.lumpSum === true,
        fixedPrice: num(j.fixedPrice),
        deferredDate: date(j.deferredDate),
        deferredReason: text(j.deferredReason),
        totalAmount: num(j.totalAmount) ?? 0,
        discountAmount: num(j.discountAmount) ?? 0,
        taxAmount: num(j.taxAmount) ?? 0,
        ...stamps(j),
      })),
    })
  }
  return new Set(jobs.map((j) => j.id as string))
}

/** The fork's columns on a part line (ServicePart, QuotePart; X2, X3). */
export function forkPartColumns(line: Row, jobIds: ReadonlySet<string>) {
  return {
    jobId: kept(line.jobId, jobIds),
    lineKind: text(line.lineKind),
    discountAmount: num(line.discountAmount),
    note: text(line.note),
    sourceExtra: json(line.sourceExtra),
  }
}

/** The fork's columns on a labor line (ServiceLabor, QuoteLabor; X2, X3). */
export function forkLaborColumns(
  line: Row,
  jobIds: ReadonlySet<string>,
  technicianIds: ReadonlySet<string>
) {
  return {
    jobId: kept(line.jobId, jobIds),
    lineKind: text(line.lineKind),
    technicianId: kept(line.technicianId, technicianIds),
    completed: bool(line.completed),
    costHours: num(line.costHours),
    costRate: num(line.costRate),
    discountAmount: num(line.discountAmount),
    sourceExtra: json(line.sourceExtra),
  }
}

/** A work order's extra facts (X5), one row or none. */
export async function restoreServiceRecordMeta(
  tx: TxClient,
  value: unknown,
  owner: { organizationId: string; serviceRecordId: string; memberUserIds: ReadonlySet<string> }
) {
  const meta = rowsOf(value)[0]
  if (!meta || typeof meta.id !== 'string') return
  await tx.serviceRecordMeta.create({
    data: {
      id: meta.id,
      organizationId: owner.organizationId,
      serviceRecordId: owner.serviceRecordId,
      sourceStatus: text(meta.sourceStatus),
      // Only a member of the restored workshop; a backup from elsewhere names nobody here.
      serviceWriterUserId: kept(meta.serviceWriterUserId, owner.memberUserIds),
      serviceWriterName: text(meta.serviceWriterName),
      mileageOut: int(meta.mileageOut),
      labels: Array.isArray(meta.labels)
        ? meta.labels.filter((l): l is string => typeof l === 'string')
        : [],
      authorizedAt: date(meta.authorizedAt),
      completedAt: date(meta.completedAt),
      fullyPaidAt: date(meta.fullyPaidAt),
      purchaseOrderNumber: text(meta.purchaseOrderNumber),
      ...stamps(meta),
    },
  })
}

/** Customers' extra emails and phones (X4), for the customers this restore wrote. */
export async function restoreCustomerContacts(
  tx: TxClient,
  customers: unknown,
  organizationId: string
) {
  const contacts = rowsOf(customers).flatMap((c) =>
    rowsOf(c.contacts).map((contact) => ({ contact, customerId: c.id }))
  )
  const rows = contacts.filter(
    ({ contact, customerId }) =>
      typeof contact.id === 'string' &&
      typeof customerId === 'string' &&
      typeof contact.kind === 'string' &&
      typeof contact.value === 'string'
  )
  if (rows.length === 0) return
  await tx.customerContact.createMany({
    data: rows.map(({ contact, customerId }) => ({
      id: contact.id as string,
      organizationId,
      customerId: customerId as string,
      kind: contact.kind as string,
      value: contact.value as string,
      label: text(contact.label),
      isPrimary: contact.isPrimary === true,
      marketingOptIn: bool(contact.marketingOptIn),
      subscribed: bool(contact.subscribed),
      ...stamps(contact),
    })),
  })
}

/** Technicians' shifts (X6), for the technicians this restore wrote. */
export async function restoreTechnicianShifts(
  tx: TxClient,
  technicians: unknown,
  organizationId: string,
  technicianIds: ReadonlySet<string>
) {
  // Each shift belongs to the technician it is nested under, whatever id the file wrote on it.
  const shifts = rowsOf(technicians)
    .flatMap((t) => rowsOf(t.shifts).map((shift) => ({ shift, technicianId: t.id })))
    .filter(
      ({ shift, technicianId }) =>
        typeof shift.id === 'string' &&
        typeof technicianId === 'string' &&
        technicianIds.has(technicianId) &&
        date(shift.clockIn) !== null
    )
  if (shifts.length === 0) return
  await tx.technicianShift.createMany({
    data: shifts.map(({ shift: s, technicianId }) => ({
      id: s.id as string,
      organizationId,
      technicianId: technicianId as string,
      clockIn: date(s.clockIn) as Date,
      clockOut: date(s.clockOut),
      durationMinutes: int(s.durationMinutes),
      note: text(s.note),
      source: text(s.source) ?? 'app',
      sourceRemoteId: text(s.sourceRemoteId),
      ...stamps(s),
    })),
  })
}

/** One archived source payload (X1) as the restoring workshop's row, or null when it isn't one. */
export function sourceRecordRow(
  r: Row,
  organizationId: string
): Prisma.SourceRecordCreateManyInput | null {
  if (
    typeof r.id !== 'string' ||
    typeof r.connectionId !== 'string' ||
    typeof r.table !== 'string' ||
    typeof r.remoteId !== 'string' ||
    typeof r.payloadHash !== 'string' ||
    json(r.payload) === undefined
  ) {
    return null
  }
  return {
    id: r.id,
    organizationId,
    connectionId: r.connectionId,
    source: text(r.source) ?? 'shopmonkey',
    table: r.table,
    remoteId: r.remoteId,
    payload: json(r.payload) as Prisma.InputJsonValue,
    payloadHash: r.payloadHash,
    remoteUpdatedAt: date(r.remoteUpdatedAt),
    fetchedAt: date(r.fetchedAt) ?? undefined,
    remoteDeletedAt: date(r.remoteDeletedAt),
    childrenHash: text(r.childrenHash),
    ...stamps(r),
  }
}

/**
 * The archive of imported source payloads (X1) and the delete tombstones API clients sync from.
 * Both stand alone: a source record names its connection by id only, because connections (and their
 * credentials) never travel in a backup.
 */
export async function restoreForkArchive(
  tx: TxClient,
  data: Record<string, unknown>,
  organizationId: string,
  memberUserIds: ReadonlySet<string>
) {
  // Backups since M3 carry the archive in its own file (fork-archive.ts); older ones carry it here.
  const sources = rowsOf(data.sourceRecords)
    .map((r) => sourceRecordRow(r, organizationId))
    .filter((r): r is Prisma.SourceRecordCreateManyInput => r !== null)
  if (sources.length > 0) await tx.sourceRecord.createMany({ data: sources })

  const tombstones = rowsOf(data.deletedRecords).filter(
    (r) =>
      typeof r.id === 'string' && typeof r.entityType === 'string' && typeof r.entityId === 'string'
  )
  if (tombstones.length > 0) {
    await tx.deletedRecord.createMany({
      data: tombstones.map((r) => ({
        id: r.id as string,
        organizationId,
        entityType: r.entityType as string,
        entityId: r.entityId as string,
        deletedAt: date(r.deletedAt) ?? undefined,
        // Who deleted it, when that person is in this workshop.
        actorUserId: kept(r.actorUserId, memberUserIds),
      })),
    })
  }
}
