# A5: Events, reports, source records

**Goal:** give BlueLabel push events for everything it syncs, the reports it would otherwise pay for,
raw access to everything archived from Shopmonkey, and delete tombstones.

## Read first
- `src/features/webhooks/Schema/webhookSchema.ts`, `src/features/webhooks/Lib/dispatcher.ts`, `src/lib/audit.ts`
- `docs/fork/API.md` §4–5, `prisma/schema/fork.prisma`

## Tasks
1. Add the fork events from `API.md` §5 to `WEBHOOK_EVENTS` under a `// fork:` comment. Emit them from
   the matching domain services through their audit events. Set `data` to the serialized resource (the A3
   serializer), not the raw row.
2. Add sample payloads for the new events in `src/features/webhooks/Lib/samples.ts`, so the "send test"
   button works.
3. `/api/v1/reports/sales`, `/reports/receivables`, `/reports/technicians`. Reuse queries from
   `src/features/reports/` where they exist. Group by day, week or month on the workshop's clock
   (`AGENTS.md`, "Whose clock"). The technicians report joins labor lines (`technicianId`, hours), time
   entries and shifts per technician per period.
4. `/api/v1/source-records` (read-only, filter by `table`, `remoteId`, `updatedSince`), and
   `include=source` on resources that have a link (it looks up `IntegrationLink`, then `SourceRecord`).
5. `/api/v1/deleted?since=&entityType=` from `DeletedRecord`.
6. **Restores and sync** (M1 review): a restore replaces the tombstones, removes rows without writing
   any, and brings rows back with their old `updatedAt`, so a client syncing with `updatedSince` can't
   see what a restore did. Expose it: record each restore (time, workshop) and serve it at
   `GET /api/v1/deleted` as a `restore` marker telling clients to resync in full, plus a `restore.complete`
   webhook event.

## Acceptance
- [ ] Each new event fires once per change from both the UI and the API, with the serialized `data`.
- [ ] The report figures match the app's own reports screen for the same period, on fixture data, in a time zone far from UTC.
- [ ] `source-records` is tenant-isolated and needs a `SETTINGS` read permission.

## Out of scope
New report screens in the app.
