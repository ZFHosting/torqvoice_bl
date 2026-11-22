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
  with `API_KEY_PEPPER` from the environment.
- **Each key acts as its own service user.** Creating a key creates a `User` with no password and no
  login, plus an `OrganizationMember` in the workshop with a role the owner picks. Permissions come from
  that role through the existing `src/lib/permissions.ts`, so a key's scope is managed with the same
  roles screen as staff. It also gives every record a real `userId` / `createdById` (Torqvoice requires
  one on customers, vehicles, quotes and inventory).
- Revoking a key works immediately. `lastUsedAt` and `lastUsedIp` are recorded (throttled to one write a minute).
- Optional per-key IP allowlist.
- Server-to-server only: no CORS headers.

**New tables (`prisma/schema/fork.prisma`)**

| Model | Fields |
| --- | --- |
| `ApiKey` | id, organizationId, name, prefix, keyHash, serviceUserId, createdById, ipAllowlist String[], expiresAt?, revokedAt?, lastUsedAt?, lastUsedIp?, createdAt |
| `ApiIdempotencyKey` | id, apiKeyId, key, requestHash, responseStatus, responseBody Json, createdAt (purged after 24 h by a cron in `src/lib/cron/`) |
| `DeletedRecord` | id, organizationId, entityType, entityId, deletedAt, actorUserId? (written by every domain service delete) |

## 3. Conventions

| Topic | Rule |
| --- | --- |
| Envelope | `{ "data": ..., "meta": { ... } }`. Errors are `{ "error": { "code", "message", "details"? } }` with the existing `ApiErrorCode` values, plus `rate_limited`, `precondition_failed` and `idempotency_conflict`. |
| Casing | camelCase JSON. |
| Times | ISO 8601 UTC. Calendar dates the workshop types (due dates) are also returned as `YYYY-MM-DD` in the workshop's time zone, alongside the UTC value. |
| Money | Decimal numbers in major units, rounded to 2 places. Every document has `currency` (ISO 4217, from workshop settings). |
| Paging | `?limit=` (default 50, max 200) and `?cursor=` (opaque). The response has `meta.nextCursor` and `meta.hasMore`. Order is `(updatedAt, id)` ascending unless `sort=` says otherwise. |
| Sync | `?updatedSince=<ISO>` on every list. Deletes come from `GET /api/v1/deleted?since=`. |
| Expansion | `?include=lines,jobs,payments,customFields,meta,source` on the endpoints that support it. Nothing nested comes back unless it's asked for. |
| Idempotency | `Idempotency-Key` header on any `POST`. The same key with the same body replays the stored response; the same key with a different body gets 409 `idempotency_conflict`. |
| Concurrency | Every single-record `GET` returns `ETag` (a hash of `updatedAt`). `PATCH` and `DELETE` honour `If-Match`; a mismatch gets 412 `precondition_failed`. |
| Locks | Editing an issued or paid invoice gets 409 `document_locked` with `details.reason`, through the existing `documentLockedResponse`. |
| Rate limit | Per key. 429 with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`. The existing limiter is per process; that's fine for a single container. |
| Versioning | Within v1, changes are additive only. Removing or renaming a field means v2. |

## 4. Resources

`R` = read (list + get), `W` = create / update / delete, `A` = action endpoint.

| Path | Ops | Notes |
| --- | --- | --- |
| `/customers` | R W | `?q=` (name, email, phone, number). Includes `contacts` (X4) and `customFields`. |
| `/customers/{id}/contacts` | R W | Secondary emails and phones. |
| `/vehicles` | R W | `?customerId=`, `?vin=`, `?plate=`. Includes `customFields` and `notes`. |
| `/work-orders` | R W | ServiceRecord. `?status=`, `?customerId=`, `?vehicleId=`, `?invoiceNumber=`, `?technicianId=`, `?openOnly=true`. Can include `jobs`, `lines`, `concerns`, `payments`, `attachments`, `timeEntries`, `meta`, `customFields`. |
| `/work-orders/{id}/jobs` | R W | WorkJob (X2). |
| `/work-orders/{id}/lines` | R W | Labor and part lines, one list with `kind` (`labor`, `fee`, `epa`, `shopSupplies`, `part`, `tire`, `subcontract`), `jobId`, `technicianId`, `completed`. |
| `/work-orders/{id}/status` | A | `POST { status, customStatusId? }`, through the same service as the work board, so the clock-stop and portal rules apply. |
| `/work-orders/{id}/payments` | R W | Record a payment, which issues the invoice the way the UI does. |
| `/work-orders/{id}/attachments` | R W | Multipart upload; downloads are streamed through the API with key auth. |
| `/quotes` | R W | Can include `jobs`, `lines`. |
| `/quotes/{id}/convert` | A | Quote to work order, through the existing conversion code. |
| `/appointments` | R W | `?from=&to=`, `?technicianId=`. |
| `/technicians` | R W | |
| `/time-entries` | R W | `?technicianId=`, `?workOrderId=`, `?from=&to=`. |
| `/time-entries/start`, `/time-entries/{id}/stop` | A | Same rules as the technician app (one open entry per technician). |
| `/shifts` | R W | TechnicianShift (X6). |
| `/inventory-parts` | R W | |
| `/inventory-parts/{id}/adjust` | A | `POST { delta, reason, note }` writes a `StockMovement`. |
| `/labor-presets` | R W | Canned services. |
| `/inspections` | R | Templates, items and photos. Writes come in a later version. |
| `/findings` | R W | Deferred or recommended work (`VehicleFinding`). |
| `/work-order-statuses` | R | |
| `/payments` | R | Across all work orders, for accounting sync: `?from=&to=`, `?method=`. |
| `/webhooks` | R W | Manage webhook subscriptions (the existing `Webhook` model) from code. |
| `/settings` | R | Currency, time zone, tax setup, default labor rate, numbering format. |
| `/reports/sales` | R | Totals by day, week or month: invoiced, collected, tax, parts, labor, fees. |
| `/reports/receivables` | R | Open invoices with aging buckets. |
| `/reports/technicians` | R | Per technician: hours sold (labor lines with `technicianId`), hours clocked (time entries), shift hours, and jobs completed in a period. This is the input BlueLabel's pay calculation needs. |
| `/source-records` | R | Raw Shopmonkey payloads (X1): `?table=`, `?remoteId=`, `?updatedSince=`. Read-only. |
| `/deleted` | R | Tombstones: `?since=`, `?entityType=`. |
| `/openapi.json` | R | Unauthenticated. |

## 5. Webhook events added by the fork

The existing events in `src/features/webhooks/Schema/webhookSchema.ts` stay as they are. The fork adds
these (listed in that file under a `// fork:` comment, and sent from the matching domain service through
`logAudit`):

`appointment.create`, `appointment.update`, `appointment.delete`, `time_entry.start`, `time_entry.stop`,
`time_entry.update`, `shift.create`, `shift.update`, `technician.create`, `technician.update`,
`work_order.issue`, `job.create`, `job.update`, `job.delete`, `contact.create`, `contact.update`,
`contact.delete`.

Payloads keep the existing shape (`event`, `entity`, `entityId`, `data`). `data` is the same serialized
resource the API returns for that entity, so a subscriber never has to call back for basics.

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
├── Schema/<resource>.ts      # zod: query, create, update, response
├── Serializers/<resource>.ts # row → response, allowlisted fields only
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
