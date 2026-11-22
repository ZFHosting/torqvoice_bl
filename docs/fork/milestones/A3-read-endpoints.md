# A3: Read endpoints

**Goal:** every `R` in `API.md` §4, consistent, paged, filterable, and impossible to read across workshops.

## Read first
- `docs/fork/API.md` §3–4, the A1 code (`withPublicApi`, pagination, serializers, `/settings` example)
- The Prisma models for each resource

## Tasks (per resource)
1. `Schema/<resource>.ts`: a query schema (filters, `limit`, `cursor`, `updatedSince`, `include`) and a
   response schema.
2. `Serializers/<resource>.ts`: build the response field by field. Money is rounded to 2 decimals.
   `currency` comes from settings. Includes are resolved with Prisma `select`, never `include: true`
   on everything.
3. Routes: `src/app/api/v1/<resource>/route.ts` (list) and `[id]/route.ts` (get, with an `ETag`).
4. Required permission per resource: the `READ` permission of the matching `PermissionSubject`.

Resources: customers (+contacts), vehicles, work-orders (+jobs, lines, concerns, payments,
attachments metadata, timeEntries, meta), quotes (+jobs, lines), appointments, technicians,
time-entries, shifts, inventory-parts, labor-presets, inspections (+items), findings,
work-order-statuses, payments, webhooks.

Attachment downloads: `GET /api/v1/work-orders/{id}/attachments/{attachmentId}/content` streams the file
after the same org check the protected files route does. Read `src/app/api/protected/files/` before
writing it.

## Acceptance
- [ ] A table-driven tenant isolation test over every list and get endpoint.
- [ ] Paging across 500 generated records returns each one exactly once, including while records are updated during the walk.
- [ ] `updatedSince` returns only changed records.
- [ ] Every response validates against its schema, and `openapi.json` lists every endpoint.
- [ ] No serializer spreads a Prisma row (a test greps `Serializers/` for `...row` / `...record`).

## Out of scope
Writes (A4) and reports (A5).
