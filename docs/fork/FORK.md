# Fork rules (BlueLabel build of Torqvoice)

This is a fork of Torqvoice that adds two things upstream does not have:

1. **A full-fidelity Shopmonkey importer** (`src/integrations/shopmonkey/`, `src/features/shopmonkey-import/`)
   that moves a shop's entire history over and keeps it in sync until cutover.
2. **A public, key-authenticated REST API** (`src/features/public-api/`, `src/app/api/v1/<resource>`)
   so BlueLabel and other integrations can read and write everything the app holds.

`AGENTS.md` still governs how code is written here. This file adds the rules that only apply to the fork.
The plan is in `docs/fork/PLAN.md`; the field-by-field mapping is `docs/fork/MAPPING.md`; the API contract
is `docs/fork/API.md`; one brief per milestone is in `docs/fork/milestones/`.

## Hard rules

- **Shopmonkey is read-only to us.** The Shopmonkey HTTP client refuses every method except `GET` and the
  `POST .../search` endpoints on its allowlist. Never add a call that creates, updates, deletes or
  moves anything in Shopmonkey, even "just to test".
- **Never commit real shop data.** Fixtures under `src/__tests__/features/integrations/fixtures/shopmonkey/` are recorded from
  a real account and then anonymized with `scripts/shopmonkey/anonymize-fixtures.ts` before they're
  committed. Names, emails, phones, VINs, plates and addresses are always replaced.
- **Never log credentials or PII.** Connector credentials come decrypted in `ctx.credentials`; don't
  print them. Log Shopmonkey ids and request ids, never customer names, emails or phone numbers.
- **Lossless by construction.** Every Shopmonkey object we fetch is stored unchanged in `SourceRecord`
  before it's transformed. If a field has no home in Torqvoice, it stays in `SourceRecord` and is
  reachable through the API. Never drop data silently: a transform that ignores a field lists it in
  `MAPPING.md` under "archive only".
- **Idempotent everywhere.** Running any import step twice gives the same database. Writes go through
  `IntegrationLink` (remote id ↔ local id, checksum of the source payload), so an unchanged source
  record is skipped and a changed one updates the same local row.
- **The importer doesn't go through `withAuth`.** It writes with Prisma inside transactions, scoped by
  `organizationId`, and records one summary audit event per run. Going through `withAuth` + `audit`
  would fire a webhook per row (`src/lib/audit.ts` dispatches webhooks) and flood subscribers.
- **The public API does go through the audit path.** Every API write calls the same domain service
  the server action calls and logs the same audit event, so webhooks fire exactly as they would from
  the UI.
- **Tenant isolation is not optional.** Every query is scoped by `organizationId`, including lookups
  by id. Every API endpoint has a test proving another workshop's id returns 404.

## Keeping upstream mergeable

We pull upstream regularly (`git fetch upstream && git merge upstream/main`). To keep those merges
cheap:

- Put fork code in **new folders** (above). Touch upstream files only where you have to, and keep the
  change small.
- New tables go in `prisma/schema/fork.prisma`. When an upstream model needs a column or back-relation,
  add it with a `/// fork:` doc comment on the line above so it's easy to spot in a merge.
- Name fork migrations `fork_<change>` (`npx prisma migrate dev --name fork_source_records`).
- When a server action's logic moves into a domain service for the API (milestone A2), keep the
  action's **name and input exactly as they were** (see "Action names are an API" in `AGENTS.md`).
- Don't reformat upstream files. Biome only, and only on lines you changed.

## License obligations (Elastic License 2.0)

- Modified copies must carry a prominent notice that the software was changed. `NOTICE-FORK.md`
  at the repo root states that, and the README links to it. Keep it.
- Don't remove or alter Torqvoice's licensing, copyright or other notices.
- Don't touch the license-key checks in `src/lib/license/` or `src/lib/features.ts` (branding and
  workshop count). They are protected by the license.
- Hosting this for a third party is the licensor's call, not ours. That's tracked outside the code.

## Definition of done (every milestone)

```bash
npm run check
npm test
NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit
npm run test:db        # when the milestone touches loaders or migrations
```

All of the above pass, new behaviour has tests, migrations are committed, and the milestone's brief
has its acceptance checklist ticked in the PR description. Update `MAPPING.md` or `API.md` in the same
PR when the code changes what they say.
