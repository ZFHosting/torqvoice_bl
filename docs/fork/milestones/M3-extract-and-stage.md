# M3: Extract and stage

**Goal:** pull every Shopmonkey object for the chosen location into `SourceRecord`, unchanged,
resumably, and without fetching the same unchanged record twice.

## Read first
- `docs/fork/MAPPING.md` §1 and §3, `docs/fork/spikes/RESULTS.md` (S2–S4, S12)
- `src/integrations/shopmonkey/client.ts` (M2), `src/features/integrations/Lib/jobs.ts`
- `prisma/schema/fork.prisma` (`SourceRecord`)

## Tasks
1. `src/integrations/shopmonkey/extract/tables.ts`: one entry per Shopmonkey table in `MAPPING.md` §3.
   Each entry has the list endpoint, the get-by-id endpoint, the location filter, the `updatedDate` filter,
   and its child fetches. Order children per order are services (with nested lines), payments, files,
   authorizations, plus the PDF when the settings ask for it. Customer children are their vehicles (emails
   and phones come embedded in each customer, RESULTS S4). Vehicle children are owners. *(Corrected in M3.)*
2. `src/integrations/shopmonkey/extract/stage.ts`: `stageRecord(table, payload)` upserts into
   `SourceRecord` on `(organizationId, source, table, remoteId)`, setting `connectionId` to the
   connection doing the fetch (M1 review: a reconnect makes a new connection id). It computes `payloadHash` over a canonical JSON
   (sorted keys) and skips the write when the hash is unchanged. It sets `remoteUpdatedAt` from
   `updatedDate`, and `remoteDeletedAt` when `deleted` is true.
3. Checkpoints in the connection's `state.extract` (through `ctx.saveState`), per plan step: `{ phase:
   'backfill' | 'delta', stage, skip, highWatermark, total, lastPage, cursor }`. One unit of work (a page,
   or a batch of parents' children) saves the checkpoint after it; the `extract.step` job does units for up
   to 45 s and returns `rescheduleInSeconds: 1`. *(Corrected in M3: `runJob` requeues only on a truthy
   value, so 0 would stop the run; and the cron ticks once a minute, so one unit per job would read one
   page a minute.)* Restarting resumes from the checkpoint.
4. Children are fetched by a sweep, not one job per parent: `SourceRecord.childrenHash` holds the
   `payloadHash` a parent's children were fetched for, and after a table's list is read the step fetches
   children for every parent where it differs (in id order, with a cursor), then marks them fetched. A
   parent that hasn't changed doesn't refetch its children, and a crash or a failed fetch is picked up by
   the next sweep. *(Corrected in M3: the job queue clears an `idempotencyKey` when a job is claimed, so a
   key per parent couldn't remember that its children were fetched; and 50,000 queued jobs would hide
   progress.)* A child no longer returned by its parent is marked `remoteDeletedAt`, never removed.
5. Files (binary): download into a staging area `dataRoot()/shopmonkey-staging/<connectionId>/` with a
   size cap and content-type check (the service upload route's own), through links checked like webhook
   targets. Each file is its own `SourceRecord` (`order_file`, `inspection_file`, `invoice_pdf`): the
   file entry as Shopmonkey sent it, plus `_parent` (its owner) and `_staged` (path, bytes, sha256, type,
   or why it was skipped). Keys starting with `_` are the importer's. M5 moves them into uploads.
6. Run order in `extract/plan.ts`, MAPPING §3's: settings tables (workflow statuses among them) → users →
   customers (+ their vehicles) → vehicles (+owners) → catalog (canned services, inventory) → orders
   (+children) → late sweeps for the customers and vehicles orders named → appointments → inspection
   templates → inspections → timesheets → archive-only tables (messages among them). Each table only starts
   when the one before it has finished. *(Corrected in M3: the brief put workflow statuses last.)*
7. CLI `scripts/shopmonkey/run.ts extract --connection <id> [--tables a,b] [--since ISO] [--restart]`,
   run with `npx tsx --conditions=react-server` (the app's server-only modules). It drives the same
   `extractStep` in-process, carries on an unfinished run, and prints progress (table, done/total from
   `meta.total`, calls per minute, estimated time left).
8. *(Optional, if the shop has EDS)* `extract/eds.ts` reads EDS's Postgres tables and calls `stageRecord`.
   Emails and phones still come from the API, because EDS tokenizes PII.
9. *(Optional)* `extract/csv.ts` stages Shopmonkey CSV exports under `table: 'csv_<name>'`, for
   cross-checking counts in M6.

## Acceptance
- [ ] Against the fixture server (a small mock of the Shopmonkey API built from the M0 fixtures, in
      `src/__tests__/features/integrations/shopmonkey/mockServer.ts`): a full extract stages every fixture
      record, and a second run writes nothing.
- [ ] Killing the run mid-table and restarting finishes with the same `SourceRecord` count, and no page is fetched twice past its checkpoint.
- [ ] A changed fixture record is restaged, and its order's children are refetched; unchanged ones aren't.
- [ ] No PII in `IntegrationLog` (test with a fixture containing a recognizable fake email).
- [ ] **Backups stay restorable with the archive in them** (M1 review). Today `SourceRecord` and `DeletedRecord`
      travel in `data.json` under the "Audit Logs" option, and restore refuses a data file over 128 MiB
      (`src/lib/backup/limits.ts`). Before staging writes real volumes, give the archive its own export
      option (labelled, on by default) and keep a 50,000-order archive restorable: a separate file, a
      streamed dataset, or compressed payloads. Test: restore a backup holding a large synthetic archive.
      *(Built as a separate file, `source-archive.ndjson`, beside `data.json`: `lib/backup/fork-archive.ts`.)*
- [ ] Restoring the same backup twice leaves one `SourceRecord` per source object (the restore clears the
      workshop's archive first; test it on the database).

## Out of scope
Transforming or writing app tables.
