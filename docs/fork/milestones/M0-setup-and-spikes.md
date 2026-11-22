# M0: Fork setup and spikes

**Goal:** make the fork ready to build on, and replace every guess in `MAPPING.md` with a recorded fact.
No product code in this milestone except the spike scripts and fixtures.

## Read first
- `AGENTS.md`, `docs/fork/FORK.md`, `docs/fork/PLAN.md`, `docs/fork/MAPPING.md`
- `src/lib/job-number.ts`, `src/features/invoices/Lib/issueInvoice.ts`, `src/lib/document-lock.ts`
- `src/features/import/Lib/pipeline.ts` (how the spreadsheet importer writes service history)

## Part 1: fork hygiene
1. Add `NOTICE-FORK.md` at the repo root: this is a modified version of Torqvoice (Elastic License 2.0),
   who changed it, and a summary of the changes (Shopmonkey importer, public API). Link it from the top
   of `README.md` in one line.
2. Append `@docs/fork/FORK.md` to `CLAUDE.md` (it currently contains only `@AGENTS.md`).
3. Add the upstream remote and document the merge routine in `docs/fork/UPSTREAM.md`: fetch, merge,
   regenerate Prisma, run the definition of done, and resolve `/// fork:` lines first.
4. Add `.env.example` entries, commented: `SHOPMONKEY_API_KEY` (spike scripts only, never the app) and
   `API_KEY_PEPPER`.
5. `.gitignore`: add `tmp/`. Upstream ignores the whole `.claude` directory. Change that line to `.claude/*`
   and add `!.claude/commands/`, `!.claude/agents/`, `!.claude/hooks/` and `!.claude/settings.json`, so the
   fork's Claude Code kit is versioned and personal files (`settings.local.json`) stay ignored. Mark the
   line with a `# fork:` comment.

## Part 2: Shopmonkey spikes (read-only)
Write `scripts/shopmonkey/spike.ts` (run with `npx tsx`). It takes `SHOPMONKEY_API_KEY` from the
environment, makes **only GET and allowlisted search calls**, and writes raw responses to
`tmp/shopmonkey-raw/` (gitignored). Then write `scripts/shopmonkey/anonymize-fixtures.ts`. It replaces
names, emails, phones, VINs, plates, addresses and free-text notes with deterministic fakes (the same
input gives the same fake, so references stay consistent), and writes to
`src/__tests__/features/integrations/fixtures/shopmonkey/`. Only anonymized output is committed.

Answer each question below in `docs/fork/spikes/RESULTS.md`, with the request, an abbreviated response,
and the conclusion. Then update `MAPPING.md`, removing each **[M0]** marker as you resolve it.

| # | Question |
| --- | --- |
| S1 | Key status and identity: `GET /v3/auth/api_key/status`. Which endpoint gives the company and its locations? How many locations? |
| S2 | Paging: the largest `limit` accepted; whether `skip` stays stable while records change; the `where` syntax for `updatedDate > X` and `deleted = false`; the `orderby` syntax. Try it on customers, vehicles and orders. |
| S3 | Rate limit: read `X-RateLimit-Limit-Minute` from real responses. Estimate the backfill call count (orders × calls per order) and run time. |
| S4 | The exact paths and shapes for: list orders, get order, order services (with nested lines), order payments (or payments filtered by order), order files and download, invoice PDF download, authorizations, vehicle owners, customer emails and phones (list), customer vehicles. |
| S5 | Money: on 10 real orders (estimate, RO, invoice, with a discount, with fees, with EPA or shop supplies, with a declined service, with a refund), check how line totals, service totals and `totalCostCents` relate. Write the formula. Are EPA and shop supplies also present as `fees[]` lines? |
| S6 | Taxes: Tax Config shape; per-line and per-service taxable flags; how GST, PST and HST appear. |
| S7 | Inspections and templates: the shape, the rating enum, and how photos are referenced. |
| S8 | Timesheets: the unit of `duration`; how activities `General` / `Order` / `Service` / `Labor` look. |
| S9 | Workflow statuses: list them, and note `position` and any stage-like field. |
| S10 | Canned services, inventory parts and tires, vendors: shapes and counts. |
| S11 | Is `publicId` on customers a short number a person would recognize? Are order `number`s plain integers? |
| S12 | Counts for every table (from `meta.total`), to size the backfill and the disk (files and PDFs). |

## Part 3: Torqvoice spikes
Answer these in the same `RESULTS.md`. Use the dev database, a throwaway script under `scripts/spikes/`,
and screenshots where the answer is visual.

| # | Question |
| --- | --- |
| T1 | Can the numbering format be empty (no `{year}-`), so imported plain numbers continue? Check the settings screen and `jobNumberPattern('')`. |
| T2 | Does a negative `Payment.amount` total correctly on the invoice, the paid/unpaid state and the reports? |
| T3 | A `ServiceRecord` with both `vehicleId` and `customerId` set to *different* customers: what do the invoice, the portal and the customer page show? |
| T4 | A `Vehicle` with `year: 0` and make/model "Unknown": does every screen and the PDF cope? |
| T5 | `issueInvoice(id, org, 'backfill')` on a record with `sentAt` in the past: is `issuedAt` set to `sentAt`, is the document locked, and does the PDF print correctly? |
| T6 | Backup and restore: are new tables picked up automatically (`src/lib/backup/build-data.ts`, `scripts/generate-tenancy-schema.ts`), or do they need registering? |
| T7 | The custom field entity types (`src/features/custom-fields/Schema/customFieldSchema.ts`) and how values are written in bulk. |

## Acceptance
- [ ] `NOTICE-FORK.md`, the README link, `CLAUDE.md` import, and `docs/fork/UPSTREAM.md` exist.
- [ ] `RESULTS.md` answers S1–S12 and T1–T7.
- [ ] Anonymized fixtures are committed for every Shopmonkey table in `MAPPING.md` §3 that the account has data for, with at least one complex order (multiple services, fees, discount, partial payment, refund).
- [ ] A grep for the real shop's name, a real customer surname and a real VIN in `src/__tests__/features/integrations/fixtures/shopmonkey/` finds nothing.
- [ ] No **[M0]** markers remain in `MAPPING.md`, or each remaining one has a written reason it's deferred.
- [ ] Open questions in `PLAN.md` §6 are answered or assigned to someone.

## Out of scope
Any app code, schema change or UI.
