# Torqvoice API: a guide for integrators

This is the short version of [API.md](API.md), for developers building against a Torqvoice workshop: how to
authenticate, read everything, keep it in sync, and write safely. Every endpoint, field and filter is in the OpenAPI
document at `GET /api/v1/openapi.json` (no key needed).

All examples use `$BASE` for the workshop's address (for example `https://workshop.example.com`) and `$KEY` for an
API key.

## 1. Keys

An owner or admin creates a key in **Settings → API keys** and picks a role for it. The role decides what the key
may do, exactly as it would for a member of staff. The full key (`tvk_…`) is shown once; keep it in a secret store.

```bash
curl -s "$BASE/api/v1/customers?limit=1" -H "Authorization: Bearer $KEY"
```

- A revoked or expired key gets 401 at once.
- A key with an IP allowlist only works from those addresses.
- 120 requests a minute per key. Each answer says `X-RateLimit-Remaining`; past the limit you get 429 with
  `Retry-After` (seconds).

## 2. Reading

Every answer is `{ "data": …, "meta": … }`. An error is `{ "error": { "code", "message", "details"? } }`.

Lists are paged by cursor, oldest change first:

```bash
curl -s "$BASE/api/v1/work-orders?limit=200" -H "Authorization: Bearer $KEY"
# → { "data": [ … ], "meta": { "hasMore": true, "nextCursor": "eyJ…" } }
curl -s "$BASE/api/v1/work-orders?limit=200&cursor=eyJ…" -H "Authorization: Bearer $KEY"
```

Nested data comes only when asked for, with `include`:

```bash
curl -s "$BASE/api/v1/work-orders/$ID?include=jobs,lines,payments" -H "Authorization: Bearer $KEY"
```

An unknown filter or include is a 400, never silently ignored. Another workshop's id is a 404, exactly like an id
that doesn't exist.

Money is in major units with the document's `currency`. Times are ISO 8601 UTC. Calendar dates the workshop types
(due dates) also come as `YYYY-MM-DD` on the workshop's clock.

## 3. Keeping in sync

Use three things together: `updatedSince` for what changed, `/deleted` for what went, and webhooks to know when to
look.

1. **First run.** Page through each list you need without `updatedSince`. Note the highest `updatedAt` you saw.
2. **Each later run.** Ask with `updatedSince` a minute before the highest `updatedAt` you saw last time, page to
   the end, and de-duplicate by `id`. The minute covers writes whose transaction committed late.

   ```bash
   curl -s "$BASE/api/v1/customers?updatedSince=2026-05-04T09:29:00Z" -H "Authorization: Bearer $KEY"
   ```

3. **Deletes.** Page through `/deleted?since=` the same way. Each entry names `entityType` and `entityId`.

   ```bash
   curl -s "$BASE/api/v1/deleted?since=2026-05-04T09:29:00Z" -H "Authorization: Bearer $KEY"
   ```

   Two entries name no record. `restore` means a backup was restored. `reset` means a bulk delete (`entityId` says
   which). After either, **sync everything again from scratch**: rows came back with old `updatedAt` values, or
   went without a tombstone each.

4. **Webhooks.** Subscribe in **Settings → Webhooks** (or `POST /api/v1/webhooks`). A delivery's `data` is the
   record as the API returns it, so most events need no call back. Check each delivery's signature with the
   webhook's secret. `restore.complete` means sync everything again.

Things that don't move a record's `updatedAt`: a change to something it includes (a work order's lines or payments,
a vehicle's notes). Sync those through their own lists (`/payments`, `/time-entries`, …) or read the record again.

## 4. Writing

Writes go through the same code as the app's screens, with the same checks, document locks and webhooks.

```bash
curl -s -X POST "$BASE/api/v1/customers" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7d0c1f8e-customer-acme" \
  -d '{ "name": "Acme Logistics", "email": "fleet@acme.example" }'
```

- **Idempotency.** Send an `Idempotency-Key` on every `POST`. The same key with the same body replays the first
  answer (with `Idempotent-Replayed: true`). The same key with a different body, or while the first request is still
  running, gets 409 `idempotency_conflict`. Answers are kept for 24 hours.
- **Concurrency.** A single-record `GET` returns an `ETag`. Send it back as `If-Match` on `PATCH` or `DELETE`; if
  someone changed the record since, you get 412 `precondition_failed`. Read it again and retry.
- **Partial changes.** `PATCH` changes only the fields you send.
- **Totals are computed.** A work order's or quote's totals come from its lines, discount and tax settings. Sending
  them is a 400.
- **Locked invoices.** Changing an issued or paid invoice gets 409 `document_locked`.

### What idempotency can't promise

- If the server did the write but failed to store its answer, and your client never got that answer, a retry after
  the 5-minute in-flight window runs the write again.
- A request that runs longer than 5 minutes can be run again by a concurrent repeat with the same key.

So keep retries close to the first attempt, and for creates that matter, look the record up (by your own reference,
in a field you control) before a late retry.

## 5. Errors

| Status | Code | What to do |
| --- | --- | --- |
| 400 | `invalid_request` | Fix the request; `details` lists each `{ path, message }`. |
| 401 | `unauthorized` | The key is wrong, revoked or expired. |
| 403 | `forbidden` | The key's role lacks the permission, a plan feature is off (`details.gate`), or the request came from an address not on the key's IP allowlist. |
| 404 | `not_found` | No such record in this workshop. |
| 409 | `document_locked`, `idempotency_conflict`, `conflict` | A locked invoice; a reused idempotency key; a restore in progress (try again later). |
| 412 | `precondition_failed` | The record changed since your `ETag`. |
| 413 | `invalid_request` | An upload over its size limit (see `openapi.json` for each kind), or a JSON body over 1 MiB. |
| 429 | `rate_limited` | Wait `Retry-After` seconds: the key's 120 a minute, or too many failed attempts from your address (30 a minute; a key that has worked from that address lately still gets through). |
| 5xx | | Retry with backoff, with the same `Idempotency-Key`. |
