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
   authorizations, plus the PDF when the settings ask for it. Customer children are emails and phones.
   Vehicle children are owners.
2. `src/integrations/shopmonkey/extract/stage.ts`: `stageRecord(table, payload)` upserts into
   `SourceRecord` on `(connectionId, table, remoteId)`. It computes `payloadHash` over a canonical JSON
   (sorted keys) and skips the write when the hash is unchanged. It sets `remoteUpdatedAt` from
   `updatedDate`, and `remoteDeletedAt` when `deleted` is true.
3. Checkpoints in the connection's `state` (through `ctx.saveState`), per table: `{ phase: 'backfill' |
   'delta', skip, highWatermark }`. A backfill page job processes one page, saves the checkpoint and
   returns `rescheduleInSeconds: 0`, so the queue keeps it moving. Restarting resumes from the checkpoint.
4. Child fetch jobs are queued per parent with an `idempotencyKey` (`order-children:<orderId>:<payloadHash>`),
   so a parent that hasn't changed doesn't refetch its children.
5. Files (binary): download into a staging area `dataRoot()/shopmonkey-staging/<connectionId>/` with a
   size cap and content-type check. Record the path in the file's `SourceRecord` payload under
   `_staged`. M5 moves them into uploads.
6. Run order in `extract/plan.ts`: settings tables → users → customers (+contacts) → vehicles (+owners) →
   catalog (canned services, inventory) → orders (+children) → appointments → inspection templates →
   inspections → timesheets → workflow statuses → optional messages. Each table only starts when the one
   before it has finished.
7. CLI `scripts/shopmonkey/run.ts extract --connection <id> [--tables a,b] [--since ISO]`. It drives the
   same job handlers in-process and prints progress (table, done/total from `meta.total`, calls per minute,
   estimated time left).
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

## Out of scope
Transforming or writing app tables.
