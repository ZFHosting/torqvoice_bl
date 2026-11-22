# M4: Transform

**Goal:** pure, deterministic functions that turn staged Shopmonkey payloads into the Torqvoice rows
`MAPPING.md` describes, with warnings for anything odd. No database writes in this milestone.

## Read first
- `docs/fork/MAPPING.md` (all of it), `docs/fork/spikes/RESULTS.md` (S5–S11, T1–T7)
- `src/features/import/Lib/normalize.ts` (phone, email and name helpers to reuse)
- `src/lib/license-plate.ts`, `src/lib/taxable-lines.ts`, `src/features/work-order-statuses/Lib/stages.ts`
- `src/features/quotes/Schema/quoteSchema.ts` (`quoteStatusSchema`)

## Design
```ts
// src/integrations/shopmonkey/transform/types.ts
type TransformContext = {
  organizationId: string
  runUserId: string
  timeZone: string
  countryCode: string
  resolve: (table: string, remoteId: string) => string | null   // local id from IntegrationLink, or null
  settings: { statusStageMap: Record<string, Stage>; technicianMap: Record<string, string | 'create'> }
}
type TransformResult<T> = {
  rows: T                // plain objects shaped for Prisma create/update
  warnings: Warning[]    // { code, table, remoteId, field?, message }
  unmapped: string[]     // source fields present but not mapped (for the M6 report)
}
```
One module per entity in `src/integrations/shopmonkey/transform/`: `customer.ts`, `vehicle.ts`,
`technician.ts`, `workflowStatus.ts`, `taxSettings.ts`, `laborPreset.ts`, `inventoryPart.ts`,
`order.ts` (header, jobs, lines and meta for ServiceRecord or Quote), `payment.ts`, `appointment.ts`,
`inspectionTemplate.ts`, `inspection.ts`, `finding.ts`, `timeEntry.ts`, `shift.ts`, `customFields.ts`.
Every module follows `MAPPING.md` line for line. When the mapping is ambiguous, stop and update
`MAPPING.md` first.

## Rules
- Money only through `centsToAmount`. Never do float arithmetic on amounts you could take from Shopmonkey's
  computed totals.
- `order.ts` **asserts** that the sum of the transformed line totals (excluding declined and deferred lines)
  equals Shopmonkey's subtotal, and that the header total equals `totalCostCents`. On a mismatch it returns
  the rows plus a `money_mismatch` warning with both numbers. It never "fixes" the numbers.
- Required Torqvoice fields with no source value get the fallbacks in `MAPPING.md` and a warning.
- Every source field is either mapped or listed as unmapped. A test enumerates the fixture keys and fails
  when a key is neither.

## Acceptance
- [ ] Snapshot tests per entity against the M0 fixtures (`src/__tests__/features/integrations/shopmonkey/transform/*.test.ts`).
- [ ] The complex-order fixture transforms with zero `money_mismatch` warnings, or with an explained, tested rule in `MAPPING.md`.
- [ ] Refunds, deposits, declined services, deferred services, fees, EPA and shop supplies each have a dedicated test.
- [ ] The unmapped-key test passes.
- [ ] The transforms import nothing from `@/lib/db` (enforced by a test that greps the folder).

## Out of scope
Writing to the database (M5).
