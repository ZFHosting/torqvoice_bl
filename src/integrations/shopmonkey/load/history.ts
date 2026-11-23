/**
 * Loading what hangs off the orders (M5 task 4; MAPPING §3, §8): appointments (and the start of the work order they
 * were booked for), inspection templates and inspections (with their photos), time entries and shifts.
 */
import { SOURCE } from '../extract/stage'
import { transformInspection, transformInspectionTemplate } from '../transform/inspection'
import { transformAppointment, transformTimesheet } from '../transform/time'
import type { Row } from '../transform/types'
import { countsFor, type LoadContext, loadOne } from './context'
import { placeFile, stagedFile } from './files'
import { stagedAll } from './people'
import { upsertLinked } from './upsert'

export async function loadAppointments(lc: LoadContext): Promise<void> {
  for (const record of await stagedAll(lc, 'appointment')) {
    const result = transformAppointment(record.payload, lc.transform)
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    if (!rows) {
      countsFor(lc, 'appointment').skipped++
      continue
    }
    await loadOne(lc, 'appointment', record.remoteId, async (tx) => {
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        {
          table: 'appointment',
          model: 'Appointment',
          remoteId: record.remoteId,
          hash: record.payloadHash,
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
      const orderId = rows.orderRemoteId ? lc.resolver.resolve('order', rows.orderRemoteId) : null
      if (orderId && outcome !== 'unchanged') {
        await tx.serviceRecord.updateMany({
          where: { id: orderId, organizationId: lc.scope.organizationId },
          data: { startDateTime: rows.appointment.startAt },
        })
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
      countsFor(lc, 'inspection_template').skipped++
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
      countsFor(lc, 'inspection').skipped++
      continue
    }
    const pending: string[] = []
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
            select: { remoteId: true, payload: true },
          })
        : []
      const fileById = new Map(files.map((f) => [f.remoteId, f.payload as Row]))
      const writeItems = async (inspectionId: string) => {
        for (const { remoteId: _r, photoRemoteIds, ...item } of rows.items) {
          const imageUrls: string[] = []
          for (const id of photoRemoteIds) {
            const staged = fileById.get(id)
            const file = staged ? stagedFile(staged) : null
            if (file) imageUrls.push(await placeFile(lc, file, pending))
          }
          await tx.inspectionItem.create({ data: { ...item, imageUrls, inspectionId } })
        }
      }
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        {
          table: 'inspection',
          model: 'Inspection',
          remoteId: record.remoteId,
          hash: record.payloadHash,
        },
        {
          create: async () => {
            const inspection = await tx.inspection.create({
              data: { ...rows.inspection, importBatchId: lc.batches.inspections ?? null },
              select: { id: true },
            })
            created++
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
        }
      )
      // The work order it was done on points at it, unless the workshop has linked another since.
      const orderId = rows.orderRemoteId ? lc.resolver.resolve('order', rows.orderRemoteId) : null
      if (orderId) {
        await tx.serviceRecord.updateMany({
          where: { id: orderId, organizationId: lc.scope.organizationId, inspectionId: null },
          data: { inspectionId: localId },
        })
      }
      lc.resolver.set('inspection', record.remoteId, localId)
      return outcome
    })
    if (committed) lc.placedFiles.push(...pending)
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
      countsFor(lc, 'timesheet').skipped++
      continue
    }
    await loadOne(lc, 'timesheet', record.remoteId, async (tx) => {
      const scope = { table: 'timesheet', remoteId: record.remoteId, hash: record.payloadHash }
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
