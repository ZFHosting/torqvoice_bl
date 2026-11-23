/**
 * Loading the catalog (M5 tasks 4 and 8; MAPPING §3, §7): inventory parts and tires as `InventoryPart`s, each with
 * one "import" `StockMovement` that explains its count, and canned services and catalog labor and fees as
 * `LaborPreset`s.
 */
import {
  transformCannedService,
  transformCatalogLine,
  transformInventoryItem,
} from '../transform/catalog'
import type { PresetRows } from '../transform/catalog'
import { clientOf, countsFor, type LoadContext, loadOne, type Tx } from './context'
import { stagedAll } from './people'
import { upsertLinked } from './upsert'

/**
 * Inventory (§7). A part's sku becomes its barcode only when no other part has it (the column is unique per
 * workshop); otherwise it is kept as a `sku:<value>` tag. A changed count is set, with a movement for the difference.
 */
export async function loadInventory(lc: LoadContext): Promise<void> {
  const lookups = {
    categories: Object.fromEntries(
      (await stagedAll(lc, 'inventory_category')).map((r) => [r.remoteId, r.payload])
    ),
    vendors: Object.fromEntries(
      (await stagedAll(lc, 'vendor')).map((r) => [r.remoteId, r.payload])
    ),
  }
  const items = [
    ...(await stagedAll(lc, 'inventory_part')).map((r) => ({
      ...r,
      table: 'inventory_part' as const,
      kind: 'part' as const,
    })),
    ...(await stagedAll(lc, 'inventory_tire')).map((r) => ({
      ...r,
      table: 'inventory_tire' as const,
      kind: 'tire' as const,
    })),
  ]
  const barcodes = new Set(
    (
      await clientOf(lc).inventoryPart.findMany({
        where: { organizationId: lc.scope.organizationId, barcode: { not: null } },
        select: { barcode: true },
      })
    ).map((p) => p.barcode as string)
  )
  const skuCounts = new Map<string, number>()
  const transformed = items.map((item) => {
    const result = transformInventoryItem(item.payload, item.kind, lookups, lc.transform)
    const sku = result.rows?.part.barcodeCandidate
    if (sku) skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1)
    return { item, result }
  })
  for (const { item, result } of transformed) {
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    if (!rows) {
      countsFor(lc, item.table).skipped++
      continue
    }
    const { barcodeCandidate, ...part } = rows.part
    await loadOne(lc, item.table, item.remoteId, async (tx) => {
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        {
          table: item.table,
          model: 'InventoryPart',
          remoteId: item.remoteId,
          hash: item.payloadHash,
        },
        {
          create: async () => {
            const unique =
              barcodeCandidate &&
              skuCounts.get(barcodeCandidate) === 1 &&
              !barcodes.has(barcodeCandidate)
            if (unique) barcodes.add(barcodeCandidate)
            const row = await tx.inventoryPart.create({
              data: {
                ...part,
                barcode: unique ? barcodeCandidate : null,
                tags: !unique && barcodeCandidate ? [`sku:${barcodeCandidate}`] : [],
              },
              select: { id: true },
            })
            if (rows.movement) {
              await tx.stockMovement.create({
                data: {
                  ...rows.movement,
                  inventoryPartId: row.id,
                  userId: lc.runUserId,
                  organizationId: lc.scope.organizationId,
                },
              })
            }
            return row.id
          },
          update: async (id) => {
            const before = await tx.inventoryPart.findFirst({
              where: { id, organizationId: lc.scope.organizationId },
              select: { quantity: true },
            })
            const { userId: _u, organizationId: _o, ...fields } = part
            await tx.inventoryPart.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: fields,
            })
            const delta = part.quantity - (before?.quantity ?? 0)
            if (delta !== 0) {
              await tx.stockMovement.create({
                data: {
                  delta,
                  quantityAfter: part.quantity,
                  reason: 'import',
                  note: 'Count updated from Shopmonkey',
                  inventoryPartId: id,
                  userId: lc.runUserId,
                  organizationId: lc.scope.organizationId,
                },
              })
            }
          },
        }
      )
      lc.resolver.set(item.table, item.remoteId, localId)
      return outcome
    })
  }
}

async function writePreset(tx: Tx, presetId: string, rows: PresetRows) {
  if (rows.items.length) {
    await tx.laborPresetItem.createMany({ data: rows.items.map((i) => ({ ...i, presetId })) })
  }
  if (rows.parts.length) {
    await tx.laborPresetPart.createMany({ data: rows.parts.map((p) => ({ ...p, presetId })) })
  }
}

/** Presets (§3): canned services, and catalog labor and fee items as one-line presets. */
export async function loadPresets(lc: LoadContext): Promise<void> {
  const sources = [
    ...(await stagedAll(lc, 'canned_service')).map((r) => ({
      ...r,
      table: 'canned_service' as const,
    })),
    ...(await stagedAll(lc, 'inventory_labor')).map((r) => ({
      ...r,
      table: 'inventory_labor' as const,
    })),
    ...(await stagedAll(lc, 'inventory_fee')).map((r) => ({
      ...r,
      table: 'inventory_fee' as const,
    })),
  ]
  for (const source of sources) {
    const result =
      source.table === 'canned_service'
        ? transformCannedService(source.payload, lc.transform)
        : transformCatalogLine(
            source.payload,
            source.table === 'inventory_labor' ? 'labor' : 'fee',
            lc.transform
          )
    lc.warnings.push(...result.warnings)
    const rows = result.rows
    if (!rows) {
      countsFor(lc, source.table).skipped++
      continue
    }
    await loadOne(lc, source.table, source.remoteId, async (tx) => {
      const { localId, result: outcome } = await upsertLinked(
        tx,
        lc.scope,
        {
          table: source.table,
          model: 'LaborPreset',
          remoteId: source.remoteId,
          hash: source.payloadHash,
        },
        {
          create: async () => {
            const preset = await tx.laborPreset.create({ data: rows.preset, select: { id: true } })
            await writePreset(tx, preset.id, rows)
            return preset.id
          },
          update: async (id) => {
            const { userId: _u, organizationId: _o, ...fields } = rows.preset
            await tx.laborPreset.updateMany({
              where: { id, organizationId: lc.scope.organizationId },
              data: fields,
            })
            await tx.laborPresetItem.deleteMany({ where: { presetId: id } })
            await tx.laborPresetPart.deleteMany({ where: { presetId: id } })
            await writePreset(tx, id, rows)
          },
        }
      )
      lc.resolver.set(source.table, source.remoteId, localId)
      return outcome
    })
  }
}
