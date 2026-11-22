# A4: Write endpoints

**Goal:** every `W` and `A` in `API.md` §4, through the domain services from A2, with idempotency,
concurrency and locks.

## Read first
- `docs/fork/API.md` §3–4, the A2 services, `src/lib/document-lock.ts`, `src/lib/with-api-auth.ts` (`documentLockedResponse`)

## Tasks (per resource)
1. Create (`POST`), update (`PATCH`, partial, honouring `If-Match`), delete (`DELETE`, honouring `If-Match`).
   Each one calls the domain service and then `logAudit` with the service's event, so webhooks fire.
2. Action endpoints: work order status, payments, quote convert, time entry start/stop, inventory adjust.
3. Every `POST` honours `Idempotency-Key`.
4. Map service errors to API errors: zod errors become 400 `invalid_request` with field paths; document
   locks become 409 `document_locked`; plan gates become 403 `forbidden` with the gate in `details`; not
   found becomes 404.
5. A `demoGuard()` call wherever the service sends a message or calls a paid provider (the same rule as
   actions).

## Acceptance
- [ ] Parity tests: the API and the action produce the same rows, audit event and webhook delivery for create customer, create work order, add a labor line with a technician, record a payment, and convert a quote.
- [ ] Editing an issued invoice's lines gets 409 `document_locked` with `details.reason`.
- [ ] A replayed POST with the same key creates nothing; the same key with a different body gets 409.
- [ ] A stale `If-Match` gets 412.
- [ ] Tenant isolation over every write endpoint (including moving a vehicle to another workshop's customer id → 404).

## Out of scope
Bulk endpoints. Add them later if BlueLabel needs them.
