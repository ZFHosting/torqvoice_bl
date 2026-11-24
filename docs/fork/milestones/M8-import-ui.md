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
   - From M7 (Decisions log): the webhook URL is `/api/integrations/shopmonkey/<connection id>/webhook`, and the
     secret is the connection's `webhookSecret` credential. The last sync is `state.lastSync`, with the deletes
     the sync kept (`keptDeletes`: edited in Torqvoice, a locked invoice, or a record it never deletes): list them.
   - The banner on imported records until cutover, "Synced from Shopmonkey until <date>" (moved here from M7
     task 4): shown while the connection has no `state.cutover`, gone once it has. (Built as "Synced from Shopmonkey
     until cutover" with the last sync's time: the cutover has no date until it happens, B8.)
   - The status and technician mappings (task 2) are stored on the connection and passed to every load, the
     sync's own (`sync/jobs.ts`, `syncLoad`) included: until then the sync loads with the defaults, as the CLI does.
6. **Undo:** per run, using ImportBatch. Disabled after cutover.

All strings in `messages/en/shopmonkeyImport.json`. Server actions in `src/features/shopmonkey-import/Actions/`,
each wrapped in `withAuth` with `requiredPermissions` for settings management.

## Acceptance
- [ ] A Playwright spec runs connect (mock server) → mapping → dry run → load → report shows all gates passing → undo.
      (Built at `e2e/specs/shopmonkey/import.spec.ts`: the suite keeps one folder per area, e2e/README.md.)
- [ ] Works in dark mode and with a non-English locale (falls back to English strings).
- [ ] The same spec opens an imported vehicle with no year, make or model (shows "Unknown Unknown", no
      stray "0"), and a job billed to a vehicle's previous owner, on the work order and in the current
      owner's portal (M0 spikes T3, T4; blocker B10).
      (Decisions log, M8: the portal half waits on B10. What the current owner's portal shows is upstream's
      behaviour, which B10 asks the client to accept or have the import split by owner period; the spec checks the
      work order, and the portal check is written once B10 is answered.)
- [ ] Every action is owner/admin only. A member gets `forbidden`.

## Out of scope
Changing upstream's general integrations UI.
