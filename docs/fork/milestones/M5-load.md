# M5: Load

**Goal:** write the transformed rows into Torqvoice idempotently, in dependency order, with files,
numbering and invoice locking done the way the app does them, and make the whole run undoable.

## Read first
- `docs/fork/FORK.md` (why the loader bypasses `withAuth`)
- `src/features/integrations/Lib/connections.ts` (the `LinkStore` behind `ctx.links`)
- `src/features/import/Lib/pipeline.ts`, `src/features/import/Actions/importActions.ts` (ImportBatch and undo)
- `src/features/invoices/Lib/issueInvoice.ts`, `src/lib/job-number.ts`
- `src/app/api/protected/upload/service-files/route.ts` (where and how uploaded files are stored)
- `src/lib/files/manager.ts` (file registration and the orphan sweep)

## Tasks
1. `src/integrations/shopmonkey/load/upsert.ts`, a generic `upsertLinked(entityType, remoteId, checksum, create, update)`:
   - It looks up `ctx.links.byRemoteId(entityType, remoteId)`. When the link's `checksum` equals the
     source `payloadHash`, it does nothing. Otherwise it updates the linked row, or creates one and sets
     the link.
   - It always scopes by `organizationId`. If a linked row is missing (deleted locally), it recreates the
     row and logs a warning.
2. One loader per entity in `load/`, called in the plan order from M3. Each order (ServiceRecord or Quote
   with its jobs, lines, concerns, meta, helpers, payments, findings and custom field values) is written in
   **one transaction**. If a child fails, the order rolls back and is reported; the run carries on.
3. ImportBatch: one batch per entity type per run (`source: 'shopmonkey'`), set on every customer,
   vehicle, service record and inspection the run **creates**. Undo deletes what the batch created,
   following the spreadsheet importer's undo rules (read them in `importActions.ts` first; don't invent
   new ones), and clears the matching `IntegrationLink` and `SourceRecord` state for those records.
4. Lines: every line gets `jobId`, `lineKind`, and the X3 columns from the transform. `ServicePart.inventoryPartId`
   is set when the Shopmonkey part references an inventory item that has been imported.
5. Payments: written with `provider: 'shopmonkey'` and `externalId`. A rerun is safe through the existing
   unique index.
6. Invoices: for orders with `invoicedDate`, after the transaction commits, call
   `issueInvoice(id, orgId, 'backfill')`. Then patch the `issuedData` customer block when MAPPING §6.1
   says to.
7. Files: move staged files into `uploadsRoot()/<orgId>/services/` with generated names, the same way the
   upload route does (the file manager's `isGeneratedName` must accept them). Then create
   `ServiceAttachment` rows (inspection photos go into `imageUrls`). Original invoice PDFs get category
   `document`, `includeInInvoice: false` and the description "Original Shopmonkey invoice".
8. Stock: set `InventoryPart.quantity` and write one `StockMovement` with reason `import`.
9. Numbering: after a full run, compute the highest imported number, and offer (not force) the numbering
   update from MAPPING §9. The UI applies it in M8; the CLI has `--apply-numbering`.
10. Audit: one `logAudit` event per run (`shopmonkey.import`, with counts in metadata). **Not** per row.
    Confirm it isn't one of the events in `WEBHOOK_EVENTS`, so no webhook fires.
11. CLI: `scripts/shopmonkey/run.ts load --connection <id> [--dry-run]`. A dry run executes every
    transaction and then rolls it back, and prints what would change.

## Acceptance
- [ ] `npm run test:db`: loading the fixture set into an empty workshop, then loading it again, gives identical row counts and no updates on the second run.
- [ ] Changing one fixture order and reloading updates exactly that order's rows.
- [ ] An invoiced fixture order is locked after the load, and its PDF prints the Shopmonkey number, lines and totals.
- [ ] An unpaid fixture invoice is unpaid in Torqvoice; a partly paid one shows the right balance.
- [ ] Undo after a load leaves the workshop as it was before (counts per table).
- [ ] No webhook deliveries are created by a load (assert `WebhookDelivery` count unchanged with an active `*` webhook).

## Out of scope
The reconciliation report (M6) and the UI (M8).
