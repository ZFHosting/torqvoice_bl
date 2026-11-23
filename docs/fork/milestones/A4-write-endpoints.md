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

### From the A2 review
- **Prerequisite, before `PATCH /technicians/{id}` ships:** fix an upstream cross-workshop write found in
  the moved body of `updateTechnicianService` (`src/features/workboard/Lib/technicianService.server.ts`,
  originally `technicianActions.ts`): the technician update is workshop-scoped but its count is not
  checked, and the `techName` sync that follows is `serviceRecord.updateMany({ where: { technicianId: id }
  })` with no workshop filter, so another workshop's technician id renames that workshop's jobs. Fix it in
  its own commit (check the count, scope the sync by `organizationId`), and update
  `workboard/technician-service.test.ts`, which asserts today's query.
- Pass the **raw body** to the service (it validates itself, as the action did); parsing first would run a
  schema's transforms twice.
- Services call `revalidatePath`, and `vehicleService` calls `getTranslations` (the caller's cookie or
  `Accept-Language`, not the workshop's language): fine in a route handler, not outside a request.
- Line adds: `addPartToServiceRecord` calls the `addPart` helper **and** `onInventoryChanged`; an endpoint
  must do both (or move the pair into a service first), or stock alerts drift from the UI's.
- `addQuoteToServiceRecord` (validates before `withAuth`) was not moved in A2: move it if the API needs it.
- New services come with their endpoints here: customer contacts (X4), work jobs (X2), technician shifts
  (X6). Their deletes write `DeletedRecord`s like A2's.
- Create, update and status services had no direct tests in A2 (deletes did): each endpoint's tests are
  their first direct coverage, so assert rows and the audit event, not just the status code.

## Acceptance
- [ ] Parity tests: the API and the action produce the same rows, audit event and webhook delivery for create customer, create work order, add a labor line with a technician, record a payment, and convert a quote.
- [ ] Editing an issued invoice's lines gets 409 `document_locked` with `details.reason`.
- [ ] A replayed POST with the same key creates nothing; the same key with a different body gets 409.
- [ ] A stale `If-Match` gets 412.
- [ ] Tenant isolation over every write endpoint (including moving a vehicle to another workshop's customer id → 404).

## Out of scope
Bulk endpoints. Add them later if BlueLabel needs them.
