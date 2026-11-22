# M1: Schema extensions

**Goal:** add the fork's tables and columns (X1–X6 in `MAPPING.md` §2, plus the API tables in `API.md`
§2) in one reviewed migration, with nothing else changing behaviour.

## Read first
- `docs/fork/MAPPING.md` §2, `docs/fork/API.md` §2, `docs/fork/spikes/RESULTS.md` (T6)
- `prisma/schema/service-records.prisma`, `quotes.prisma`, `technicians.prisma`, `customers.prisma`,
  `integrations.prisma`, `import.prisma`
- `scripts/generate-tenancy-schema.ts`, `src/lib/backup/build-data.ts`, `src/lib/backup/secrets.ts`

## Tasks
1. Create `prisma/schema/fork.prisma` with: `SourceRecord`, `WorkJob`, `CustomerContact`,
   `ServiceRecordMeta`, `TechnicianShift`, `ApiKey`, `ApiIdempotencyKey`, `DeletedRecord`. Every model
   has `organizationId` with `onDelete: Cascade` to `Organization`, indexes on the lookups the importer
   and API use, and `@@map` to snake_case table names like upstream.
2. Add the upstream columns, each with a `/// fork:` doc comment:
   - `ServicePart`, `QuotePart`: `jobId`, `lineKind`, `discountAmount`, `note`, `sourceExtra Json?`
   - `ServiceLabor`, `QuoteLabor`: `jobId`, `lineKind`, `technicianId` (FK Technician, SetNull),
     `completed Boolean?`, `costHours`, `costRate`, `discountAmount`, `sourceExtra Json?`
   - Back-relation lines wherever Prisma requires them (`Organization`, `ServiceRecord`, `Quote`,
     `Technician`, `Customer`, `User`).
3. `npx prisma migrate dev --name fork_import_foundation`. Read the generated SQL: it may only add tables,
   nullable columns, indexes and foreign keys.
4. `npx tsx scripts/generate-tenancy-schema.ts`, then make the tenancy test pass.
5. Backup and restore (per T6): include `SourceRecord`, `WorkJob`, `CustomerContact`, `ServiceRecordMeta`,
   `TechnicianShift` and `DeletedRecord` in workshop backups. Exclude `ApiIdempotencyKey`. Back up `ApiKey`
   with `keyHash` treated as a secret by `src/lib/backup/secrets.ts`, so a restore keeps the current install's keys.
6. Zod shapes for the new JSON columns (`sourceExtra`) in `src/integrations/shopmonkey/schema/` (read
   leniently, like the upstream JSON columns).

## Acceptance
- [ ] The migration only adds; there are no edits to existing migrations.
- [ ] The definition of done passes, including `npm run test:db` and the backup/tenancy tests.
- [ ] The app behaves exactly as before. All new columns are nullable, and no screen reads them yet.
- [ ] A test proves a workshop backup round-trips the new tables, and that `ApiKey.keyHash` is redacted.

## Out of scope
Any code that writes the new tables (that starts in M3 and A1).
