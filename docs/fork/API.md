# Public API v1 (fork)

A key-authenticated REST API over everything the workshop holds, so BlueLabel (and any other
integration) can read, sync and write without screen-scraping or a second system. It lives beside the
technician app's API under `/api/v1/` and follows the same response shapes (`apiOk` / `apiError` in
`src/lib/with-api-auth.ts`), so the two feel like one API.

Built in milestones A1–A6 (`docs/fork/milestones/`).

---

## 1. Principles

1. **Same rules as the UI.** Every write calls the domain service the server action calls (milestone
   A2), inside the same transaction, with the same validation, document locks, permission checks and
   audit event. That means webhooks fire for API writes exactly as they do for clicks.
2. **Explicit serializers.** A response is built field by field from an allowlist in
   `src/features/public-api/Serializers/`. Never spread a Prisma row into a response; columns added
   upstream must not leak by accident.
3. **Built for sync.** Every list can be read in a stable order (`updatedAt`, `id`), filtered by
   `updatedSince`, and paged with a cursor. Deletes are recorded as tombstones. Writes support
   idempotency keys and optimistic concurrency.
4. **Self-describing.** The OpenAPI 3.1 document is generated from the same zod schemas that validate
   requests (`z.toJSONSchema`, zod 4), and served at `GET /api/v1/openapi.json`.

## 2. Authentication and access

- `Authorization: Bearer tvk_<prefix>_<secret>`. Keys start with `tvk_`. Any other bearer token is the
  technician app's and goes through `withApiAuth`, not here.
- Keys are created in **Settings → API keys** (new page, gated by the existing `api` plan feature,
  which is on for self-hosted). The full key is shown once. Only an HMAC-SHA256 of it is stored, peppered
  with `API_KEY_PEPPER` from the environment (16+ characters). An install that hasn't set it gets a pepper
  derived from `BETTER_AUTH_SECRET` under its own label, so keys work out of the box; changing either
  secret invalidates every key. Settings → API keys is for owners and admins only.
- **Each key acts as its own service user.** Creating a key creates a `User` with no password and no
  login, plus an `OrganizationMember` in the workshop with a role the owner picks. Permissions come from
  that role through the existing `src/lib/permissions.ts`, so a key's scope is managed with the same
  roles screen as staff. It also gives every record a real `userId` / `createdById` (Torqvoice requires
  one on customers, vehicles, quotes and inventory).
- Revoking a key works immediately. `lastUsedAt` and `lastUsedIp` are recorded (throttled to one write a minute).
- Optional per-key IP allowlist (exact addresses). It reads the caller's address the way upstream's
  rate limiter does (`clientAddress` in `src/lib/rate-limit.ts`): `X-Real-IP`, set by the reverse proxy
  in front of the app, or Cloudflare's `CF-Connecting-IP` when `TRUST_CF_CONNECTING_IP=true`. **It only
  holds behind a proxy that overwrites `X-Real-IP`** (nginx with `proxy_set_header X-Real-IP
  $remote_addr`, for example): with the app's port open directly, as the shipped `docker-compose.yml`
  does, a caller can send any `X-Real-IP`. A request with no address is refused when the key has an
  allowlist. The settings screen says so under the field.
- An address that fails authentication 30 times in a minute is refused (429) before any key lookup. It
  reads the address the same way, so the same caveat holds: without a proxy that overwrites
  `X-Real-IP`, a caller can spend another address's failures (and lock out a valid key using it) by
  sending that address in the header.
- Server-to-server only: no CORS headers.

**New tables (`prisma/schema/fork.prisma`)**

| Model | Fields |
| --- | --- |
| `ApiKey` | id, organizationId, name, prefix, keyHash, serviceUserId, createdById, ipAllowlist String[], expiresAt?, revokedAt?, lastUsedAt?, lastUsedIp?, createdAt, updatedAt |
| `ApiIdempotencyKey` | id, organizationId, apiKeyId, key, requestHash, responseStatus, responseBody Json, createdAt (purged after 24 h by a cron in `src/lib/cron/`) |
| `DeletedRecord` | id, organizationId, entityType, entityId, deletedAt, actorUserId? (written by every domain service delete) |

## 3. Conventions

| Topic | Rule |
| --- | --- |
| Envelope | `{ "data": ..., "meta": { ... } }`. Errors are `{ "error": { "code", "message", "details"? } }` with the existing `ApiErrorCode` values, plus `rate_limited`, `precondition_failed` and `idempotency_conflict`. |
| Casing | camelCase JSON. |
| Times | ISO 8601 UTC. Calendar dates the workshop types (due dates) are also returned as `YYYY-MM-DD` in the workshop's time zone, alongside the UTC value. |
| Money | Decimal numbers in major units, rounded to 2 places. Every document has `currency` (ISO 4217, from workshop settings). |
| Paging | `?limit=` (default 50, max 200) and `?cursor=` (opaque). The response has `meta.nextCursor` and `meta.hasMore`. Order is `(updatedAt, id)` ascending. A record updated during a walk comes round again at the end with its new state (one not read yet is read once, already changed). A query parameter a list or a get doesn't know is a 400, like an unknown include: a misspelt filter is never silently ignored. One record's own lists take no parameters. One record's own lists (`/customers/{id}/contacts`, `/work-orders/{id}/jobs`, `lines`, `payments`, `attachments`) are small and come whole, without `meta`. |
| Sync | `?updatedSince=<ISO>` on every list. Deletes come from `GET /api/v1/deleted?since=`. Start each sync a little before the last `updatedAt` you saw (a minute is plenty) and de-duplicate by `id`: a write whose transaction commits late can carry an earlier `updatedAt` than rows already read. A record's `updatedAt` is its own row's: a change to something it includes (a vehicle's note, a work order's line or payment) doesn't move it, so sync those through their own lists (`/payments`, `/time-entries`, …) or read the record again. |
| Expansion | `?include=lines,jobs,payments,customFields,meta,source` on the endpoints that support it. Nothing nested comes back unless it's asked for. `customFields` lists every value the record holds (an inactive field's too), as stored: no defaults are filled in. |
| Idempotency | `Idempotency-Key` header on any `POST`. The same key with the same body replays the stored response (with `Idempotent-Replayed: true`); the same key with a different body, or while the first request is still running, gets 409 `idempotency_conflict`. A request that fails with a 5xx gives the key back, and so does one still in flight after 5 minutes (its process died). The request hash covers the method, path, query string and body. Stored responses are kept 24 hours. |
| Concurrency | Every single-record `GET` returns `ETag` (a hash of the id and `updatedAt`). `PATCH` and `DELETE` honour `If-Match`, compared strongly (a `W/` tag never matches); a mismatch gets 412 `precondition_failed`. |
| Locks | Editing an issued or paid invoice gets 409 `document_locked` with `details.reason`, through the existing `documentLockedResponse`. |
| Rate limit | Per key, across every path: 120 requests a minute; a route that sets its own limit counts in a bucket of its own. Every answer to a valid key (success or refusal) carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`; past the limit, 429 `rate_limited` with `Retry-After`. An invalid key has no budget to report. In-process, like upstream's limiter; that's fine for a single container. |
| Versioning | Within v1, changes are additive only. Removing or renaming a field means v2. |

### 3.1 Writes (A4)

| Topic | Rule |
| --- | --- |
| Permissions | Each write asks for the permission the app's own action asks for, so a key's role works as it would for a person: for example `update:customers` for a customer's contacts, `update:services` for a work order's lines and jobs and for starting a clock, `update:time_tracking` for time entries and shifts (time tracking has only View and Edit), `update:vehicles` for findings, `update:settings` for webhooks. Each endpoint's is in its handler (`src/features/public-api/Writes/*.ts`, `permission:`); `openapi.json` doesn't list them. |
| Bodies | JSON, validated by the service the app's own action runs, so the fields and limits are the app's (`openapi.json` lists each). An unknown key is refused (400) where the API has its own body (appointments, time entries, findings, lines, contacts, jobs, shifts, the action endpoints); a service's own schema ignores one. A field naming another record (`customerId`, `vehicleId`, `workOrderId`, `technicianId`, `userId`, `jobId`, `inventoryPartId`, …), in the path or the body, must name one of the key's workshop, or the write is a 404. One exception, as in the app: in a work order's, quote's or preset's part lines, an `inventoryPartId` that names no part at all (one deleted since) is kept as sent; another workshop's part is still a 404, and `/work-orders/{id}/lines` asks for a part that exists here. |
| Totals | A work order's and a quote's `subtotal`, `discountAmount`, `taxAmount`, `totalAmount` and `taxableSubtotal` are worked out from its lines, its `discountType`/`discountValue` and the tax settings, after every write that sends lines, discount or tax; sending them is a 400. A line's `total` is its quantity × unit price, or hours × rate, to the cent: one sent that says otherwise is a 400, and one left out is filled in. A change that sends none of these leaves the totals as stored (an imported invoice keeps Shopmonkey's). A quote's percentage shop fee line isn't priced again (its editor does that). `partItems`/`laborItems` replace a document's lines as the app's form does: each is priced quantity × price, with no per-line discount, and an imported line's job, kind and discount columns are carried over by matching (MAPPING §9.2) but not taken into its total; to change one line of an imported work order, whose lines can carry a discount, use `/work-orders/{id}/lines`, which keeps it. |
| Answers | A create is 201 and a change 200, with the record as its `GET` returns it, and its `ETag`. A child (a contact, a job, a payment, an attachment) answers with itself as its list shows it, and its own `ETag`. A line has no `updatedAt` of its own: its answer carries no `ETag`, and `If-Match` on a line's `PATCH` or `DELETE` takes the work order's (`GET /work-orders/{id}`). A delete is 200 with `{ "data": { "id", "deleted": true } }` and leaves a tombstone in `/deleted`. A line removed through `/work-orders/{id}/lines/{lineId}` leaves one too (`work_order_line`), but the app's own save replaces a work order's lines with new ids and leaves none: sync lines by reading `/work-orders/{id}/lines` whole, not from tombstones. Deleting a technician deactivates them, as the app does (their clocked hours stay); they read on with `active=false`, and leave no tombstone. |
| Changes | `PATCH` changes only the fields sent: what's left out stays as it is. To empty a text field, send `""`, as the app's forms do; `null` clears a field only where the body's schema in `openapi.json` says it's nullable (the API's own bodies use it for an optional link: a line's `jobId`, an appointment's `customerId`). The services the app's forms use for whole-record saves were made to work this way (the forms send every field, so the app is unchanged). |
| Errors | A body that fails validation: 400 `invalid_request` with `details` as `[{ path, message }]`. A record of another workshop, or none: 404. An issued or locked invoice: 409 `document_locked` with `details.reason`. A plan feature that's off: 403 `forbidden` with `details.gate`. A plan's count limit (photos on a work order, for one) is the app's own refusal: 400 with its message. A restore in progress: 409 `conflict`. Completing a job without the vehicle's required meter readings: 400 with `details.meters`; custom field values the workshop refuses: 400 with `details.fields`. Any other refusal the app would show the person ("This part does not track stock"): 400 with its message. |
| Audit and webhooks | Each write logs the audit event the app's action logs, before the API answers; the webhook deliveries it fans out to go out in the background, as they do for a click. Where the app's action logs none, neither does the API: a stock adjustment and a work order attachment are in the part's stock history and on the work order, not in the audit log. A line changed one at a time is the work order changed (`service.update`). Starting a clock (`/time-entries/start`) logs `time_entry.start`, which A5 adds to the webhook events. |
| Times typed in | Appointments and time entries take the workshop's wall clock, as their dialogs do: `startDate` `YYYY-MM-DD` with `startTime` `HH:MM`, or `YYYY-MM-DDTHH:MM`, to the minute. Shifts (the fork's own) take ISO 8601 instants. Everything comes back as ISO 8601 UTC. |
| Uploads | `POST /work-orders/{id}/attachments` is `multipart/form-data`: the file in `file`, with `category`, `description` and `includeInInvoice` beside it. JPEG, PNG, WebP or HEIC up to 60 MB, PDF, text or CSV up to 25 MB, MP4, MOV or WebM up to 250 MB. Photos, PDFs and videos must be what their type says by their first bytes, and text must have no NUL bytes. The stored name is made by the server. A body without a `Content-Length` is read in full before its size is checked (A6 looks at streaming the check). |
| Idempotency | As §3, for every `POST`. An upload's `Idempotency-Key` compares its fields and files, not the multipart boundary, so a retry is a replay. A replay answers with the stored body but no `ETag` (read the record for it). A webhook's signing secret isn't kept for a replay: a replayed create answers with `secret: null`. |

## 4. Resources

`R` = read (list + get), `W` = create / update / delete, `A` = action endpoint.

| Path | Ops | Notes |
| --- | --- | --- |
| `/customers` | R W | `?q=` (name, company, email, phone, number, and the contacts' emails and phones). Includes `contacts` (X4) and `customFields`. |
| `/customers/{id}/contacts` | R W | Secondary emails and phones. |
| `/vehicles` | R W | `?customerId=`, `?vin=`, `?plate=`. Includes `customFields` and `notes`. |
| `/work-orders` | R W | ServiceRecord. `?status=`, `?customerId=` (billed to them, or on a vehicle they own, as the app lists a customer's jobs), `?vehicleId=`, `?invoiceNumber=`, `?technicianId=`, `?openOnly=true`. Can include `jobs`, `lines`, `concerns`, `payments`, `attachments`, `timeEntries`, `meta`, `customFields`. |
| `/work-orders/{id}/jobs` | R W | WorkJob (X2). |
| `/work-orders/{id}/lines` | R W | Labor and part lines, one list with `kind` (`labor`, `fee`, `epa`, `shopSupplies`, `part`, `tire`, `subcontract`), `jobId`, `technicianId`, `completed`. |
| `/work-orders/{id}/status` | A | `POST { status, customStatusId? }`, through the same service as the work board, so the clock-stop and portal rules apply. |
| `/work-orders/{id}/payments` | R W | Record a payment, which issues the invoice the way the UI does. |
| `/work-orders/{id}/attachments` | R W | Multipart upload (§3.1); each attachment's `contentUrl` downloads it. `DELETE /work-orders/{id}/attachments/{attachmentId}` removes one, and its file unless something else uses it. |
| `/work-orders/{id}/attachments/{attachmentId}/content` | R | The file itself (its own `Content-Type`), with the same key; only the workshop's own uploads. |
| `/quotes` | R W | `?status=`, `?customerId=` (made out to them, or on a vehicle they own), `?vehicleId=`. `validUntilDay` is the last valid day on the workshop's calendar. Can include `jobs`, `lines` (declined lines carry `excluded: true`), `customFields`. |
| `/quotes/{id}/convert` | A | Quote to work order, through the existing conversion code. |
| `/appointments` | R W | `?from=&to=` (by start). An appointment has no technician of its own. Booked on the workshop's clock (§3.1), with optional `notifications` (the dialog's reminders; a change that leaves them out keeps them). |
| `/technicians` | R W | `?active=true\|false`. A `userId` links a login of the workshop's own team. `DELETE` deactivates. |
| `/time-entries` | R W | `?technicianId=`, `?workOrderId=`, `?from=&to=` (by `startedAt`). |
| `/time-entries/start`, `/time-entries/{id}/stop` | A | Same rules as the technician app (one open entry per technician). `POST /time-entries/start { technicianId, workOrderId }` stops a clock running on another job and moves a job that hadn't started to in progress; on the job already running it answers 200 with that entry. Entries it starts have `source: "api"`. |
| `/shifts` | R W | TechnicianShift (X6). `?technicianId=`, `?from=&to=` (by `clockIn`). |
| `/inventory-parts` | R W | `?q=` (name, part number, barcode), `?category=`. |
| `/inventory-parts/{id}/adjust` | A | `POST { delta, note? }` moves the count and writes a `StockMovement` with reason `manual_adjustment` (the stored reasons are the app's own causes, so a client doesn't pick one). No webhook, as for the app's stock scan. |
| `/labor-presets` | R W | Canned services. |
| `/inspections` | R | `?vehicleId=`, `?status=`; `include=items` (what was checked, the condition, measured values, a photo count). Templates and photo downloads, and writes, come in a later version. |
| `/findings` | R W | Deferred or recommended work (`VehicleFinding`). `?vehicleId=`, `?status=`. Written with `workOrderId` (the job it was found on), as it reads. |
| `/findings/{id}/resolve` | A | `POST { workOrderId? }`: resolved, by the job that did the work, as the app marks it. |
| `/work-order-statuses` | R | |
| `/payments` | R | Across all work orders, for accounting sync: `?from=&to=` (by `date`), `?method=`. |
| `/webhooks` | R W | Manage webhook subscriptions (the existing `Webhook` model) from code. The URL is checked as the settings page checks it (no private or loopback addresses). A create answers with the signing `secret`, the only time it's shown. Needs `update:settings`, as in the app. |
| `/settings` | R | Currency, time zone, tax setup, default labor rate, numbering format. Needs `read:settings` (the numbering format isn't member-readable). |
| `/reports/sales` | R | Needs `read:reports`, as do the other reports. Totals by period: invoiced (`revenue`), collected, outstanding, tax, discounts, parts (cost and revenue), labor, shop fees, and the reports screen's profit. The same work orders and figures as the reports screen's revenue report: every work order started in the window, invoiced or not (`?completedOnly=true` keeps the completed ones), in the period its start falls in. On the workshop's clock: `?from=&to=` are the workshop's dates, both included (default: 1 January of the workshop's year to now); `?group=day\|week\|month` (default `month`), a week named by its Monday. A day the calendar doesn't have, or `from` after `to`, is a 400. |
| `/reports/receivables` | R | What is still owed, as of now: every work order with a due date that isn't cancelled and isn't paid in full (one without a due date isn't an invoice here; a draft with one is), aged by days past due into `current`, `1-30`, `31-60`, `61-90`, `over90`, with the due dates on the workshop's clock. The overdue total is the reports screen's past-due total. Takes no parameters. |
| `/reports/technicians` | R | Per technician and period: hours sold (labor lines with `technicianId`), minutes clocked (time entries), shift minutes, and jobs completed. This is the input BlueLabel's pay calculation needs. Hours sold and jobs completed fall in the period the work order started in; clocked and shift minutes in the period they started in, clipped to the window. Hours sold follow the reports screen (the job's technician and helpers share a job's hours by the time each clocked on it) except where a line names its own technician (imported lines, the API's lines): that line's hours are that technician's. The screen doesn't read a line's technician, so the two differ only there. |
| `/source-records` | R | Shopmonkey payloads as fetched (X1): `?table=`, `?remoteId=`, `?updatedSince=`. Read-only; needs `read:settings`. Two kinds of record are the importer's own: files (`order_file`, `inspection_file`: the entry as Shopmonkey sent it plus `_parent` and `_staged`) and `invoice_pdf` (made by the importer). Keys starting with `_` are never Shopmonkey's; `_staged.path` is relative to the server's data folder (MAPPING §1). The same record is on each imported row with `include=source` (customers, vehicles, work orders, quotes, inspections, findings, appointments, time entries, shifts, technicians, work order statuses, labor presets, inventory parts), also with `read:settings` (a key without it gets 403): the row's `sourceRecord` is `{ source, table, remoteId, payload, remoteUpdatedAt, remoteDeletedAt }` (not `source`, which a time entry and a shift already have: where they came from), the archived record the row was loaded as (it stays after the connection is removed, and goes when the load is undone), or `null` for a row made in Torqvoice. A record's `ETag` doesn't cover its source: read the source again with `include=source` or from here. |
| `/deleted` | R | Tombstones: `?since=`, `?entityType=`, oldest first, paged by `(deletedAt, id)`; each kind only to a key that may read it (`read:settings` for the rest). Two kinds name no record and go to every key: **`restore`** (a backup was restored: rows were replaced, tombstones with them, and came back with their old `updatedAt`) and **`reset`** (a bulk delete without a tombstone per row; `entityId` says which: `delete_content`, `sample_data`, `import_undo`, `shopmonkey_undo`). After either, sync everything again from scratch. Each is written once the change has committed, and comes through an `?entityType=` filter too. The content wipe writes one only when it removed records the API serves (not for notifications or messages alone), and only once it has finished: a wipe that fails partway writes none, and running it again (which finishes it) writes it then. Deletes the app makes one at a time all leave tombstones (A2, and A5 for an inspection, a payment pulled back from the accounting system, a booking's placeholder work order, and an appointment that became a work order). |
| `/openapi.json` | R | Unauthenticated. |

## 5. Webhook events added by the fork

The existing events in `src/features/webhooks/Schema/webhookSchema.ts` stay as they are. The fork adds
these (listed in that file under a `// fork:` comment, and sent from the matching domain service through
`logAudit`):

`appointment.create`, `appointment.update`, `appointment.delete`, `time_entry.start`, `time_entry.stop`,
`time_entry.create`, `time_entry.update`, `time_entry.delete`, `shift.create`, `shift.update`, `shift.delete`,
`technician.create`, `technician.update`, `technician.delete`, `work_order.issue`, `job.create`, `job.update`,
`job.delete`, `contact.create`, `contact.update`, `contact.delete` (A5 added the three deletes and
`time_entry.create`/`delete` beside the list first planned: a subscriber syncing those lists needs them), and
`restore.complete` (a backup was restored, its files too: `data` is `{ restoredAt }`; sync everything again, and
`/deleted` has a `restore` marker).

Payloads keep the existing shape (`event`, `entity`, `entityId`, `data`); `entity` is the API's kind (`job`,
`contact`, `time_entry`, …). `data` is the same serialized resource the API returns for that entity, read when the
event is sent and scoped by the workshop, so a subscriber never has to call back for basics
(`features/public-api/Lib/eventData.server.ts`); a delete's `data` is `{ id }`. A record with no endpoint of its own
carries the ids that find it, on a delete too: a contact its `customerId`, a job its `workOrderId` (or `quoteId`). A
`time_entry.start` that closed another running clock names it (`closedEntryId`), and that clock's `time_entry.stop`
goes out first. The record is read only once a webhook subscribes to the event; one that can't be read goes out as
its id and those ids.

Time entries (A5's decision): the app logs `timeEntry.create`, `timeEntry.update` (a stop too) and `timeEntry.delete`;
they go out as `time_entry.create`, `time_entry.stop` (an update that stopped the clock), `time_entry.update` and
`time_entry.delete`. Every clock sends `time_entry.start` and `time_entry.stop`: the app's own My clock, the
technician app, and the API's `/time-entries/start` (a tap on the clock already running on that job changes nothing
and sends nothing). `work_order.issue` is sent when an invoice is sent or paid, never for a backfill (the Shopmonkey
import's, or the settings' freeze of older invoices); its actor is the system, not a person. Reissuing an invoice
sends nothing new. Each fork event is in the webhook settings under its own group, with a sample payload.

## 6. Code layout

```
src/features/public-api/
├── Lib/
│   ├── withPublicApi.ts      # key auth → service user ctx, permissions, rate limit, IP allowlist
│   ├── pagination.ts         # cursor encode/decode over (updatedAt, id)
│   ├── idempotency.ts
│   ├── etag.ts
│   ├── openapi.ts            # assembles the document from Schema/*
│   └── keys.server.ts        # create / hash / verify / revoke
├── Schema/<resource>.ts      # zod: query, create, update, response; a read resource's ReadSpec
├── Serializers/<resource>.ts # row → response, allowlisted fields only (Prisma select + serializer)
├── Resources/<resource>.ts   # a read resource: its spec, permission, workshop scope, reads (Lib/readResource.ts)
├── Actions/apiKeyActions.ts  # settings page actions (withAuth, owner/admin only)
└── Components/               # Settings → API keys page
src/app/api/v1/<resource>/route.ts and [id]/route.ts   # thin: parse → service → serialize
src/features/<domain>/Lib/<domain>Service.server.ts    # write logic shared with server actions (A2)
```

## 7. Tests the API must have

- **Tenant isolation**, for every endpoint: a key from workshop A asking for a record of workshop B gets 404, on every verb.
- **Permission**: a key whose role lacks a permission gets 403 on the endpoints that need it.
- **Contract**: every response validates against its zod response schema, and therefore against `openapi.json`.
- **Parity**: creating a customer, work order, line and payment through the API gives the same rows and the same audit and webhook events as the server action. Vitest with Prisma mocked for the service layer, plus Playwright for the assembled path.
- **Locks**: editing an issued invoice gets 409 `document_locked`.
- **Idempotency and concurrency**: a replayed POST makes nothing new; a stale `If-Match` gets 412.
