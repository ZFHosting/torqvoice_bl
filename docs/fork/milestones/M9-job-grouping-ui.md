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

## As built (decisions, see PROGRESS.md's Decisions log)
- **Editors:** upstream's labor and parts editors stay flat (rebuilding them around jobs would conflict with every
  upstream merge). A **Jobs card** above them (`fork-records/Components/WorkJobsCard.tsx`) shows the lines under
  their jobs and "Other", with add, edit, reorder and delete (saved at once, audited as `job.*`) and a per-line job
  menu (saved with the form). The forms send each line's `jobId`; a save keeps only a job of that document.
- **Who sees it:** a workshop with any job (an import or the API made them), read in the page's server component
  with the document's jobs (`pageJobs.server.ts`); every other workshop's pages, designer and prints are as upstream
  draws them, and its pages ask nothing more.
- **A line's job in a save:** only a job of that document. From the page, an id that isn't (the Shopmonkey sync
  recreated the job while the page was open) is left to the save's carry-over by name, so the line keeps its new job;
  through the API it is a 404, as every foreign id is.
- **Default:** a line table whose layout sets no grouping prints by job when the document has jobs, rather than "for
  workshops that imported from Shopmonkey": the same workshops in practice, read from the document itself (no query
  for the workshop's history in every print path), and the screen shows the same grouping. A layout can choose
  "None", "Category" or "By job" (the labor table offers "By job" too).
- **"Playwright snapshot of an existing invoice":** the no-change evidence is a Vitest snapshot of every preset's
  invoice and quote spec without jobs, taken before M9 changed print code (pixel snapshots differ between the Windows
  machine and CI's Linux), plus a Playwright check that a work order and its invoice PDF without jobs show no jobs.
- **The Shopmonkey PDF:** no recorded PDF exists until a key is available (B1); the structure is checked against the
  fixtures' services (provisional).
- **Issued invoices:** the import issues the invoices it loads, and those reprint by job too (the grouping changes,
  never a line or a total), as they printed in Shopmonkey. A workshop that wants them flat sets "None" in its design
  and re-applies it.
- **Declined and deferred services** (their lines don't count toward the total, MAPPING §6.3) print under their name
  marked "(declined)" or "(deferred)", with no subtotal. PROVISIONAL(M0:S5): `hidden` and `lumpSum` services print as
  any other until real data shows what Shopmonkey's PDF does with them.
- **The designer** offers "By job" for invoices and quotes only (the work order sheet doesn't group).

## Out of scope
Per-job authorization by the customer from the share page (later). A quote's jobs following it when converted to a
work order (conversion copies lines field by field, without their job). The technician's work order sheet.
