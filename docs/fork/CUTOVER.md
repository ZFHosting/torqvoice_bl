# Cutover from Shopmonkey: the runbook

For the person moving a workshop off Shopmonkey. Before this, the workshop's history is extracted and loaded, and
Torqvoice has been following Shopmonkey while the shop still works in it (the sync window, `MAPPING.md` §13).
Cutover ends that: a last pass over what changed, a check that every number agrees, and from then on Torqvoice is
the workshop's system and nothing is read from Shopmonkey again.

Every command below runs on the server that hosts the workshop, against its own database:

```bash
npx tsx --conditions=react-server scripts/shopmonkey/run.ts <command> --connection <connection id> ...
```

Nothing here ever writes to Shopmonkey: the client refuses anything but reads.

## The week before

1. **The backfill is done and loaded.** `extract` has finished, `load` has run (after a `load --dry-run` you read),
   and `reconcile` passes every gate. Fix what it names before going on; it is the same check cutover makes.
2. **The sync is running.** The connection is active, so every ten minutes `sync.delta` reads what changed in
   Shopmonkey and loads it. For changes to show within a minute instead, add a webhook in Shopmonkey (Settings,
   Integration, Webhooks) for orders, customers, vehicles, appointments, inspections, inventory and payments,
   pointing at `https://<your Torqvoice>/api/integrations/shopmonkey/<connection id>/webhook`, and paste the signing
   secret it shows (`whsec_...`) into the connection's "Webhook signing secret". The connection's log shows each
   `refetch` and `sync.delta` run.
3. **Accounting stays off.** While a connection that hears invoices (an accounting connector) is on, the sync
   stages changes but doesn't load them (an imported invoice would be sent to it). Turn those on after cutover.
4. **Tell the shop:** until cutover, Shopmonkey is the source of truth. An edit made in Torqvoice to an imported record
   is overwritten by Shopmonkey's next change to it (the load warns `local_edit_overwritten`), and a record Shopmonkey
   deletes is deleted here too, unless someone changed it here (then it is kept and listed in `state.lastSync`).
5. **Rehearse:** `cutover --shop-stopped --dry-run` goes through every step and changes nothing in the workshop.
   Note how long it took: the real run takes about as long.

## On the day

1. **Stop the shop editing Shopmonkey.** Anything changed there after the final delta is not brought over.
2. **Dry run:**
   ```bash
   ... run.ts cutover --connection <id> --shop-stopped --dry-run
   ```
   Each of the seven steps prints a line. It ends "every step would go ahead", or "Stopped at step N" with why
   (exit code 2). A dry run's reconciliation is of what is loaded now, so changes its delta just staged count as
   differences until the real run loads them; run the dry run again after a quiet minute if that's all it names.
3. **Cut over:**
   ```bash
   ... run.ts cutover --connection <id> --shop-stopped
   ```
   The steps:
   1. The shop has stopped editing Shopmonkey (`--shop-stopped` is your word for it).
   2. A final delta for every table, a load and the delete policy.
   3. The reconciliation. **Any gate failing stops the cutover here**, and nothing after it is done. Fix what it
      names (`reconcile --json` has the whole report) and run the cutover again: everything before this step is
      safe to repeat.
   4. Numbering: the next invoice number follows Shopmonkey's last (`MAPPING.md` §9).
   5. The connection is marked cut over (`state.cutover`): the "Synced from Shopmonkey" banners go (M8).
   6. The sync's queued jobs are cancelled; the schedule and the webhook do nothing from now on.
   7. A reminder of what only you can do, in Shopmonkey (below).
4. **In Shopmonkey:** delete the webhook pointing at Torqvoice (Settings, Integration, Webhooks), and revoke the API
   key the import used (Settings, Integration, API Keys).
5. **In Torqvoice:** turn accounting connectors back on if the workshop uses them. Read the list of deletes the sync
   kept (`state.lastSync.keptDeletes`, and in M8 the import page) and decide on each.

After cutover the archive stays: every Shopmonkey record, as it was last read, is still in `SourceRecord` and
reachable through the API. A second cutover is refused. A load can still be undone from the command line by its run
id (`undo`), but nothing new comes from Shopmonkey.

## How long it takes

Estimates for the sizing assumption of 50,000 orders (blocker B3); the real counts come from the M0 spike with a key
(S12). Time the rehearsal: it is the better estimate.

| Step | What it costs | Estimate |
| --- | --- | --- |
| 2. Final delta | A page of each list or search per 100 changed records, plus about seven calls per changed order (services, payments, authorizations, files, its customer and vehicle); small lists read whole | Minutes, for a day's changes; at most what one ten-minute sync would read |
| 2. Load | A pass over the whole archive; unchanged records are skipped by their hash | Not yet measured at 50,000 orders: the rehearsal's dry run says |
| 3. Reconciliation | Every staged record and every imported row | Under a minute (8 s for 50,000 generated orders in `npm run test:db`) |
| 4–7 | A few statements | Seconds |

Shopmonkey's rate limit isn't published; the client waits out a 429 as Shopmonkey asks, which can stretch step 2.
