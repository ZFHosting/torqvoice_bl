# Plan: Shopmonkey import + public API

Two tracks in one fork, built with Claude Code one milestone at a time.

- **Track M (migration):** move a Shopmonkey shop's full history into Torqvoice, keep it in sync
  until cutover, prove nothing was lost, then cut over.
- **Track A (API):** a key-authenticated REST API over everything, plus webhooks, so BlueLabel can run on
  Torqvoice without paying for anything else.

Read first: `docs/fork/FORK.md` (rules), `docs/fork/MAPPING.md` (what goes where), `docs/fork/API.md`
(the contract), `AGENTS.md` (how this codebase is written).

---

## 1. What "1 to 1" means here

Shopmonkey and Torqvoice model a shop differently. The biggest gaps: Shopmonkey groups lines into
services, keeps several emails and phones per customer, tracks a technician per labor line, and records
shifts that aren't tied to an order. So 1:1 is achieved three ways:

1. **Map** where Torqvoice already has the concept (most of it).
2. **Extend** Torqvoice where the gap matters to running the shop or to BlueLabel (X1–X6 in `MAPPING.md`).
3. **Archive** everything else, unchanged, in `SourceRecord` and serve it through the API.

The acceptance test for "1:1" is the reconciliation report (M6). Every Shopmonkey object is accounted
for as loaded, archived or skipped with a reason. Every invoice total, payment and open balance matches
to the cent.

## 2. Architecture

```
            ┌──────────── adapters (pick one or more) ────────────┐
Shopmonkey  │  REST API v3  │  EDS → Postgres  │  CSV exports      │
            └───────┬───────┴────────┬─────────┴─────────┬────────┘
                    ▼                ▼                   ▼
            ┌────────────────────────────────────────────────────┐
  STAGE     │ SourceRecord (X1): raw payload per object, hashed   │  ← lossless, re-runnable
            └──────────────────────┬─────────────────────────────┘
                                   ▼
  TRANSFORM  pure functions: SourceRecord → canonical Torqvoice rows + warnings
             (src/integrations/shopmonkey/transform/*, fixture-tested)
                                   ▼
  LOAD       idempotent upsert in dependency order, one transaction per order,
             IntegrationLink = remote id ↔ local id + checksum (skip unchanged)
                                   ▼
  RECONCILE  counts, money, balances, unmapped fields → report (UI + CLI)
                                   ▼
  DELTA      Shopmonkey webhooks + updatedDate polling → refetch → stage → transform → load
                                   ▼
  CUTOVER    freeze Shopmonkey → final delta → reconcile → numbering → disconnect
```

**Built on what Torqvoice already has**, rather than beside it:

- **Connector framework** (`src/integrations/<id>/`, `src/features/integrations/Lib/`). Shopmonkey becomes
  a connector. Credentials are encrypted by the vault. Work runs as `IntegrationJob`s (queue, retries,
  locks, `rescheduleInSeconds` for paging) from the cron (`src/lib/cron/integration-jobs.ts`), and is
  logged to `IntegrationLog`. `IntegrationLink` is the id map, with `checksum` and `remoteUpdatedAt`.
- **Generic inbound webhook route** (`src/app/api/integrations/[connector]/[connectionId]/webhook/route.ts`).
  The connector implements `webhook.receive` and returns jobs to queue.
- **ImportBatch** (`prisma/schema/import.prisma`). Every customer, vehicle, service record and inspection
  the run creates points at a batch, so a run can be undone with the existing machinery.
- **Invoice issuing** (`src/features/invoices/Lib/issueInvoice.ts`, reason `'backfill'`), which locks
  imported invoices the way the app locks its own.
- **Technician API auth pattern** (`src/lib/with-api-auth.ts`), which the public API mirrors.

**Where it runs.** The initial backfill can take hours, so it runs two ways from the same code:
- `scripts/shopmonkey/run.ts` (via `tsx`) for the operator on the server, with progress on stdout,
  resumable from checkpoints.
- Connector jobs from the cron, for delta sync and for runs started from the UI.

## 3. Milestones

| # | Milestone | Depends on | Output |
| --- | --- | --- | --- |
| **M0** | Fork setup and spikes | — | License notice, `FORK.md` wired into `CLAUDE.md`, upstream remote, spike results, anonymized Shopmonkey fixtures, every [M0] item in `MAPPING.md` resolved |
| **M1** | Schema extensions | M0 | `fork.prisma` with X1–X6, migration `fork_import_foundation`, back-relations on upstream models |
| **M2** | Shopmonkey connector and client | M1 | Manifest, read-only paced HTTP client, `test`/`identify`, registry entry |
| **M3** | Extract and stage | M2 | Extractors for every table into `SourceRecord`, checkpoints, CLI. Optional EDS and CSV adapters |
| **M4** | Transform | M3 | Pure transforms for every entity in `MAPPING.md`, fixture tests, warnings model |
| **M5** | Load | M4 | Idempotent loaders in dependency order, files and PDFs, numbering, invoice issuing, undo |
| **M6** | Reconcile | M5 | Reconciliation engine, report page and CLI, thresholds |
| **M7** | Delta sync and cutover | M6 | Webhook receiver, polling backstop, cutover runbook and command |
| **M8** | Import UI | M5 (M6, M7 for their panels) | Connection page: scope, status-to-stage and technician mapping, dry run, progress, report, undo |
| M9 | *(optional)* Job grouping in the UI and on invoices | M5 | Lines grouped under their `WorkJob` on the work order screen and the PDF |
| **A1** | API foundation | M1 | API keys and service users, `withPublicApi`, paging, idempotency, ETags, OpenAPI, Settings → API keys |
| **A2** | Domain service extraction | A1 | Write logic moved from server actions into `Lib/*Service.server.ts`, with actions unchanged on the outside |
| **A3** | Read endpoints | A1 | Every R in `API.md` §4, with serializers and tenant tests |
| **A4** | Write endpoints | A2, A3 | Every W and A in `API.md` §4 |
| **A5** | Events, reports, source records | A4, M1 | New webhook events, `/reports/*`, `/source-records`, `/deleted` |
| **A6** | Hardening | A5 | Playwright specs, contract tests from OpenAPI, isolation sweep, load check, security review |

**Order of work:** M0 → M1, then the two tracks run in parallel (M2…M8 and A1…A6). If one person drives
Claude Code, alternate between them. The migration has a deadline (cutover); the API grows with BlueLabel.

Rough size (Claude Code sessions, not calendar time): M0 2–3, M1 1–2, M2 1, M3 2–3, M4 3–4, M5 3–4,
M6 2, M7 2, M8 2–3, A1 2, A2 4–6, A3 2–3, A4 3–4, A5 2, A6 2.

## 4. How to run each milestone with Claude Code

1. New branch: `git checkout -b fork/<milestone-id>-<slug>`.
2. In Claude Code: `/milestone M3` (the command in `.claude/commands/milestone.md`). It reads `FORK.md`,
   the brief, and the files the brief lists, then proposes a plan before writing code.
3. Approve the plan, let it work, and review the diff.
4. Before the PR: ask the `migration-reviewer` agent (`.claude/agents/migration-reviewer.md`) to review
   the branch against the brief, `MAPPING.md` and `FORK.md`.
5. Definition of done (in `FORK.md`) passes. Tick the brief's acceptance list in the PR body.

## 5. Risks and how the plan handles them

| Risk | Mitigation |
| --- | --- |
| The Shopmonkey docs are incomplete (filter syntax, file endpoints, owner endpoint, money formulas) | M0 records real responses before anything is built on them. Every [M0] item blocks the milestone that needs it. |
| Unpublished rate limit makes the backfill slow | The client paces itself from `X-RateLimit-Remaining-Minute` and honours `Retry-After`. Checkpoints make the run resumable. M0 measures the real budget and estimates the run time. If it's too slow and the shop has Enterprise, use EDS. |
| Money doesn't add up (fees, EPA, shop supplies, declined services, refunds) | Store Shopmonkey's totals as they are, keep `lineKind`, and reconcile per order to the cent. M6 blocks cutover on any unexplained difference. |
| Double-counted lines (EPA or shop supplies present both as order fields and as fee lines) | Called out in `MAPPING.md` §6.2 as an [M0] check. There's a reconciliation rule for it too. |
| Webhook flood or side effects during import | The loader bypasses `withAuth` and audit (`FORK.md`). It never sends email or SMS, and never calls `demoGuard`-protected providers. |
| Upstream merges get painful | Fork code in new folders, `fork.prisma`, `/// fork:` markers, actions unchanged on the outside. Merge upstream at the start of each milestone. |
| Leaking customer data into git or logs | Anonymized fixtures only, a no-PII logging rule, and the reviewer agent checks for both. |
| Multi-location shop | One location per install without the white-label license. The importer imports one `locationId`. Confirm the shop's location count in M0. |
| License (hosting for a third party) | Not a code problem. Resolve it with the licensor before production hosting. Tracked here so it isn't forgotten. |

## 6. Open questions to answer in M0

1. Does BlueLabel's Shopmonkey account have Enterprise (EDS)? How many locations?
2. Rough volumes: customers, vehicles, orders, inspections, files (sizes the backfill and the disk).
3. Should message history (SMS and email threads) come over in this phase, or stay archive only?
4. Should original invoice PDFs be downloaded for every invoice (disk), or only for the last N years?
5. How do the shop's Shopmonkey workflow statuses map to pending / in progress / completed?
6. Which staff need Torqvoice logins on day one (they're invited, not migrated)?
7. Cutover date, and how long the shop can stop editing Shopmonkey for the final delta (normally under an hour).
