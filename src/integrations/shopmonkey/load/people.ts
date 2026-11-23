/**
 * Loading the people and their settings (M5, MAPPING §3–§5): technicians for the Shopmonkey users the history
 * names, workflow statuses, customers with their contacts, vehicles with their notes, and the custom field values
 * on each. Each record is its own unit: a failure rolls back that record and the run carries on.
 */
import { db } from '@/lib/db'
import { SOURCE } from '../extract/stage'
import type { CustomFieldValueRow } from '../transform/customer'
import { transformCustomer } from '../transform/customer'
import { transformUser, transformWorkflowStatuses } from '../transform/staff'
import { currentOwner, transformVehicle } from '../transform/vehicle'
import type { Row } from '../transform/types'
import { payloadHash } from '../extract/stage'
import { clientOf, countsFor, type LoadContext, loadOne, type Tx } from './context'
import { findLoaded, foreignKeys, markLoaded } from './links'
import { upsertLinked } from './upsert'

export interface StagedRecord {
  remoteId: string
  payload: Row
  payloadHash: string
}

/** A table's staged records, a page at a time, in id order. Records Shopmonkey reports deleted are left out. */
export async function* staged(lc: LoadContext, table: string): AsyncGenerator<StagedRecord> {
  let cursor: string | undefined
  for (;;) {
    const page = await db.sourceRecord.findMany({
      where: {
        organizationId: lc.scope.organizationId,
        source: SOURCE,
        table,
        remoteDeletedAt: null,
      },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, remoteId: true, payload: true, payloadHash: true },
    })
    for (const r of page)
      yield { remoteId: r.remoteId, payload: r.payload as Row, payloadHash: r.payloadHash }
    if (page.length < 500) return
    cursor = page[page.length - 1].id
  }
}

export async function stagedAll(lc: LoadContext, table: string): Promise<StagedRecord[]> {
  const out: StagedRecord[] = []
  for await (const r of staged(lc, table)) out.push(r)
  return out
}

/** A field's machine name from its label: what upstream's custom field screen would make of it. */
export const fieldName = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'field'

/** The custom fields the importer makes itself (§3, §6.6): their labels are translated, Shopmonkey's aren't. */
const OWN_FIELDS = new Set(['Customer type', 'Labels', 'Referral source'])

/** Custom field values on a row: the definition created on first sight (MAPPING §3), the value set. */
export async function writeCustomFields(
  tx: Tx,
  lc: LoadContext,
  entityId: string,
  rows: CustomFieldValueRow[]
): Promise<void> {
  for (const row of rows) {
    const name = fieldName(row.name)
    let definition = await tx.customFieldDefinition.findUnique({
      where: {
        organizationId_name_entityType: {
          organizationId: lc.scope.organizationId,
          name,
          entityType: row.entityType,
        },
      },
      select: { id: true },
    })
    if (!definition) {
      definition = await tx.customFieldDefinition.create({
        data: {
          organizationId: lc.scope.organizationId,
          userId: lc.runUserId,
          // The name stays the English one's, so a workshop that changes language keeps one field; the label is
          // what the workshop reads.
          name,
          label: OWN_FIELDS.has(row.name) ? lc.label(row.name) : row.name,
          fieldType: 'text',
          entityType: row.entityType,
        },
        select: { id: true },
      })
      // Linked as the run's, so undo removes the fields this run defined and no other.
      await markLoaded(tx, lc.scope, {
        table: 'custom_field',
        model: 'CustomFieldDefinition',
        remoteId: `${row.entityType}:${name}`,
        localId: definition.id,
        hash: '',
        created: true,
      })
    }
    // Only the importer's own value is translated; Shopmonkey's free text stays as it was.
    const value = row.name === 'Customer type' ? lc.label(row.value) : row.value
    await tx.customFieldValue.upsert({
      where: { fieldId_entityId: { fieldId: definition.id, entityId } },
      create: { fieldId: definition.id, entityId, entityType: row.entityType, value },
      update: { value },
    })
  }
}

/** The Shopmonkey users the history names: on labor lines, as assigned technicians, on timesheets, as inspectors. */
export async function referencedUsers(lc: LoadContext): Promise<Set<string>> {
  const ids = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) ids.add(v)
  }
  for await (const o of staged(lc, 'order')) {
    for (const id of Array.isArray(o.payload.assignedTechnicianIds)
      ? o.payload.assignedTechnicianIds
      : [])
      add(id)
  }
  for await (const s of staged(lc, 'order_service')) {
    for (const l of Array.isArray(s.payload.labors) ? (s.payload.labors as Row[]) : [])
      add(l.technicianId)
  }
  for await (const t of staged(lc, 'timesheet')) add(t.payload.technicianId)
  for await (const i of staged(lc, 'inspection')) add(i.payload.completedById)
  return ids
}

/**
 * Technicians (MAPPING §3): one for every user the history names, or a user the operator chose to create; a user
 * the operator matched to an existing technician (`technicianMap`) is linked to it instead. No logins are made.
 */
export async function loadTechnicians(lc: LoadContext): Promise<void> {
  const named = await referencedUsers(lc)
  const map = lc.transform.settings.technicianMap
  for (const user of await stagedAll(lc, 'user')) {
    const choice = map[user.remoteId]
    if (!named.has(user.remoteId) && choice !== 'create' && !choice) {
      countsFor(lc, 'user').skipped++
      continue
    }
    await loadOne(lc, 'user', user.remoteId, async (tx) => {
      if (choice && choice !== 'create') {
        const own = await tx.technician.findFirst({
          where: { id: choice, organizationId: lc.scope.organizationId },
          select: { id: true },
        })
        if (own) {
          lc.resolver.set('user', user.remoteId, own.id)
          const hash = payloadHash({ user: user.payloadHash, mappedTo: own.id })
          const found = await findLoaded(tx, lc.scope, 'user', 'Technician', user.remoteId)
          if (found?.localId === own.id && found.hash === hash) return 'unchanged'
          await markLoaded(tx, lc.scope, {
            table: 'user',
            model: 'Technician',
            remoteId: user.remoteId,
            localId: own.id,
            hash,
            created: false,
          })
          return 'updated'
        }
      }
      const { rows } = transformUser(user.payload, lc.transform)
      const { localId, result } = await upsertLinked(
        tx,
        lc.scope,
        { table: 'user', model: 'Technician', remoteId: user.remoteId, hash: user.payloadHash },
        {
          create: async () => (await tx.technician.create({ data: rows, select: { id: true } })).id,
          update: async (id) => {
            await tx.technician.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: {
                name: rows.name,
                isActive: rows.isActive,
                ...(rows.color ? { color: rows.color } : {}),
              },
            })
          },
        }
      )
      lc.resolver.set('user', user.remoteId, localId)
      return result
    })
  }
}

/** Workflow statuses (MAPPING §3), each under the stage the operator chose, or the default (RESULTS S9). */
export async function loadWorkflowStatuses(lc: LoadContext): Promise<void> {
  const statuses = await stagedAll(lc, 'workflow_status')
  const hashes = new Map(statuses.map((s) => [s.remoteId, s.payloadHash]))
  const { rows } = transformWorkflowStatuses(
    statuses.map((s) => s.payload),
    lc.transform
  )
  for (const row of rows) {
    await loadOne(lc, 'workflow_status', row.remoteId, async (tx) => {
      // The stage is part of what was loaded: a changed mapping updates the status.
      const hash = payloadHash({ source: hashes.get(row.remoteId), stage: row.stage })
      const { localId, result } = await upsertLinked(
        tx,
        lc.scope,
        { table: 'workflow_status', model: 'WorkOrderStatus', remoteId: row.remoteId, hash },
        {
          create: async () =>
            (
              await tx.workOrderStatus.create({
                data: {
                  name: row.name,
                  stage: row.stage,
                  sortOrder: row.sortOrder,
                  organizationId: row.organizationId,
                },
                select: { id: true },
              })
            ).id,
          update: async (id) => {
            await tx.workOrderStatus.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: { name: row.name, stage: row.stage, sortOrder: row.sortOrder },
            })
          },
        }
      )
      lc.resolver.set('workflow_status', row.remoteId, localId)
      return result
    })
  }
}

/**
 * Customers (MAPPING §4) with their contacts and custom fields. A numeric `publicId` becomes the customer number
 * when no other customer has it; the rest are numbered after every such id is placed, from the workshop's highest
 * number + 1 (from 1001), the way `createCustomer` numbers.
 */
export async function loadCustomers(lc: LoadContext): Promise<number> {
  const lookups = {
    referralSources: Object.fromEntries(
      (await stagedAll(lc, 'referral_source')).map((r) => [r.remoteId, r.payload])
    ),
    labels: Object.fromEntries((await stagedAll(lc, 'label')).map((r) => [r.remoteId, r.payload])),
  }
  const customers = await stagedAll(lc, 'customer')
  const client = clientOf(lc)
  const taken = new Set(
    (
      await client.customer.findMany({
        where: { organizationId: lc.scope.organizationId, customerNumber: { not: null } },
        select: { customerNumber: true },
      })
    ).map((c) => c.customerNumber as string)
  )
  const transformed = customers.map((c) => ({
    record: c,
    result: transformCustomer(c.payload, lc.transform, lookups),
  }))
  // Numeric publicIds first, each once; then the rest after the highest.
  const candidates = new Map<string, number>()
  for (const { result } of transformed) {
    const n = result.rows?.customerNumberCandidate
    if (n) candidates.set(n, (candidates.get(n) ?? 0) + 1)
  }
  // A reduce, not Math.max(...): a spread of 50,000 numbers can overflow the stack.
  let next = [...taken, ...candidates.keys()].reduce(
    (max, n) => (/^\d+$/.test(n) ? Math.max(max, Number(n)) : max),
    1000
  )
  let created = 0
  for (const { record, result } of transformed) {
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    if (!rows) {
      countsFor(lc, 'customer').skipped++
      continue
    }
    let createdHere = false
    const committed = await loadOne(lc, 'customer', record.remoteId, async (tx) => {
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        {
          table: 'customer',
          model: 'Customer',
          remoteId: record.remoteId,
          hash: record.payloadHash,
        },
        {
          create: async () => {
            const candidate = rows.customerNumberCandidate
            const number =
              candidate && candidates.get(candidate) === 1 && !taken.has(candidate)
                ? candidate
                : String(++next)
            taken.add(number)
            const row = await tx.customer.create({
              data: {
                ...rows.customer,
                customerNumber: number,
                importBatchId: lc.batches.customers ?? null,
              },
              select: { id: true },
            })
            createdHere = true
            return row.id
          },
          update: async (id) => {
            const {
              userId: _user,
              organizationId: _org,
              createdAt: _created,
              ...fields
            } = rows.customer
            await tx.customer.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: fields,
            })
            await tx.customerContact.deleteMany({
              where: { customerId: id, organizationId: lc.scope.organizationId },
            })
          },
        }
      )
      if (outcome !== 'unchanged') {
        if (rows.contacts.length) {
          await tx.customerContact.createMany({
            data: rows.contacts.map(({ remoteId: _r, ...c }) => ({
              ...c,
              customerId: localId,
              organizationId: lc.scope.organizationId,
            })),
          })
        }
        await writeCustomFields(tx, lc, localId, rows.customFields)
      }
      lc.resolver.set('customer', record.remoteId, localId)
      return outcome
    })
    if (committed && createdHere) created++
  }
  return created
}

/**
 * Vehicles (MAPPING §5) with their note and custom fields; the owner is the newest `vehicle_owner` row. The hash
 * covers the owner rows, so a change of owner updates the vehicle. Returns how many it created, and the unit system
 * the oldest vehicle names (MAPPING §5: the first vehicle sets the workshop's unit).
 */
export async function loadVehicles(
  lc: LoadContext
): Promise<{ created: number; mileageUnit: string | null }> {
  const owners = new Map<string, Row[]>()
  for await (const o of staged(lc, 'vehicle_owner')) {
    const vehicleId = typeof o.payload.vehicleId === 'string' ? o.payload.vehicleId : null
    if (vehicleId) owners.set(vehicleId, [...(owners.get(vehicleId) ?? []), o.payload])
  }
  const vehicles = await stagedAll(lc, 'vehicle')
  let created = 0
  let mileageUnit: string | null = null
  const oldest = [...vehicles].sort(
    (a, b) =>
      String(a.payload.createdDate ?? '').localeCompare(String(b.payload.createdDate ?? '')) ||
      (a.remoteId < b.remoteId ? -1 : 1)
  )[0]
  for (const record of vehicles) {
    const ownerRows = owners.get(record.remoteId) ?? []
    const result = transformVehicle(record.payload, ownerRows, lc.transform)
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    if (!rows) {
      countsFor(lc, 'vehicle').skipped++
      continue
    }
    if (record === oldest) mileageUnit = rows.mileageUnit
    const hash = payloadHash({
      vehicle: record.payloadHash,
      owner: currentOwner(ownerRows).customerId,
      // The owner as loaded: a customer created again re-points the vehicle.
      ids: foreignKeys(rows.vehicle),
    })
    let createdHere = false
    const committed = await loadOne(lc, 'vehicle', record.remoteId, async (tx) => {
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        { table: 'vehicle', model: 'Vehicle', remoteId: record.remoteId, hash },
        {
          create: async () => {
            const row = await tx.vehicle.create({
              data: { ...rows.vehicle, importBatchId: lc.batches.vehicles ?? null },
              select: { id: true },
            })
            createdHere = true
            return row.id
          },
          update: async (id) => {
            const {
              userId: _user,
              organizationId: _org,
              createdAt: _created,
              ...fields
            } = rows.vehicle
            await tx.vehicle.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: fields,
            })
          },
        }
      )
      if (outcome !== 'unchanged') {
        await writeVehicleNote(tx, lc, record.remoteId, localId, rows.note)
        await writeCustomFields(tx, lc, localId, rows.customFields)
      }
      lc.resolver.set('vehicle', record.remoteId, localId)
      return outcome
    })
    if (committed && createdHere) created++
  }
  return { created, mileageUnit }
}

/**
 * The vehicle's Shopmonkey note (MAPPING §5), linked so a changed note updates it. One removed in Shopmonkey is
 * left as it is: the workshop may have added to it.
 */
async function writeVehicleNote(
  tx: Tx,
  lc: LoadContext,
  vehicleRemoteId: string,
  vehicleId: string,
  note: { title: string; content: string } | null
): Promise<void> {
  if (!note) return
  const title = note.title
  const found = await findLoaded(tx, lc.scope, 'vehicle_note', 'Note', vehicleRemoteId)
  const hash = payloadHash({ title, content: note.content })
  if (found?.hash === hash) return
  let id = found?.localId
  if (id) {
    await tx.note.updateMany({
      where: { id, vehicle: { organizationId: lc.scope.organizationId } },
      data: { title, content: note.content },
    })
  } else {
    id = (
      await tx.note.create({
        data: { title, content: note.content, vehicleId },
        select: { id: true },
      })
    ).id
  }
  await markLoaded(tx, lc.scope, {
    table: 'vehicle_note',
    model: 'Note',
    remoteId: vehicleRemoteId,
    localId: id,
    hash,
    created: !found,
  })
}
