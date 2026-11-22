# Progress ledger

The single source of truth for where the fork build stands. Claude Code reads this first in every
session (and after every context compaction) and updates it after every step. The Stop hook
(`.claude/hooks/keep-going.sh`) reads the **Milestones** table: while any row is `todo` or `in_progress`,
Claude isn't allowed to stop.

Statuses: `todo` · `in_progress` · `done` · `blocked` (needs a human; say what in **Blockers**) ·
`provisional` (done against synthetic fixtures; must be re-verified with real Shopmonkey data, which
counts as done for the hook).

## Milestones

| Id | Status | Branch | Notes |
| --- | --- | --- | --- |
| M0 | in_progress | fork/M0-setup-and-spikes | |
| M1 | todo | | |
| A1 | todo | | |
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

**M0, branch `fork/M0-setup-and-spikes` (from `fork/integration`, which was cut from `main` at 03619f67).**

Environment (local, Windows):
- Postgres 16 runs in Docker as container `torqvoice-bl-db` on `127.0.0.1:5442` (5432 is taken by another
  project; 54860–55698 are Windows-reserved). Dev DB `torqvoice`, test DB `torqvoice_test`, both migrated.
  `.env` (gitignored) points `DATABASE_URL` at it. For `npm run test:db`, export
  `E2E_DATABASE_URL=postgresql://torqvoice:torqvoice@localhost:5442/torqvoice_test` (vitest doesn't read `.env`).
- The checkout has CRLF endings (`core.autocrlf=true`); commits are normalized to LF. Biome's format check
  runs against an LF worktree in the session scratchpad (`git -c core.autocrlf=false worktree add --detach`),
  using the main checkout's `node_modules/.bin/biome`. Tests and `tsc` run in the main checkout.
- Baseline on untouched upstream (see Decisions log): `npm run check` has 14 pre-existing errors; `npm test`
  has 11–13 failing files, all Windows-specific (restic spawn, path separators).

Plan:
1. Part 1 hygiene: `NOTICE-FORK.md` + README link, `CLAUDE.md` import, `docs/fork/UPSTREAM.md` (upstream
   remote added: `https://github.com/Torqvoice/torqvoice.git`), `.env.example` entries, `.gitignore`.
2. Part 3 Torqvoice spikes T1–T7, answered from code plus throwaway scripts under `scripts/spikes/`.
3. Part 2 Shopmonkey spikes: no `SHOPMONKEY_API_KEY`, so write `scripts/shopmonkey/spike.ts` and
   `anonymize-fixtures.ts` (tested), answer S1–S12 from shopmonkey.dev as far as the docs go, and build
   **synthetic** fixtures in `src/__tests__/features/integrations/fixtures/shopmonkey/synthetic/`. M0 → `provisional`.
4. `RESULTS.md`, update `MAPPING.md` markers, answer/assign PLAN §6 questions (blockers).

Done so far:
- [x] Part 1 hygiene committed (0c7ec939): NOTICE-FORK.md, README link, CLAUDE.md import, UPSTREAM.md,
  .env.example, .gitignore, versioned .claude kit.
- [x] T1–T7 answered in `docs/fork/spikes/RESULTS.md` (dc3e7a34), MAPPING updated, blockers B2–B10 raised.
  Evidence: `scripts/spikes/torqvoice.spike.ts` (5 passing checks against `torqvoice_test`).
- [x] `scripts/shopmonkey/anonymize.ts` + CLI `anonymize-fixtures.ts`, tests
  `src/__tests__/scripts/shopmonkey/anonymize.test.ts` (8 passing).
- [x] `scripts/shopmonkey/spike-client.ts` (read-only guard, pacing, raw recording), tests
  `spike-client.test.ts` (4 passing).
- [ ] Next: `scripts/shopmonkey/spike.ts` (the S1–S12 call plan), S1–S12 from the docs in RESULTS.md,
  synthetic fixtures + README under `fixtures/shopmonkey/synthetic/`, remaining MAPPING markers → `[docs]`
  or `[provisional: Sx]`, then DoD, reviewer, merge. Shopmonkey field lists are in `docs/fork/spikes/SHOPMONKEY-SCHEMAS.md`; a fuller
  docs survey was in the session scratchpad (`shopmonkey-api-reference.md`); if it's gone, re-read shopmonkey.dev.

## Blockers (need a human)

| # | Milestone | What's needed | Raised |
| --- | --- | --- | --- |
| B1 | M0 (all M) | **A Shopmonkey API key** from a Shopmonkey admin (Settings → Integration → API Keys), exported as `SHOPMONKEY_API_KEY`, plus a secret `ANONYMIZE_SALT` (16+ chars). Then run `npx tsx scripts/shopmonkey/spike.ts` and `npx tsx scripts/shopmonkey/anonymize-fixtures.ts --deny deny.txt` (deny.txt: the shop's name, a few real surnames and VINs), and re-verify every item under "Re-verify with real Shopmonkey data". Until then M0 and every M-milestone built on its fixtures is `provisional`. | 2026-11-22 |
| B2 | M0 (PLAN §6 Q1) | Does BlueLabel's Shopmonkey account have **Enterprise (EDS)**? How many **locations**? Default taken: no EDS (REST adapter only), one location, imported by `locationId`. | 2026-11-22 |
| B3 | M0 (PLAN §6 Q2) | Rough **volumes** (customers, vehicles, orders, inspections, files/GB). The spike prints `meta.total` per table once a key exists (S12). Default: sized for 50,000 orders (the M6/A6 test size). | 2026-11-22 |
| B4 | M0 (PLAN §6 Q3) | Should **message history** (SMS/email threads) come over now? Default: **archive only** (`includeMessages` off), per MAPPING §3. | 2026-11-22 |
| B5 | M0 (PLAN §6 Q4) | **Original invoice PDFs**: every invoice, or the last N years? Default: setting `downloadInvoicePdfs` = `last 2 years`. | 2026-11-22 |
| B6 | M0 (PLAN §6 Q5) | How do the shop's Shopmonkey **workflow statuses map** to pending / in progress / completed? Default: by position (first → pending, last → completed, the rest → in progress), editable per status in the M8 mapping panel before any load. | 2026-11-22 |
| B7 | M0 (PLAN §6 Q6) | Which **staff need logins** on day one? Default: none are created; a `Technician` is created for every Shopmonkey user on labor lines, assignments or timesheets, and the owner invites logins by hand. | 2026-11-22 |
| B8 | M0 (PLAN §6 Q7) | **Cutover date** and how long the shop can stop editing Shopmonkey for the final delta. Default: plan for a freeze under one hour (CUTOVER.md, M7). | 2026-11-22 |
| B10 | M5 (T3) | **Previous owners' orders.** When a Shopmonkey order's customer differs from the vehicle's current owner, the importer sets `ServiceRecord.customerId` (MAPPING §6.1), so invoices bill the right person. Side effect (upstream behaviour, `docs/fork/spikes/RESULTS.md` T3): the vehicle's **current owner sees those jobs listed in the customer portal, with the previous owner's name and address** on the sheet. Default taken: keep MAPPING (set `customerId`). Alternative if that's not acceptable: split such vehicles into one vehicle per owner period. | 2026-11-22 |
| B9 | All | **Licensing:** hosting this fork for BlueLabel as a third party is the licensor's call under ELv2 (FORK.md). Needs a decision from Torqvoice's licensor before production hosting. Not a code task. | 2026-11-22 |

## Re-verify with real Shopmonkey data

Every `PROVISIONAL(M0:Sx)` assumption in code, and every **[provisional: Sx]** rule in `MAPPING.md`.
Rerun `grep -rn "PROVISIONAL(M0" scripts src` to refresh the code list. When B1 is resolved: record real
fixtures, compare each item below with them, fix the code or MAPPING, and remove the marker.

| Spike | Assumption | Where |
| --- | --- | --- |
| S1 | Locations come from `GET /v3/location`, falling back to `user/me.locations`; `api_key/status` 200 + `success` means valid | MAPPING §1; RESULTS S1 (M2 `server.ts` will carry the marker) |
| S2 | Search allowlist `^/v3(/[a-z_]+){1,3}/search$` covers every read-only POST | `scripts/shopmonkey/spike-client.ts:17` (and M2 `client.ts`) |
| S2 | GET lists ignore `where` and are unstable without `orderby` on `id`; max useful `limit` is 100; incremental pulls fall back to re-list + `payloadHash` | MAPPING §1; RESULTS S2 (M3 extractor) |
| S4 | Vehicle's current owner = the most recently created `vehicle_owner` row | `build-synthetic-fixtures.ts:797`; MAPPING §3 VehicleOwner |
| S4 | Order files (`files[]` on Find Order, documented) download from their `url` without extra auth | `build-synthetic-fixtures.ts` (order `files`); MAPPING §3 Order files |
| S4 | Order services come nested with lines from `GET /v3/order/:id/service` (and `include` on `GET /v3/order`) | MAPPING §1; RESULTS S4 |
| S4 | Order `labels` object read as label names; customer fleet entity archive only; signed-document images | MAPPING §3, §6.1 |
| S4 | `reminderOptOut` only from the primary email's `subscribed: false` | MAPPING §4 |
| S4 | `recommendation` prints on Shopmonkey's invoice → `invoiceNotes` | MAPPING §6.1 |
| S5 | Line total = gross − `discountCents` (labor `round(hours × rate × multiplier)`, parts/tires `round(qty × retail)`, sublet `retail`); percent fee = `round(percent% × service line base)` | `build-synthetic-fixtures.ts:113`; MAPPING §6.2 |
| S5 | A service counts toward order totals unless `Declined` or `deferredDate` set | `build-synthetic-fixtures.ts:363`; MAPPING §6.3 |
| S5 | Order-level discount comes off after tax (`totalCostCents = subtotal − discount + tax`) | `build-synthetic-fixtures.ts:412` |
| S5 | Refunds have negative `amountCents` (importer uses `-abs`); `refundedAmountCents` on charges is not subtracted again | `build-synthetic-fixtures.ts:414`; MAPPING §6.5 |
| S5 | EPA / shop supplies are never also `fee` rows; tire FET and waste fee are outside the line total | MAPPING §6.2 |
| S6 | Fees are never taxed; EPA/shop supplies taxability from the tax config | MAPPING §6.2 |
| S7 | Inspection item photos (`items[].files[]`, documented) download from their `url` | `build-synthetic-fixtures.ts:1494`; MAPPING §3, §8 |
| S8 | Timesheet `duration` is milliseconds (unused: minutes come from clock times) | `build-synthetic-fixtures.ts:1529`; MAPPING §3 |
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
| 2026-11-22 | `SourceRecord.connectionId` must not be a required FK to `IntegrationConnection` (for M1). | Spike T6: connections and links are excluded from backups by design; a backed-up `SourceRecord` would fail to restore. |
