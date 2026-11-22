# M7: Delta sync and cutover

**Goal:** after the backfill, keep Torqvoice current while the shop still works in Shopmonkey, then
switch over with a short freeze and a final proof.

## Read first
- `src/app/api/integrations/[connector]/[connectionId]/webhook/route.ts` (generic inbound route)
- `src/integrations/xero/webhook.ts` (an existing `webhook.receive` implementation)
- `src/features/integrations/Lib/types.ts` (`webhook` on `ConnectorServer`, `schedules` on the manifest)
- `docs/fork/MAPPING.md` §1 (Shopmonkey webhook facts)

## Tasks
1. `src/integrations/shopmonkey/webhook.ts` implements `receive`:
   - Verifies the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`,
     HMAC-SHA256 over `id.timestamp.body`, base64, with several space-separated signatures allowed) using
     constant-time compare and a 5-minute timestamp tolerance. The secret is a connection credential.
   - Dedupes on `webhook-id` (use `IntegrationJob.idempotencyKey`).
   - **Doesn't trust the payload.** It queues a `refetch` job for `(table, id)`, which fetches the record
     from the API, stages it, transforms it and loads it. On `DELETE` it marks `remoteDeletedAt` and
     applies the delete policy below.
   - Answers 200 quickly (Shopmonkey cancels deliveries slower than 55 s).
2. Polling backstop: a manifest `schedules` entry (every 10 minutes) runs `delta` per table with
   `updatedDate > highWatermark - 5 minutes`. This catches anything a webhook missed. Shopmonkey doesn't
   redeliver after a webhook is disabled.
3. Delete policy: a Shopmonkey delete of an order that's in the archive only does nothing in the app. A
   delete of a loaded record that hasn't been touched in Torqvoice since import is deleted, and recorded
   in `DeletedRecord`. If it **has** been touched, it's flagged in the report and not deleted.
4. Conflict policy before cutover: Shopmonkey is the source of truth. A Torqvoice edit to an imported
   record is overwritten by the next change from Shopmonkey and logged as a warning. The UI shows a
   banner on imported records until cutover ("Synced from Shopmonkey until <date>").
5. Cutover command (`scripts/shopmonkey/run.ts cutover --connection <id>`) and the same flow in the UI
   (M8), in this order:
   1. Confirm the shop has stopped editing Shopmonkey.
   2. Run a final delta for every table.
   3. Reconcile; stop if any gate fails.
   4. Apply numbering (MAPPING §9).
   5. Remove the banners, and set the connection to `cutover` in its state.
   6. Disable the schedule and webhooks.
   7. Print a reminder to delete the webhook in Shopmonkey and revoke the API key.
6. `docs/fork/CUTOVER.md`: the runbook for the person doing it, with time estimates from the M0 counts.

## Acceptance
- [ ] Signature tests: valid, tampered body, wrong secret, old timestamp, rotated secret (two signatures).
- [ ] A replayed delivery queues nothing new.
- [ ] Changing a fixture order on the mock server, then delivering its webhook, updates the order within one job run.
- [ ] Polling catches a change without a webhook.
- [ ] A cutover dry run on fixtures goes through every step; a forced money mismatch stops it at step 3.

## Out of scope
Two-way sync. Nothing is ever written back to Shopmonkey.
