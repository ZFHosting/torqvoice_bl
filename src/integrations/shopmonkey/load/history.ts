/**
 * Loading what hangs off the orders (M5 task 4; MAPPING §3, §8): appointments (and the start of the work order they
 * were booked for), inspection templates and inspections (with their photos), time entries and shifts.
 */
import { payloadHash, SOURCE } from '../extract/stage'
import { transformInspection, transformInspectionTemplate } from '../transform/inspection'
import { transformAppointment, transformTimesheet } from '../transform/time'
import type { Row } from '../transform/types'
import { type LoadContext, loadOne, skipReason, skipRecord } from './context'
import { placeFile, stagedFile } from './files'
import { stagedAll } from './people'
import { foreignKeys, linkedRow, markLoaded, noteWritten, unlink } from './links'
import { upsertLinked } from './upsert'

export async function loadAppointments(lc: LoadContext): Promise<void> {
  for (const record of await stagedAll(lc, 'appointment')) {
    const result = transformAppointment(record.payload, lc.transform)
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    if (!rows) {
      skipRecord(
        lc,
        'appointment',
        record.remoteId,
        skipReason(lc, 'appointment', record.remoteId, record.payload)
      )
      continue
    }
    // The work order it was booked for, as loaded: part of the hash, so a work order loaded late gets its start.
    const orderId = rows.orderRemoteId ? lc.resolver.resolve('order', rows.orderRemoteId) : null
    await loadOne(lc, 'appointment', record.remoteId, async (tx) => {
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        {
          table: 'appointment',
          model: 'Appointment',
          remoteId: record.remoteId,
          hash: payloadHash({ source: record.payloadHash, ids: foreignKeys(rows), orderId }),
        },
        {
          create: async () =>
            (
              await tx.appointment.create({
                data: { ...rows.appointment, createdById: lc.runUserId },
                select: { id: true },
              })
            ).id,
          update: async (id) => {
            const { organizationId: _o, createdAt: _c, ...fields } = rows.appointment
            await tx.appointment.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: fields,
            })
          },
        }
      )
      // §3: the work order the appointment was booked for starts when it does.
      if (orderId && outcome !== 'unchanged') {
        const moved = await tx.serviceRecord.updateMany({
          where: { id: orderId, organizationId: lc.scope.organizationId },
          data: { startDateTime: rows.appointment.startAt },
        })
        if (moved.count) noteWritten(lc.scope, 'ServiceRecord', orderId)
      }
      lc.resolver.set('appointment', record.remoteId, localId)
      return outcome
    })
  }
}

export async function loadInspectionTemplates(lc: LoadContext): Promise<void> {
  for (const record of await stagedAll(lc, 'inspection_template')) {
    const result = transformInspectionTemplate(record.payload, lc.transform)
    const rows = result.rows
    if (!rows) {
      skipRecord(
        lc,
        'inspection_template',
        record.remoteId,
        skipReason(lc, 'inspection_template', record.remoteId, record.payload)
      )
      continue
    }
    await loadOne(lc, 'inspection_template', record.remoteId, async (tx) => {
      const write = async (templateId: string) => {
        const section = await tx.inspectionTemplateSection.create({
          data: { ...rows.section, templateId },
          select: { id: true },
        })
        if (rows.items.length) {
          await tx.inspectionTemplateItem.createMany({
            data: rows.items.map(({ remoteId: _r, ...item }) => ({
              ...item,
              sectionId: section.id,
            })),
          })
        }
      }
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        {
          table: 'inspection_template',
          model: 'InspectionTemplate',
          remoteId: record.remoteId,
          hash: record.payloadHash,
        },
        {
          create: async () => {
            const template = await tx.inspectionTemplate.create({
              data: rows.template,
              select: { id: true },
            })
            await write(template.id)
            return template.id
          },
          update: async (id) => {
            const { organizationId: _o, createdAt: _c, ...fields } = rows.template
            await tx.inspectionTemplate.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: fields,
            })
            await tx.inspectionTemplateSection.deleteMany({ where: { templateId: id } })
            await write(id)
          },
        }
      )
      lc.resolver.set('inspection_template', record.remoteId, localId)
      return outcome
    })
  }
}

/**
 * Inspections (§8) against their imported template, on their order's vehicle, linked to the order's work order.
 * Photos are the staged `inspection_file` records, placed in uploads and listed in their item's `imageUrls`.
 */
export async function loadInspections(lc: LoadContext): Promise<number> {
  const orders = new Map((await stagedAll(lc, 'order')).map((o) => [o.remoteId, o.payload]))
  let created = 0
  for (const record of await stagedAll(lc, 'inspection')) {
    const orderRemote = typeof record.payload.orderId === 'string' ? record.payload.orderId : null
    const result = transformInspection(
      record.payload,
      orderRemote ? (orders.get(orderRemote) ?? null) : null,
      lc.transform
    )
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    if (!rows) {
      skipRecord(
        lc,
        'inspection',
        record.remoteId,
        skipReason(lc, 'inspection', record.remoteId, record.payload)
      )
      continue
    }
    const pending: string[] = []
    let createdHere = false
    const orderId = rows.orderRemoteId ? lc.resolver.resolve('order', rows.orderRemoteId) : null
    const committed = await loadOne(lc, 'inspection', record.remoteId, async (tx) => {
      const photos = rows.items.flatMap((i) => i.photoRemoteIds)
      const files = photos.length
        ? await tx.sourceRecord.findMany({
            where: {
              organizationId: lc.scope.organizationId,
              source: SOURCE,
              table: 'inspection_file',
              remoteId: { in: photos },
            },
            select: { remoteId: true, payload: true, payloadHash: true },
          })
        : []
      const fileById = new Map(files.map((f) => [f.remoteId, f.payload as Row]))
      // A staged photo that couldn't be placed (gone from disk): the inspection is written again next time.
      let incomplete = false
      const writeItems = async (inspectionId: string) => {
        for (const { remoteId: _r, photoRemoteIds, ...item } of rows.items) {
          const imageUrls: string[] = []
          for (const id of photoRemoteIds) {
            const payload = fileById.get(id)
            const url = payload
              ? await placeFile(
                  tx,
                  lc,
                  { table: 'inspection_file', remoteId: id, payload },
                  pending
                )
              : null
            if (url) imageUrls.push(url)
            else if (payload && stagedFile(payload)) incomplete = true
          }
          await tx.inspectionItem.create({ data: { ...item, imageUrls, inspectionId } })
        }
      }
      const linked = {
        table: 'inspection',
        model: 'Inspection' as const,
        remoteId: record.remoteId,
        // Its photos too: one staged (or forgotten) since makes the items be written again; and the rows it
        // points at (vehicle, template, work order).
        hash: payloadHash({
          inspection: record.payloadHash,
          ids: foreignKeys(rows),
          orderId,
          photos: files
            .map((f) => [f.remoteId, f.payloadHash])
            .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        }),
      }
      const { localId, result: outcome } = await upsertLinked(tx, lc.scope, linked, {
        create: async () => {
          const inspection = await tx.inspection.create({
            data: { ...rows.inspection, importBatchId: lc.batches.inspections ?? null },
            select: { id: true },
          })
          createdHere = true
          await writeItems(inspection.id)
          return inspection.id
        },
        update: async (id) => {
          const { organizationId: _o, createdAt: _c, ...fields } = rows.inspection
          await tx.inspection.updateMany({
            where: { id, organizationId: lc.scope.organizationId },
            data: fields,
          })
          await tx.inspectionItem.deleteMany({ where: { inspectionId: id } })
          await writeItems(id)
        },
      })
      // The work order it was done on points at it, unless the workshop has linked another since.
      if (orderId) {
        const pointed = await tx.serviceRecord.updateMany({
          where: { id: orderId, organizationId: lc.scope.organizationId, inspectionId: null },
          data: { inspectionId: localId },
        })
        if (pointed.count) noteWritten(lc.scope, 'ServiceRecord', orderId)
      }
      if (incomplete) {
        await markLoaded(tx, lc.scope, {
          ...linked,
          hash: 'incomplete',
          localId,
          created: outcome === 'created',
        })
      }
      lc.resolver.set('inspection', record.remoteId, localId)
      return outcome
    })
    if (committed) {
      lc.placedFiles.push(...pending)
      if (createdHere) created++
    }
  }
  return created
}

/** Timesheets (§3): a time entry on a loaded work order, a shift otherwise. */
export async function loadTime(lc: LoadContext): Promise<void> {
  for (const record of await stagedAll(lc, 'timesheet')) {
    const result = transformTimesheet(record.payload, lc.transform)
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    if (!rows) {
      skipRecord(
        lc,
        'timesheet',
        record.remoteId,
        skipReason(lc, 'timesheet', record.remoteId, record.payload)
      )
      continue
    }
    await loadOne(lc, 'timesheet', record.remoteId, async (tx) => {
      const scope = {
        table: 'timesheet',
        remoteId: record.remoteId,
        hash: payloadHash({ source: record.payloadHash, ids: foreignKeys(rows) }),
      }
      // A timesheet loaded as the other kind before (its order became, or stopped being, a loaded work order):
      // that row was the importer's stand-in for this same record, and goes.
      const other = rows.kind === 'timeEntry' ? 'TechnicianShift' : 'TimeEntry'
      const before = await linkedRow(tx, lc.scope, 'timesheet', other, record.remoteId)
      if (before) {
        if (other === 'TechnicianShift') {
          await tx.technicianShift.deleteMany({
            where: { id: before, organizationId: lc.scope.organizationId },
          })
        } else {
          await tx.timeEntry.deleteMany({
            where: { id: before, organizationId: lc.scope.organizationId },
          })
        }
        await unlink(tx, lc.scope, 'timesheet', other, record.remoteId, before)
      }
      if (rows.kind === 'timeEntry') {
        const { result: outcome } = await upsertLinked(
          tx,
          lc.scope,
          { ...scope, model: 'TimeEntry' },
          {
            create: async () =>
              (await tx.timeEntry.create({ data: rows.row, select: { id: true } })).id,
            update: async (id) => {
              const { organizationId: _o, ...fields } = rows.row
              await tx.timeEntry.updateMany({
                where: { id, organizationId: lc.scope.organizationId },
                data: fields,
              })
            },
          }
        )
        return outcome
      }
      const { result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        { ...scope, model: 'TechnicianShift' },
        {
          create: async () =>
            (await tx.technicianShift.create({ data: rows.row, select: { id: true } })).id,
          update: async (id) => {
            const { organizationId: _o, ...fields } = rows.row
            await tx.technicianShift.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: fields,
            })
          },
        }
      )
      return outcome
    })
  }
}
