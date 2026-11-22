# Progress ledger

The single source of truth for where the fork build stands. Claude Code reads this first in every
session (and after every context compaction) and updates it after every step. The Stop hook
(`.claude/hooks/keep-going.sh`) reads the **Milestones** table: while any row is `todo` or `in_progress`,
Claude isn't allowed to stop.

Statuses: `todo` · `in_progress` · `done` · `blocked` (needs a human; say what in **Blockers**) ·
`provisional` (done against synthetic fixtures; must be re-verified with real Shopmonkey data, which
counts as done for the hook).

## Summary

**Autopilot is running** (resumed 2026-11-22 with `/autopilot`). The Milestones table, Current step and
Blockers are the live state; a full summary (what's done, what's provisional, what I need from you, how to
verify) is written here when the run stops. Earlier stop: B12 (M1's checks stopped for low memory), now
resolved.

## Milestones

| Id | Status | Branch | Notes |
| --- | --- | --- | --- |
| M0 | provisional | fork/M0-setup-and-spikes | Merged 249e3dd3. S1–S12 from docs only and synthetic fixtures: re-verify with a key (B1). Reviewer: ready for PR after 3 passes. |
| M1 | done | fork/M1-schema-extensions | Merged 5605175e. Reviewer: ready for PR after 2 passes. DoD evidence in the Decisions log (2026-11-22, M1). |
| A1 | in_progress | fork/A1-api-foundation | |
| A2 | todo | | |
| M2 | todo | | |
| M3 | todo | | |
| M4 | todo | | |
| M5 | todo | | |
| A3 | todo | | |
| A4 | todo | | |
| M6 | todo | | |
| M7 | todo | | |
| M8 | todo | | |
| A5 | todo | | |
| A6 | todo | | |
| M9 | todo | | optional, last |

## Current step

Environment (local, Windows):
- Postgres 16 runs in Docker as container `torqvoice-bl-db` on `127.0.0.1:5442` (5432 is taken by another
  project; 54860–55698 are Windows-reserved). **Test DB `torqvoice_fork_test`** (all migrations, including
  M1's final `fork_import_foundation`): for `npm run test:db`, export
  `E2E_DATABASE_URL=postgresql://torqvoice:torqvoice@localhost:5442/torqvoice_fork_test` (vitest doesn't read
  `.env`). The older `torqvoice` (dev, what `.env` points at) and `torqvoice_test` hold the pre-review
  version of M1's migration and need `prisma migrate reset`, which Prisma refuses to run for an AI agent
  without your consent (B14).
- The checkout has CRLF endings (`core.autocrlf=true`); commits are normalized to LF. Biome's format check
  runs against an LF worktree in the session scratchpad (`git -c core.autocrlf=false worktree add --detach`),
  using the main checkout's `node_modules/.bin/biome`. Tests and `tsc` run in the main checkout.
- **Run Vitest with Node 22.23.4 from an upper-case `C:` path** (Decisions log, 2026-11-22 "Test runner"):
  the machine's Node is 22.14, which can't start 634 of the 775 test files (`undici` 8 needs ≥22.19), and a
  lower-case `c:` cwd loads vitest twice ("Cannot read properties of undefined (reading 'config')"). A
  verified portable Node 22.23.4 is in the session scratchpad `node22/`; `run-chunk.sh` there runs one
  folder chunk (`--maxWorkers=2`, each chunk under 10 minutes). If the scratchpad is gone: download
  `node-v22.23.4-win-x64.zip` from nodejs.org, check it against `SHASUMS256.txt`, unzip, put it first on PATH.
- Baseline on untouched upstream `main` with Node 22.23.4 (measured 2026-11-22): `npm run check` has 14
  pre-existing errors; `npm test` fails 14 Windows-only files (list in the Decisions log). Timing-sensitive
  tests (`lib/files/delete-paths`, the PDF `*-template-preset` ones) can time out at 5 s on the first run
  after `prisma generate` or under load; rerun them alone.
- After switching branches, re-run `sed -i 's/\r$//' prisma/schema/*.prisma`: checkout rewrites changed
  schema files with CRLF, and `test:db`, `features/ai/workshop-columns` and `lib/files/references` parse the
  schema on `\n`.
- Reviews: the `migration-reviewer` reads files from this checkout; don't switch branches while one runs.

**A1 (API foundation), in progress** on `fork/A1-api-foundation` (from `fork/integration` at 5605175e).
Staged code: the session scratchpad `a1-final/` mirrors the repo paths (Lib, Schema, Serializers, Actions,
Components, routes, cron, tests, `i18n_api_keys.py`). Plan, in order:
1. [ ] Copy in `src/features/public-api/Lib/*` (keys.server, withPublicApi, rateLimit, pagination, etag,
   idempotency, errors, openapi), `Schema/settings.ts`, `Schema/apiKeys.ts`, `Serializers/settings.ts`,
   `GET /api/v1/settings`, `GET /api/v1/openapi.json`. Upstream edits, each `// fork:`: export
   `clientAddress` from `src/lib/rate-limit.ts` (one source for the caller's address).
2. [ ] Tests first run: `conventions`, `with-public-api`, `openapi` (devDependency
   `@apidevtools/swagger-parser`), db tests `public-api-keys` and `public-api-idempotency`.
3. [ ] Cron `src/lib/cron/purge-api-idempotency.ts`, registered in `src/cronTasks.ts` and
   `src/instrumentation.ts` (`// fork:`).
4. [ ] Settings → API keys: `Actions/apiKeyActions.ts` (owner/admin, `withAuth` + audit `api_key.create` /
   `api_key.revoke`), `Components/ApiKeysSettings.tsx`, page `settings/api-keys`, nav entry in
   `settingsPages.ts` (`gate: 'api'`), namespace `apiKeys` (14 locales, imported in `src/i18n/request.ts`),
   nav label and audit labels in every locale; component test `api-keys-settings`.
5. [ ] DoD, reviewer, merge.
Acceptance evidence goes here as each item passes.

M0 acceptance:
- [x] NOTICE-FORK.md, README link, CLAUDE.md import, docs/fork/UPSTREAM.md (commit 0c7ec939).
- [x] RESULTS.md answers S1–S12 (docs only, provisional) and T1–T7 (confirmed; spike file above).
- [~] Fixtures for the MAPPING §3 tables, incl. a complex order: **synthetic** (26 tables; order 1003 has
  4 services, fees, discount, deposit, partial payment, refund). Deferred, with reasons: Fleet (no
  Fleet table in Shopmonkey's published schemas; `customer.fleetId` stays in SourceRecord) and Message
  (archive only, B4). Synthetic records carry the fields the importer reads, not every documented field
  (README). Recorded fixtures wait on B1.
- [~] Grep for the real shop name / surname / VIN: no real data has ever been fetched; the guard test
  checks for real-looking emails, phones and VINs on every run; `anonymize-fixtures.ts` refuses to write
  output containing any replaced value or `--deny` string. Re-run the grep once recorded fixtures exist.
- [x] No `[M0]` markers left in MAPPING.md (only the legend); unconfirmed rules are `[provisional: Sx]`.
- [x] PLAN §6 questions assigned: blockers B2–B8 (defaults taken), B9 licensing, B10 portal privacy. Shopmonkey field lists are in `docs/fork/spikes/SHOPMONKEY-SCHEMAS.md`; a fuller
  docs survey was in the session scratchpad (`shopmonkey-api-reference.md`); if it's gone, re-read shopmonkey.dev.

## Blockers (need a human)

| # | Milestone | What's needed | Raised |
| --- | --- | --- | --- |
| B1 | M0 (all M) | **A Shopmonkey API key** from a Shopmonkey admin (Settings → Integration → API Keys), exported as `SHOPMONKEY_API_KEY`, plus a secret `ANONYMIZE_SALT` (16+ chars). Then run `npx tsx scripts/shopmonkey/spike.ts` and `npx tsx scripts/shopmonkey/anonymize-fixtures.ts --deny deny.txt` (deny.txt: the shop's name, a few real surnames and VINs), and re-verify every item under "Re-verify with real Shopmonkey data". Until then M0 and every M-milestone built on its fixtures is `provisional`. | 2026-11-22 |
| B2 | M0 (PLAN §6 Q1) | Does BlueLabel's Shopmonkey account have **Enterprise (EDS)**? How many **locations**? Default taken: no EDS (REST adapter only), one location, imported by `locationId`. | 2026-11-22 |
| B3 | M0 (PLAN §6 Q2) | Rough **volumes** (customers, vehicles, orders, inspections, files/GB). The spike prints `meta.total` per table once a key exists (S12). Default: sized for 50,000 orders (the M6/A6 test size). | 2026-11-22 |
| B4 | M0 (PLAN §6 Q3) | Should **message history** (SMS/email threads) come over now? Default: **archive only** (`includeMessages` off), per MAPPING §3. | 2026-11-22 |
| B5 | M0 (PLAN §6 Q4) | **Original invoice PDFs**: every invoice, or the last N years? Default: setting `downloadInvoicePdfs` = `last 2 years`. | 2026-11-22 |
| B6 | M0 (PLAN §6 Q5) | How do the shop's Shopmonkey **workflow statuses map** to pending / in progress / completed? Default: a status in Shopmonkey's invoice workflow → completed; in the repair-order workflow the first by position → pending and the rest → in progress (RESULTS S9); editable per status in the M8 mapping panel before any load. | 2026-11-22 |
| B7 | M0 (PLAN §6 Q6) | Which **staff need logins** on day one? Default: none are created; a `Technician` is created for every Shopmonkey user on labor lines, assignments or timesheets, and the owner invites logins by hand. | 2026-11-22 |
| B8 | M0 (PLAN §6 Q7) | **Cutover date** and how long the shop can stop editing Shopmonkey for the final delta. Default: plan for a freeze under one hour (CUTOVER.md, M7). | 2026-11-22 |
| B9 | All | **Licensing:** hosting this fork for BlueLabel as a third party is the licensor's call under ELv2 (FORK.md). Needs a decision from Torqvoice's licensor before production hosting. Not a code task. | 2026-11-22 |
| B10 | M5 (T3) | **Previous owners' orders.** When a Shopmonkey order's customer differs from the vehicle's current owner, the importer sets `ServiceRecord.customerId` (MAPPING §6.1), so invoices bill the right person. Side effect (upstream behaviour, `docs/fork/spikes/RESULTS.md` T3): the vehicle's **current owner sees those jobs listed in the customer portal, with the previous owner's name and address** on the sheet. Default taken: keep MAPPING (set `customerId`). Alternative if that's not acceptable: split such vehicles into one vehicle per owner period. | 2026-11-22 |
| B11 | All | **Confirm the committed Claude Code config.** The `.claude/` kit (settings.json with the Stop hook `keep-going.sh`, the autopilot and milestone commands, the reviewer agent) and the autopilot section of `docs/fork/README.md` were in the working tree, untracked, when this run started, newer than `bluelabel-fork-kit.zip`; M0 committed them as found. The Stop hook runs in **every** Claude Code session in this repo, not only `/autopilot`: it refuses to stop while a milestone is `todo` or `in_progress` (escape: `touch .claude/STOP`). Confirm that's wanted, or scope it. | 2026-11-22 |
| B12 | M1 (and everything after it) | ~~Re-run M1's checks.~~ **Resolved 2026-11-22:** rerunning `/autopilot` was the go-ahead; the checks ran one at a time in the foreground with two test workers, and pass (Current step). | 2026-11-22 |
| B13 | All (not blocking) | **Upgrade Node on this machine to 22.23.4** (what CI, the Dockerfile and the devcontainer pin), or at least ≥22.19. With the installed 22.14, `npm test` silently runs only 141 of 775 test files: `jsdom` 30 pulls `undici` 8, which needs `zlib.createZstdDecompress`, and the other 634 files' workers crash on start without counting as failures. The build carries on with a checksum-verified portable Node 22.23.4 in the session scratchpad, so nothing waits on this. | 2026-11-22 |
| B14 | None (local housekeeping) | **Reset or drop the old local databases** `torqvoice` (what `.env`'s `DATABASE_URL` points at) and `torqvoice_test` in the `torqvoice-bl-db` container: they hold the pre-review version of M1's migration, so `prisma migrate dev` against them now wants a reset, and Prisma refuses `migrate reset` from an AI agent without your explicit consent. Either run `npx prisma migrate reset` against each yourself, or tell me to, or point `.env` at `torqvoice_fork_test`. Tests already use `torqvoice_fork_test`, so nothing waits on this. | 2026-11-22 |

## Re-verify with real Shopmonkey data

Every `PROVISIONAL(M0:Sx)` assumption in code, and every **[provisional: Sx]** rule in `MAPPING.md`.
Rerun `grep -rn "PROVISIONAL(M0" scripts src` to refresh the code list. When B1 is resolved: record real
fixtures, compare each item below with them, fix the code or MAPPING, and remove the marker.

| Spike | Assumption | Where |
| --- | --- | --- |
| S1 | Locations come from `GET /v3/location`, falling back to `user/me.locations`; `api_key/status` 200 + `success` means valid | MAPPING §1; RESULTS S1 (M2 `server.ts` will carry the marker) |
| S2 | The enumerated search allowlist (every `/search` route in the reference) is complete and every one only reads | `SEARCH_ALLOWLIST` in `scripts/shopmonkey/spike-client.ts` (and M2 `client.ts`) |
| S2 | GET lists ignore `where` and are unstable without `orderby` on `id`; max useful `limit` is 100; incremental pulls fall back to re-list + `payloadHash` | MAPPING §1; RESULTS S2 (M3 extractor) |
| S4 | Vehicle's current owner = the most recently created `vehicle_owner` row | `build-synthetic-fixtures.ts` (`vehicleOwner`); MAPPING §3 VehicleOwner |
| S4 | Order files (`files[]` on Find Order, documented) download from their `url` without extra auth | `build-synthetic-fixtures.ts` (order `files`); MAPPING §3 Order files |
| S4 | Order services come nested with lines from `GET /v3/order/:id/service` (and `include` on `GET /v3/order`) | MAPPING §1; RESULTS S4 |
| S4 | Order `labels` object read as label names; customer fleet entity archive only; signed-document images | MAPPING §3, §6.1 |
| S4 | `reminderOptOut` only from the primary email's `subscribed: false` | MAPPING §4 |
| S4 | `recommendation` prints on Shopmonkey's invoice → `invoiceNotes` | MAPPING §6.1 |
| S5 | Line total = gross − `discountCents` (labor `round(hours × rate × multiplier)`, parts/tires `round(qty × retail)`, sublet `retail`); percent fee = `round(percent% × service line base)` | `build-synthetic-fixtures.ts` (`lineTotal`); MAPPING §6.2 |
| S5 | A service counts toward order totals unless `Declined` or `deferredDate` set | `build-synthetic-fixtures.ts` (`countsTowardTotals`); MAPPING §6.3 |
| S5 | Order-level discount comes off after tax (`totalCostCents = subtotal − discount + tax`) | `build-synthetic-fixtures.ts` (`rollUpOrder`) |
| S5 | Refunds have negative `amountCents` (importer uses `-abs`); `refundedAmountCents` on charges is not subtracted again | `build-synthetic-fixtures.ts` (`rollUpOrder`, payments); MAPPING §6.5 |
| S5 | EPA / shop supplies are never also `fee` rows; tire FET and waste fee are outside the line total | MAPPING §6.2 |
| S6 | Fees are never taxed; EPA/shop supplies taxability from the tax config | MAPPING §6.2 |
| S7 | Inspection item photos (`items[].files[]`, documented) download from their `url` | `build-synthetic-fixtures.ts` (`inspectionItem`); MAPPING §3, §8 |
| S8 | Timesheet `duration` is milliseconds (unused: minutes come from clock times) | `build-synthetic-fixtures.ts` (`timesheet`); MAPPING §3 |
| S11 | `publicId` and order `number` are digits in practice (both are strings in the schema) | MAPPING §4, §9 |
| S12 | Volumes (sizing assumes 50,000 orders) | RESULTS S12, blocker B3 |

## Decisions log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-22 | Definition of done is judged against the untouched-upstream baseline: **no new** Biome errors (upstream `main` already has 14: 5 unformatted files and `src/app/globals.css` Tailwind syntax), and **no new** failing test files (upstream has 11–13 that fail only on Windows: restic spawning, path separators, CRLF; reproduce by running `npm test` on `main`). Baseline failing files: `api/health`, `api/photo-handoff`, `api/portal-upload`, `features/meters/meters-gates`, `features/portal/portal-file-route`, `features/settings/spec-pdf-print`, `lib/backup/engine`, `lib/backup/restic`, `lib/files/manager`, `lib/files/only-the-manager-deletes`, `lib/viewer-access` (all under `src/__tests__/`; 1–2 more flake in and out between runs). `tsc` must stay clean (it is on `main`). | The dev machine is Windows; upstream CI is Linux. Fixing upstream lint or Windows-only tests is out of scope ("Don't reformat upstream files"). |
| 2026-11-22 | Biome is run against an LF worktree; the main checkout keeps `core.autocrlf=true`. | Re-checking out the working tree with LF endings was refused by the permission classifier. Commits are normalized to LF either way, so committed content is what Biome checks. `.claude/hooks/.gitattributes` pins the Stop hook to LF so bash can run it. |
| 2026-11-22 | Local Postgres for this build: Docker container `torqvoice-bl-db` on 127.0.0.1:5442 (DBs `torqvoice`, `torqvoice_test`). | 5432 is used by another project on this machine; 54860–55698 are Windows-reserved. |
| 2026-11-22 | PLAN §6 questions answered with conservative defaults (B2–B8) until confirmed. | Autopilot rule: take the documented default, log it, raise a blocker. |
| 2026-11-22 | MAPPING §6.1: no `issuedData` patching for bill-to; set `customerId` and the backfill snapshot bills the order's customer. M5 brief task 6 updated to match. | Spike T5: `buildIssuedInvoiceData` already uses `record.customer ?? vehicle.customer`. |
| 2026-11-22 | M5 must refuse to issue imported invoices while a connection subscribed to `service.update` is active (MAPPING §6.1, M5 brief task 6). | Spike T5: `issueInvoice` → `notifyIntegrations('service.update')` → `accounting.invoice` jobs on Xero/QuickBooks/Fiken/Zoho, calendar pushes on Google/M365/Zoom. |
| 2026-11-22 | Numbering after import sets the format to `''` **and** `invoiceStartNumber` (MAPPING §9). | Spike T1: with `{year}-` left in place, numbering restarts from the newest job's digits, not the highest. |
| 2026-11-22 | Refunds are imported as negative payments with a `refund_net_nonpositive` warning when net paid ≤ 0 (MAPPING §6.5); the upstream display issues are listed in MAPPING §10. | Spike T2: totals are right everywhere; only the net ≤ 0 case displays oddly, in upstream code. |
| 2026-11-22 | M0 review (migration-reviewer): **needs changes**, four must-fix items, all fixed on the branch. (1) The anonymizer now replaces every string by default unless its key is an id, a documented enum or a listed catalog fact, with a test over every string field of all 110 documented tables. (2) The fixture CLI merges every response for a record (`fixture-build.ts`, tested). (3) Overclaims corrected: synthetic `authorization`, `inventory_labor`, `inventory_fee` and `label` added, Fleet and Message deferred with reasons, RESULTS says which T-spikes ran on Postgres and that no screenshots were taken, and the S12 claim matches the spike. (4) This entry and B11. Should-fixes done: the spike client allows an enumerated list, pins the origin and doesn't follow redirects; the spike counts customers, estimates vehicles, probes file URLs keyless and takes `--order-ids`; refunded charges carry `refundedAmountCents`; B6 has one default everywhere. | Reviewer findings. |
| 2026-11-22 | The `.claude/` kit and the autopilot section of `docs/fork/README.md` and M0 brief item 5 were committed as found in the working tree (they're newer than `bluelabel-fork-kit.zip`; this run didn't write them). The Stop hook's reach is raised as B11. | Provenance, per the M0 review. |
| 2026-11-22 | `SourceRecord.connectionId` must not be a required FK to `IntegrationConnection` (for M1). | Spike T6: connections and links are excluded from backups by design; a backed-up `SourceRecord` would fail to restore. |
| 2026-11-22 | M1: `ApiKey` and `ApiIdempotencyKey` are **excluded** from backups (manifest `EXCLUDED_MODELS`) instead of backing up `ApiKey` with `keyHash` redacted; M1 brief task 5 and its acceptance item updated. | A key's service user and membership are never in a backup, so a restored key would fail its foreign key; excluding it keeps the install's own keys, which is what the brief wanted. |
| 2026-11-22 | M1: `SourceRecord` and `DeletedRecord` travel under the existing "Audit Logs" export option; `WorkJob` nests under both `ServiceRecord` and `Quote`; the fork's restore lives in `src/lib/backup/fork-restore.ts`, called from `import.ts` by one-line `// fork:` hooks; the manifest test reads both files. | No new export checkbox (UI change); smallest upstream diff in a file upstream edits often. |
| 2026-11-22 | M1: five upstream backup tests had their expectations extended (new dataset keys; `ServicePart`'s second owner path through its job; `WorkJob`'s one-parent columns), each marked `// fork:`. | The schema really changed; the checks stay exact. |
| 2026-11-22 | **Test runner, correcting the baseline row above:** Vitest runs on Node 22.23.4 (CI's pin) from an upper-case `C:` path. The earlier "11–13 failing files" baseline was measured on the machine's Node 22.14, where 634 of 775 files never start (B13), so it covered only the 141 node-environment files. Re-measured on untouched `main` (03619f67) with Node 22.23.4, the Windows-only failures are 14 files: `api/health`, `api/photo-handoff`, `api/portal-upload`, `features/equipment/equipment-gates`, `features/meters/meters-gates`, `features/portal/portal-file-route`, `lib/backup/engine`, `lib/backup/restic`, `lib/files/manager`, `lib/files/only-the-manager-deletes`, `lib/safe-path`, `lib/status-colors`, `lib/upload-root`, `lib/viewer-access` (path separators, restic spawning). | Without it the definition of done would pass while most of the suite never ran. The portable Node lives in the session scratchpad; nothing is installed system-wide. |
| 2026-11-22 | M1: `SourceRecord.payload`, the four lines' `sourceExtra` and `ApiIdempotencyKey.responseBody` are listed in `lib/files/references.test.ts`'s `NOT_FILES` (never a Torqvoice file). | Their URLs, if any, point at Shopmonkey or are a 24-hour response replay; the file manager must not count them as uses. |
| 2026-11-22 | M1: upstream's `part-restore-fields` and `restore-map-fields` tests read the import through `src/__tests__/stubs/fork-import-source.ts`, which inlines the `fork-restore.ts` spreads and appends that file. | They read `import.ts` as text and couldn't see the fork's restore. With the helper they check the fork's maps as strictly as upstream's: dropping `note` from the part map or `label` from contacts fails both (mutation run). |
| 2026-11-22 | M1: the AI workshop chat lists the lines' new columns (`jobId`, `lineKind`, `discountAmount`, `note` on parts; job, kind, technician, completion, discount on labor) and hides `sourceExtra`, `costHours` and `costRate` (`HIDDEN_COLUMNS`). **Revised after review:** the first version listed `costHours`/`costRate`. | Upstream's `workshop-columns` test requires every column to be listed or hidden. The line tables are open to anyone who may read work orders; `costRate` is a technician's pay, which upstream holds nowhere, so it stays out until a payroll or reports permission exists to gate it (revisit with A5's technician report). `sourceExtra` is raw Shopmonkey data, reachable through the API. |
| 2026-11-22 | M1 review: `SourceRecord` is unique on `(organizationId, source, table, remoteId)`, not `(connectionId, table, remoteId)`; `connectionId` means "last fetched by". The unmerged migration was edited in place rather than followed by a second one. | Disconnecting deletes a connection and a reconnect or a restore makes a new id, so the old key would have duplicated the whole archive on the next pull. The migration exists only on this branch and the local databases; editing it keeps M1 one additive migration. |
| 2026-11-22 | M1 review: the generated tenancy schema counts a labor line's technician as one of its owner paths (`tenancy-schema.ts`, generated from the new `technicianId` relation). Left as generated. | It loosens `assertNoForeignRows`'s ownership proof slightly, but the restore's own sanitising drops cross-workshop technician ids (`kept()`), so it isn't exploitable. The generator is upstream's; special-casing it would be a larger upstream edit. |
| 2026-11-22 | **M1 done.** DoD at 12628351: `tsc` exit 0; Biome 14 (baseline); `npm test` all 775 files on Node 22.23.4, failures = the 14 Windows-only baseline files (+ the cold-start `delete-paths` timeout); `test:db` 14 files / 82 tests on `torqvoice_fork_test`. Reviewer pass 2: ready for PR. Merged into `fork/integration` at 5605175e. | Evidence for the definition of done and acceptance (brief items 1–4). |
| 2026-11-22 | M1 review: `readLaborSourceExtra`/`readPartSourceExtra` drop the whole object when one key is malformed. Left for M4, where the transform writes `sourceExtra` and the reader first matters. | Nothing writes or reads `sourceExtra` before M4; M4's fixture tests will show which keys need per-key leniency. |
