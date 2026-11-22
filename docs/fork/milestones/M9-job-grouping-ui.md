# M9 (optional): Job grouping in the UI and on invoices

**Goal:** show lines grouped under their `WorkJob` (Shopmonkey "services") on the work order and quote
screens and on the printed documents, so the shop sees its work the way it did in Shopmonkey.

## Read first
- `src/features/invoices/Lib/assembleInvoicePrint.ts` and the invoice designer (`src/features/invoice-designer/`)
- The work order editor under `src/app/(authenticated)/vehicles/[id]/service/`

## Tasks
1. Work order and quote editors: when a record has jobs, group its lines under job headers (name, note,
   authorization status), with jobless lines under "Other". Add, rename, reorder and delete jobs, and move
   lines between them.
2. Print: an invoice design option "Group lines by job" (on for workshops that imported from Shopmonkey).
   It prints the job name, its lines, and the job subtotal.
3. Keep both off by default for workshops without jobs, so upstream behaviour is unchanged.

## Acceptance
- [ ] Imported fixture orders print grouped and match the original Shopmonkey PDF's structure.
- [ ] A workshop with no jobs sees no change (Playwright snapshot of an existing invoice).

## Out of scope
Per-job authorization by the customer from the share page (later).
