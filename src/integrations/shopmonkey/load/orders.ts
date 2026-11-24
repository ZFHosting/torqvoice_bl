/**
 * Loading orders (M5 tasks 2, 4, 5; MAPPING §6): each order in one transaction, as a work order (with its jobs,
 * lines, concern, meta, helpers, payments, findings and custom field values) or a quote (jobs and lines, the lines
 * of a service that doesn't count marked `excluded`). If any part fails the order rolls back and is reported; the
 * run carries on. The hash covers the order and its children, so a changed service updates its order.
 *
 * Orders load oldest first, so a later order that revives a deferred service finds the finding it resolves.
 */
import { Prisma } from '@/generated/prisma/client'
import { payloadHash } from '../extract/stage'
import { type JobRows } from '../transform/lines'
import { transformOrder } from '../transform/order'
import { type PaymentRow, refundWarnings, transformPayment } from '../transform/payment'
import { userName } from '../transform/staff'
import type { Row } from '../transform/types'
import { createdBeforeHistory } from '../extract/engine'
import { orderSubtotalCents } from '../money'
import {
  clientOf,
  type LoadContext,
  loadOne,
  markSkip,
  skipReason,
  skipRecord,
  type Tx,
} from './context'
import { attachOrderFiles, indexOrderFiles } from './files'
import { findLoaded, foreignKeys, linkedRow, markLoaded } from './links'
import { staged, stagedAll, writeCustomFields } from './people'
import { upsertLinked } from './upsert'

interface ChildIndex {
  /** order id → its children's ids and hashes (payloads are read per order, not all at once). */
  services: Map<string, { remoteId: string; hash: string }[]>
  payments: Map<string, { remoteId: string; hash: string }[]>
  authorizations: Map<string, { remoteId: string; hash: string }[]>
}

async function indexChildren(lc: LoadContext, table: string): Promise<ChildIndex['services']> {
  const out: ChildIndex['services'] = new Map()
  for await (const r of staged(lc, table)) {
    const orderId = typeof r.payload.orderId === 'string' ? r.payload.orderId : null
    if (!orderId) continue
    out.set(orderId, [...(out.get(orderId) ?? []), { remoteId: r.remoteId, hash: r.payloadHash }])
  }
  return out
}

async function payloads(lc: LoadContext, table: string, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return []
  const rows = await clientOf(lc).sourceRecord.findMany({
    where: {
      organizationId: lc.scope.organizationId,
      source: 'shopmonkey',
      table,
      remoteId: { in: ids },
    },
    select: { payload: true },
  })
  return rows.map((r) => r.payload as Row)
}

const json = (value: unknown) =>
  value === null || value === undefined ? undefined : (value as Prisma.InputJsonValue)

/** The jobs and their lines, written fresh (after a create, or after the old ones were removed). */
async function writeJobs(
  tx: Tx,
  lc: LoadContext,
  owner: { serviceRecordId: string } | { quoteId: string },
  jobs: JobRows[]
) {
  const organizationId = lc.scope.organizationId
  for (const j of jobs) {
    const job = await tx.workJob.create({
      data: { ...j.job, ...owner, organizationId },
      select: { id: true },
    })
    if ('serviceRecordId' in owner) {
      if (j.labor.length) {
        await tx.serviceLabor.createMany({
          data: j.labor.map(({ remoteId: _r, sortOrder: _s, sourceExtra, ...l }) => ({
            ...l,
            sourceExtra: json(sourceExtra),
            jobId: job.id,
            serviceRecordId: owner.serviceRecordId,
          })),
        })
      }
      if (j.parts.length) {
        await tx.servicePart.createMany({
          data: j.parts.map(({ remoteId: _r, sortOrder: _s, sourceExtra, ...p }) => ({
            ...p,
            sourceExtra: json(sourceExtra),
            jobId: job.id,
            serviceRecordId: owner.serviceRecordId,
          })),
        })
      }
    } else {
      // §6.3: a service that doesn't count keeps its lines, marked excluded from the quote's totals.
      if (j.labor.length) {
        await tx.quoteLabor.createMany({
          data: j.labor.map(({ remoteId: _r, sourceExtra, ...l }) => ({
            ...l,
            excluded: !j.counts,
            sourceExtra: json(sourceExtra),
            jobId: job.id,
            quoteId: owner.quoteId,
          })),
        })
      }
      if (j.parts.length) {
        await tx.quotePart.createMany({
          data: j.parts.map(({ remoteId: _r, sourceExtra, ...p }) => ({
            ...p,
            excluded: !j.counts,
            sourceExtra: json(sourceExtra),
            jobId: job.id,
            quoteId: owner.quoteId,
          })),
        })
      }
    }
  }
}

export interface OrdersResult {
  createdServiceRecords: number
}

export async function loadOrders(lc: LoadContext): Promise<OrdersResult> {
  const index: ChildIndex = {
    services: await indexChildren(lc, 'order_service'),
    payments: await indexChildren(lc, 'payment'),
    authorizations: await indexChildren(lc, 'authorization'),
  }
  const fileIndex = await indexOrderFiles(lc)
  const owners = new Map<string, { customerId: string | null; createdDate: string }>()
  for await (const o of staged(lc, 'vehicle_owner')) {
    const vehicleId = typeof o.payload.vehicleId === 'string' ? o.payload.vehicleId : null
    if (!vehicleId) continue
    const createdDate = String(o.payload.createdDate ?? '')
    const before = owners.get(vehicleId)
    if (!before || createdDate > before.createdDate) {
      owners.set(vehicleId, {
        customerId: typeof o.payload.customerId === 'string' ? o.payload.customerId : null,
        createdDate,
      })
    }
  }
  const userNames = Object.fromEntries(
    (await stagedAll(lc, 'user')).map((u) => [u.remoteId, userName(u.payload)])
  )
  const taxConfig = (await stagedAll(lc, 'tax_config'))[0]?.payload ?? null
  // Oldest first: a revived service's finding was made by the earlier order.
  const orders = (await stagedAll(lc, 'order')).sort(
    (a, b) =>
      String(a.payload.createdDate ?? '').localeCompare(String(b.payload.createdDate ?? '')) ||
      (a.remoteId < b.remoteId ? -1 : 1)
  )
  let createdServiceRecords = 0

  /** An order that isn't a work order here keeps its payments and files in the archive: said so (M6). */
  const notOnWorkOrder = (orderId: string) => {
    for (const p of index.payments.get(orderId) ?? [])
      markSkip(lc, 'payment', p.remoteId, 'payment_order_not_loaded')
    for (const f of fileIndex.get(orderId) ?? [])
      markSkip(lc, 'order_file', f, 'files_not_on_work_order')
    markSkip(lc, 'invoice_pdf', orderId, 'files_not_on_work_order')
  }

  for (const order of orders) {
    // Created before `historyFrom`: staged without its children, and kept in the archive only (M6).
    if (createdBeforeHistory(order.payload, lc.historyFrom)) {
      skipRecord(lc, 'order', order.remoteId, 'history')
      notOnWorkOrder(order.remoteId)
      continue
    }
    const children = (map: ChildIndex['services']) =>
      (map.get(order.remoteId) ?? []).sort((a, b) => (a.remoteId < b.remoteId ? -1 : 1))
    const vehicleRemote =
      typeof order.payload.vehicleId === 'string' ? order.payload.vehicleId : null
    const owner = vehicleRemote ? (owners.get(vehicleRemote)?.customerId ?? null) : null
    const workflow =
      typeof order.payload.workflowStatusId === 'string' ? order.payload.workflowStatusId : ''
    const services = await payloads(
      lc,
      'order_service',
      children(index.services).map((c) => c.remoteId)
    )
    const authorizations = await payloads(
      lc,
      'authorization',
      children(index.authorizations).map((c) => c.remoteId)
    )
    const result = transformOrder(
      order.payload,
      { services, vehicleOwnerRemoteId: owner, taxConfig, userNames, authorizations },
      lc.transform,
      lc.now
    )
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    // M6: Shopmonkey's own lines and subtotal disagree: what the lines came to here is what a later difference
    // may be explained by, and nothing else.
    if (
      rows?.kind === 'serviceRecord' &&
      result.warnings.some((w) => w.code === 'money_mismatch' && w.field === 'subtotal')
    ) {
      lc.mismatchedLines.set(order.remoteId, {
        lines: Math.round(rows.record.subtotal * 100),
        subtotal: orderSubtotalCents(order.payload),
      })
    }
    if (!rows) {
      skipRecord(
        lc,
        'order',
        order.remoteId,
        skipReason(lc, 'order', order.remoteId, order.payload)
      )
      notOnWorkOrder(order.remoteId)
      continue
    }
    // Everything the rows depend on: the order, its children, the vehicle's owner, its status's stage, and the
    // local rows it points at (a vehicle or technician created again re-points it).
    const hash = payloadHash({
      order: order.payloadHash,
      services: children(index.services).map((c) => c.hash),
      payments: children(index.payments).map((c) => c.hash),
      authorizations: children(index.authorizations).map((c) => c.hash),
      owner,
      stage: lc.transform.settings.statusStageMap[workflow] ?? null,
      ids: foreignKeys(rows),
    })
    const paymentRows = await payloads(
      lc,
      'payment',
      children(index.payments).map((c) => c.remoteId)
    )

    const pending: string[] = []
    let invoiceId: string | null = null
    let createdRecord = false
    const committed = await loadOne(lc, 'order', order.remoteId, async (tx) => {
      const organizationId = lc.scope.organizationId
      if (rows.kind === 'quote') {
        // Back to an estimate after it was loaded as a work order: the work order stays as it is (warned).
        if (await linkedRow(tx, lc.scope, 'order', 'ServiceRecord', order.remoteId)) {
          lc.warnings.push({
            code: 'order_back_to_estimate',
            table: 'order',
            remoteId: order.remoteId,
            message:
              'An order loaded as a work order is an estimate again; the work order is kept.',
          })
          return 'skipped'
        }
        const { localId, result: outcome } = await upsertLinked(
          tx,
          lc.scope,
          { table: 'order', model: 'Quote', remoteId: order.remoteId, hash },
          {
            create: async () =>
              (
                await tx.quote.create({
                  data: { ...rows.quote, taxComponents: json(rows.quote.taxComponents) },
                  select: { id: true },
                })
              ).id,
            update: async (id) => {
              const {
                userId: _u,
                organizationId: _o,
                createdAt: _c,
                taxComponents,
                ...fields
              } = rows.quote
              await tx.quote.updateMany({
                where: { id, organizationId },
                data: { ...fields, taxComponents: taxComponents ?? Prisma.DbNull },
              })
              await tx.quotePart.deleteMany({ where: { quoteId: id } })
              await tx.quoteLabor.deleteMany({ where: { quoteId: id } })
              await tx.workJob.deleteMany({ where: { quoteId: id, organizationId } })
            },
          }
        )
        if (outcome !== 'unchanged') {
          await writeJobs(tx, lc, { quoteId: localId }, rows.jobs)
          await writeCustomFields(tx, lc, localId, rows.customFields)
        }
        lc.resolver.set('quote', order.remoteId, localId)
        return outcome
      }

      const record = rows.record
      let created = false
      // Looked up before the work order is written: writing it moves the archive's mapping of this order from the
      // quote to the work order, and after a restore (no links) the mapping is the only way to the quote.
      const quoteId = await linkedRow(tx, lc.scope, 'order', 'Quote', order.remoteId)
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        { table: 'order', model: 'ServiceRecord', remoteId: order.remoteId, hash },
        {
          create: async () => {
            const row = await tx.serviceRecord.create({
              data: {
                ...record,
                // Every report finds a job by its start (as upstream's importers set it); an appointment the
                // order references moves it later in the run (MAPPING §3).
                startDateTime: record.serviceDate,
                taxComponents: json(record.taxComponents),
                createdById: lc.runUserId,
                importBatchId: lc.batches.services ?? null,
              },
              select: { id: true },
            })
            created = true
            return row.id
          },
          update: async (id) => {
            const { organizationId: _o, createdAt: _c, taxComponents, ...fields } = record
            await tx.serviceRecord.updateMany({
              where: { id, organizationId },
              data: { ...fields, taxComponents: taxComponents ?? Prisma.DbNull },
            })
            await tx.servicePart.deleteMany({ where: { serviceRecordId: id } })
            await tx.serviceLabor.deleteMany({ where: { serviceRecordId: id } })
            await tx.workJob.deleteMany({ where: { serviceRecordId: id, organizationId } })
            await tx.serviceRecordHelper.deleteMany({
              where: { serviceRecordId: id, organizationId },
            })
          },
        }
      )
      lc.resolver.set('order', order.remoteId, localId)
      // An estimate that became a repair order (Shopmonkey's usual flow during the sync window): its quote is
      // converted into this work order, as the app's own conversion does, instead of staying a second document.
      if (quoteId) {
        await tx.quote.updateMany({
          where: { id: quoteId, organizationId, convertedToId: null },
          data: { status: 'converted', convertedToId: localId },
        })
      }
      // Every imported invoice is offered for issuing, changed or not: one a past run didn't get to is issued now.
      if (rows.issueAsInvoice) invoiceId = localId
      // Files may arrive after the order did (an extract with files turned on later): attached either way, once.
      await attachOrderFiles(
        tx,
        lc,
        order.remoteId,
        fileIndex.get(order.remoteId) ?? [],
        localId,
        pending
      )
      if (outcome === 'unchanged') return outcome
      createdRecord = created

      await writeJobs(tx, lc, { serviceRecordId: localId }, rows.jobs)
      await tx.serviceRecordMeta.upsert({
        where: { serviceRecordId: localId },
        create: { ...rows.meta, serviceRecordId: localId },
        update: rows.meta,
      })
      if (rows.concern) {
        const existing = await tx.serviceConcern.findFirst({
          where: { serviceRecordId: localId },
          orderBy: { sortOrder: 'asc' },
        })
        if (existing)
          await tx.serviceConcern.update({
            where: { id: existing.id },
            data: { description: rows.concern },
          })
        else
          await tx.serviceConcern.create({
            data: { serviceRecordId: localId, description: rows.concern },
          })
      }
      if (rows.helperTechnicianIds.length) {
        await tx.serviceRecordHelper.createMany({
          data: rows.helperTechnicianIds.map((technicianId) => ({
            serviceRecordId: localId,
            technicianId,
            organizationId,
          })),
          skipDuplicates: true,
        })
      }

      // Payments (§6.5): idempotent on (serviceRecordId, provider, externalId); one removed in Shopmonkey goes.
      const kept: string[] = []
      for (const p of paymentRows) {
        const payment = transformPayment(p, lc.transform)
        // Why it's out is noted after the unit, every run (below).
        if (!payment.rows) continue
        kept.push(payment.rows.externalId)
        await tx.payment.upsert({
          where: {
            serviceRecordId_provider_externalId: {
              serviceRecordId: localId,
              provider: 'shopmonkey',
              externalId: payment.rows.externalId,
            },
          },
          create: payment.rows,
          update: {
            amount: payment.rows.amount,
            date: payment.rows.date,
            method: payment.rows.method,
            note: payment.rows.note,
          },
        })
      }
      await tx.payment.deleteMany({
        where: { serviceRecordId: localId, provider: 'shopmonkey', externalId: { notIn: kept } },
      })

      // Findings (§6.4): one per deferred service, linked so a later order can resolve it.
      if (record.vehicleId) {
        for (const job of rows.jobs) {
          if (job.deferred) {
            const found = await findLoaded(
              tx,
              lc.scope,
              'order_service',
              'VehicleFinding',
              job.remoteId
            )
            if (!found) {
              const finding = await tx.vehicleFinding.create({
                data: {
                  description: job.deferred.description,
                  notes: job.deferred.notes,
                  status: 'open',
                  severity: 'needs_work',
                  vehicleId: record.vehicleId,
                  serviceRecordId: localId,
                },
                select: { id: true },
              })
              await markLoaded(tx, lc.scope, {
                table: 'order_service',
                model: 'VehicleFinding',
                remoteId: job.remoteId,
                localId: finding.id,
                hash: payloadHash(job.deferred),
                created: true,
              })
            }
          }
          if (job.revivesRemoteId) {
            const revived = await findLoaded(
              tx,
              lc.scope,
              'order_service',
              'VehicleFinding',
              job.revivesRemoteId
            )
            if (revived) {
              await tx.vehicleFinding.updateMany({
                where: { id: revived.localId, vehicle: { organizationId } },
                data: { resolvedServiceRecordId: localId },
              })
            }
          }
        }
      }
      await writeCustomFields(tx, lc, localId, rows.customFields)
      return outcome
    })
    if (rows.kind === 'quote') notOnWorkOrder(order.remoteId)
    else if (committed) {
      // M6: each of a work order's payments, loaded or left out and why. After the unit and every run, so an
      // unchanged order (its unit returns before its payments) and a payment loaded since are both said.
      // Their warnings too, here rather than in the unit: an unchanged order's would drop out of the report.
      const kept: PaymentRow[] = []
      for (const p of paymentRows) {
        const id = String(p.id)
        const payment = transformPayment(p, lc.transform)
        lc.warnings.push(...payment.warnings)
        if (payment.rows) {
          kept.push(payment.rows)
          lc.loadedUnlinked.push({ table: 'payment', remoteId: id })
        } else {
          markSkip(
            lc,
            'payment',
            id,
            p.status !== 'Succeeded'
              ? 'payment_not_succeeded'
              : (payment.warnings.at(-1)?.code ?? 'not_imported')
          )
        }
      }
      lc.warnings.push(...refundWarnings(order.remoteId, kept))
    }
    if (committed) {
      lc.placedFiles.push(...pending)
      if (invoiceId) lc.toIssue.push(invoiceId)
      if (createdRecord) createdServiceRecords++
    }
  }
  return { createdServiceRecords }
}
