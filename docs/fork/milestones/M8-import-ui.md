# M8: Import UI

**Goal:** an owner can run, watch, check and undo the Shopmonkey import from the connector's page,
without the command line.

## Read first
- `AGENTS.md` (server components, next-intl, shadcn, theme tokens, `DialogBody`)
- `src/app/(authenticated)/settings/integrations/[connector]/page.tsx` (how connector pages render)
- `src/features/import/Components/ImportWizard.tsx`, `ImportHistoryCard.tsx` (existing import UX to match)

## Tasks
Everything is on the Shopmonkey connector's page, in panels shown according to where the run is:
1. **Scope:** location, history from, files, PDFs, messages (the manifest settings).
2. **Mapping:** a table of Shopmonkey workflow statuses with a stage select for each (pending / in progress / completed), pre-filled from position. A table of Shopmonkey users who appear in labor or timesheets, each mapped to an existing technician or "Create technician".
3. **Run:** buttons for Extract, Dry-run load and Load, each queuing the matching jobs. Progress per table (done/total, rate, estimated time left) by polling a server action every few seconds. A Stop button that pauses the queue at the next page.
4. **Report:** the M6 report: gates at the top (pass/fail), then counts, money differences, spot checks with links, warnings and unmapped fields.
5. **Sync and cutover:** the webhook URL to paste into Shopmonkey (Settings → Webhooks) and its secret field; last delta time; a Cutover button that runs M7's flow with a confirmation dialog listing the steps.
6. **Undo:** per run, using ImportBatch. Disabled after cutover.

All strings in `messages/en/shopmonkeyImport.json`. Server actions in `src/features/shopmonkey-import/Actions/`,
each wrapped in `withAuth` with `requiredPermissions` for settings management.

## Acceptance
- [ ] A Playwright spec (`e2e/specs/shopmonkey-import.spec.ts`) runs connect (mock server) → mapping → dry run → load → report shows all gates passing → undo.
- [ ] Works in dark mode and with a non-English locale (falls back to English strings).
- [ ] Every action is owner/admin only. A member gets `forbidden`.

## Out of scope
Changing upstream's general integrations UI.
