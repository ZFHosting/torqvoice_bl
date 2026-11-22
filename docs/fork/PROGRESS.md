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

Done so far: branches created, upstream remote added (no upstream changes to merge), env set up.

## Blockers (need a human)

| # | Milestone | What's needed | Raised |
| --- | --- | --- | --- |

## Re-verify with real Shopmonkey data

(every `PROVISIONAL(M0:Sx)` assumption in code, with file and the spike question it depends on)

## Decisions log

| Date | Decision | Why |
| --- | --- | --- |
