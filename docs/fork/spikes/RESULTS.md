# M0 spike results

Answers to the M0 questions (`docs/fork/milestones/M0-setup-and-spikes.md`). Every conclusion here
either changed `MAPPING.md` or is cited from it.

> **Status: provisional.** No Shopmonkey API key was available for this run (`SHOPMONKEY_API_KEY`
> unset), so **S1–S12 are answered from Shopmonkey's public documentation only**, and every importer
> code path that depends on one of them carries a `// PROVISIONAL(M0:Sx)` comment and is listed in
> `docs/fork/PROGRESS.md` under "Re-verify with real Shopmonkey data". The fixtures in
> `src/__tests__/features/integrations/fixtures/shopmonkey/synthetic/` are **synthetic**, built from the
> documented shapes, not recorded. When a key is available: run `scripts/shopmonkey/spike.ts`, then
> `scripts/shopmonkey/anonymize-fixtures.ts`, and replace each "docs only" answer below with the recorded
> fact. **T1–T7 are answered from this codebase**: T1, T2 and T5 also ran against a real PostgreSQL
> (the spike below); T3, T4, T6 and T7 come from reading the code, cited by file and line. The brief
> asked for screenshots where the answer is visual (T3, T4). None were taken, because this run had no
> browser driving the app. The invoice side of both is covered by the T5 PDF's extracted text, and the
> screens are checked by the M8 Playwright spec, which renders imported fixtures.

How the Torqvoice spikes were run: `scripts/spikes/torqvoice.spike.ts`, a throwaway Vitest file run
against the local test database (`E2E_DATABASE_URL=... npx vitest run --config
scripts/spikes/vitest.spikes.config.ts`). It makes a workshop of its own, runs the checks, prints what it
saw, and deletes the workshop. Everything else is from reading the code, cited by file.

---

## Part 3: Torqvoice spikes (confirmed)

### T1. Can the numbering format be empty?

**Yes, and it must be, after the import.**

- The settings screen saves whatever is typed (`settingsSchema.ts:370`, `z.string().optional()`), and an
  empty string survives: both the screen (`invoice-settings.tsx:161`) and `nextJobNumber`
  (`src/lib/job-number.ts:114`) use `??`, so `''` is kept rather than replaced by the `{year}-` default.
- `jobNumberPattern('')` is `^([0-9]+)$` and `jobNumberPrefix('')` is `''` (spike, T1).
- With imported numbers `1041`, `1077`, `1050` (created in that order) and the format set to `''`, the next
  number is **`1078`**: it continues from the highest plain number.
- **Trap found:** with the default `{year}-` format left in place, nothing matches the pattern, so
  numbering falls back to the *newest* job's trailing digits: the spike got **`2026-1051`** (after `1050`,
  the last created), not after `1077`. Numbers wouldn't collide (different format), but the sequence
  would restart in the middle of the imported range. So the numbering step (MAPPING §9, M5 task 9) sets
  `workshop.invoicePrefix` to `''` when Shopmonkey numbers are plain integers, and sets
  `workshop.invoiceStartNumber` to the highest imported number + 1 as a belt-and-braces measure.

### T2. Does a negative `Payment.amount` total correctly?

**Yes while the net paid stays above zero (a partial refund); not quite when a refund brings it to zero
or below.** Every sum of payments is a plain signed sum, so balance = total − paid is right in every case.

- The database takes a negative amount (`Payment.amount Float`, no check; spike: +100 and −30 sum to 70).
- Status (`invoicePaymentStatus`, `src/lib/document-lock.ts:130-145`, also used by the lock and the vehicle
  glance): +100/−30 on a 100 invoice is `partial`; +130/−30 is `paid`; **+100/−100 is `unpaid`**.
- Where net paid ≤ 0 goes wrong (all upstream code, not fork code):
  - The work order screen calls it `partial` (`useServiceFormState.ts:413-422`), while the lock, billing
    row and portal say `unpaid`.
  - The billing summary counts unpaid as `paid = 0` and partial as `paid > 0`, so a net-negative job is
    in neither bucket (`src/features/billing/Actions/billingActions.ts:31-33`, filters at 97-101).
  - A fully refunded invoice shows its whole total due on the share page and **offers online payment
    again** (`share/invoice/[orgId]/[token]/invoice-view.tsx:257-279`, `checkout/route.ts:75-83`).
  - The aging report lists it as a receivable (`reportActions.ts:837-842`).
- Display: the modern payment row prints `-amount` in "received" styling, so a refund reads as a
  positive receipt (`service-detail/PaymentsSection.tsx:226`). The PDF prints each payment as `-amount`
  labelled only with date and method, so a refund adds back correctly but isn't called a refund
  (`buildInvoicePrint.ts:418-430`).
- Reports: "collected" is a signed sum but grouped by the job's date, not the payment's, so a later refund
  lowers the original month (`reportActions.ts:108-140`). There is no payments-by-method report.
- Validation: payments are only created (`paymentSchema.ts:5`, `min(0.01)`) or deleted; nothing updates
  one (no `db.payment.update` in `src`). An imported negative row survives everything except deletion.

**Decision (MAPPING §6.5):** a Shopmonkey refund is imported as its own `Payment` with a negative amount
and a note starting `Refund`. Netting it into the charge would lose the refund's date and method and
break per-payment reconciliation, and the totals are right either way. An order whose net paid is ≤ 0
gets the warning `refund_net_nonpositive`, so the reconciliation report (M6) lists the few orders the
display issues above affect. The display issues are upstream's; they go in MAPPING §10 (known non-1:1
points), not into fork code.

### T3. `vehicleId` and `customerId` set to different customers

**The app copes, and the job's own customer wins almost everywhere, but it's a reachable state, not a
designed one.** The rule upstream writes is "`customerId` only on a job without a vehicle" (schema comment
`service-records.prisma:157-168`; every UI write path), but the spreadsheet importer already writes both
(`importActions.ts:641-642`), and an edit keeps both (`serviceActions.ts:747`, `890-897`).

- Resolved as `record.customer ?? record.vehicle.customer` (`src/lib/service-record.ts:27-32`), so the
  job's customer is the one on: the invoice and its frozen copy (`assembleInvoicePrint.ts:459`,
  `issueInvoice.ts:21`; confirmed by the T5 PDF), the work order screen, share links, the send dialogs,
  billing (`COALESCE(sr.customerId, v.customerId)`, `billingActions.ts:210`), reports and accounting.
- Exceptions:
  - The customer page lists the job under **both** customers (`customerActions.ts:721-728`, an `OR`).
  - **The portal lists the job to the vehicle's current owner too** (`portalActions.ts:188, 227`,
    `getPortalHome.ts:51`). The sheet there shows the job customer's name and address
    (`portalActions.ts:235`). Downloading the PDF is refused (`portal/.../pdf/route.ts:55-61`).
  - The work orders list shows the job's customer but sorts by the vehicle owner (`serviceActions.ts:1460`).

**Decision:** keep MAPPING §6.1: set `customerId` only when the order's customer differs from the
vehicle's current owner. That keeps bill-to, invoices and the customer pages right for history. It also
means a **vehicle's new owner sees, in the portal, that earlier jobs exist, with the previous owner's name
and address on the sheet.** That's a privacy decision for the shop, raised as blocker B10. The
alternative is splitting such a vehicle into one Torqvoice vehicle per owner period, which costs the
shop the vehicle's continuous history.

### T4. A vehicle with `year: 0`, make and model "Unknown"

**Every screen copes, the form forces a fix on the next save, and one portal picker shows "0".**

- `Vehicle.year` is a required `Int` (`vehicles.prisma:5`). The shared name helper deliberately leaves out
  year 0 (`src/lib/vehicle-name.ts:5-26`, whose comment mentions imports), so lists, the detail page, the
  work order header, the invoice and work order PDFs, portal vehicle pages and search show "Unknown
  Unknown". Hand-built names use `.filter(Boolean)` or `year > 0`, which also drop 0. The T5 PDF prints
  "VEHICLE Unknown Unknown".
- One leak: the portal service-request picker prints `v.licensePlate ?? String(v.year)`, so "0" for a
  vehicle with no plate (`portal/Components/ServiceRequestForm.tsx:525`).
- The vehicle form always sends `year` and the schema wants 1900 or later (`vehicleSchema.ts:20-23`), so
  the next save of such a vehicle asks for a real year. That's the right nudge.
- The frozen invoice copy reads year as a plain number (`issuedInvoice.ts:78`), so issued invoices are fine.

**Decision:** keep the MAPPING §5 fallback (`year: 0`, `make`/`model` `"Unknown"`) plus a
`vehicle_missing_ymm` warning, which the reconciliation report lists so the shop can fill them in.

### T5. `issueInvoice(id, org, 'backfill')` on a record sent in the past

**Works as MAPPING assumed, with two corrections and one hazard.**

- `issuedAt` is set to `sentAt` exactly (spike: `sentAt` 2023-03-14T17:05Z → `issuedAt`
  2023-03-14T17:05Z), the design snapshot is captured, and a second call returns `false` (it never
  re-captures; `shouldIssue` in `src/features/invoices/Lib/issuedInvoice.ts:547`).
- The PDF renders from the snapshot (spike wrote `tmp/spikes/t5-backfill-invoice.pdf`, 1 page). Its text:
  number `1042`, date `Mar 14, 2023` (from `invoiceDate`), the order's lines and `Total $275.00`.
- **Correction 1, "locked":** issuing freezes what the sheet prints (workshop, customer, vehicle, design)
  but **not** the lines and totals, and it does **not** lock editing. The edit lock is derived, not stored
  (`src/lib/document-lock.ts`): it's off unless the workshop turns it on, and then follows `sentAt`
  (trigger `sent`) or payment (trigger `paid`). Spike: default settings → not locked; lock on, trigger
  `sent` → locked, reason `sent`. Imported invoices have `sentAt`, so they lock exactly like the app's own
  once the workshop enables locking. Nothing more is needed from the importer.
- **Correction 2, bill-to:** `buildIssuedInvoiceData` takes `record.customer ?? vehicle.customer`
  (`issueInvoice.ts:21`). With `ServiceRecord.customerId` set to the order's customer, the snapshot and
  the PDF already show **the order's customer** (spike: "BILL TO Billed Person", the vehicle's owner is
  "Owner Person"). The "overwrite the customer block of `issuedData` after capture" step in MAPPING §6.1 is
  unnecessary; set `customerId` on the record instead. MAPPING updated.
- **Hazard:** `captureIssue` calls `notifyIntegrations({ event: 'service.update' })`
  (`issueInvoice.ts:150`). Every connected Xero, QuickBooks, Fiken or Zoho Books connection subscribes to
  that event with an `accounting.invoice` job, and Google Calendar, Microsoft 365 and Zoom with a calendar
  push (`src/integrations/*/manifest.ts`). Issuing thousands of imported invoices would **push the whole
  Shopmonkey history into the workshop's accounting system**. M5 must refuse to issue while any connection
  subscribed to `service.update` is active (or pause it for the run), and say so in the UI. Added to
  MAPPING §6.1 and the M5 brief.
- The app's own caller of the backfill reason is "freeze older invoices"
  (`src/features/invoices/Actions/legacyInvoiceActions.ts:54`), which confirms this is the intended path.

### T6. Backup and restore: are new tables picked up automatically?

**No. Every new table must be registered by hand, and a test enforces it.**

- `src/lib/backup/manifest.ts` classifies every organisation-scoped model as either backed up
  (`BACKUP_ENTITIES`: key, export option, restore mode, clearing order) or excluded with a written reason
  (`EXCLUDED_MODELS`). `src/__tests__/lib/backup-manifest.test.ts` ("accounts for every
  organisation-scoped model", "carries everything a restore deletes") fails until a new model is in one
  of the two.
- A backed-up model also needs: a dataset in `src/lib/backup/build-data.ts` (`DATASETS`, plus an
  `include` if it nests), a node in `src/lib/backup/layout.ts`, and the restore in
  `src/lib/backup/import.ts`. `src/__tests__/lib/backup/tenancy-schema.test.ts` checks the layout against
  the manifest and the export, and `src/__tests__/db/backup-round-trip.db.test.ts` round-trips every
  column on a real database.
- `src/lib/backup/tenancy-schema.ts` is generated from the Prisma schema by
  `npx tsx scripts/generate-tenancy-schema.ts`; its test fails until it's regenerated.
- Secrets: `src/lib/backup/secrets.ts` redacts secret settings and webhook secrets unless the export asks
  for secrets.
- **Consequences for M1:**
  - `IntegrationConnection`, `IntegrationLink`, `IntegrationJob`, `IntegrationLog` and `ImportBatch` are
    **excluded** from backups by design (credentials; remote ids only valid for their connection). So a
    backed-up `SourceRecord` can't hold a required foreign key to `IntegrationConnection`: a restore
    onto an install where the connection doesn't exist would fail. `SourceRecord.connectionId` should be
    a plain indexed string (or a nullable `SetNull` FK that the restore writes as null).
  - `OrganizationMember` and `User` are not in backups either ("people are restored by inviting them"),
    so `ApiKey`, whose service user is a `User` + `OrganizationMember`, can't be restored onto another
    install without its user. M1 decides between excluding `ApiKey` (like `Session` and
    `IntegrationConnection`) and backing it up as `merge` with `keyHash` redacted.

### T7. Custom field entity types and bulk writes

- Entity types: `service_record`, `quote`, `vehicle`, `customer`
  (`src/features/custom-fields/Schema/customFieldSchema.ts:6`). `vehicle` and `customer` are "record"
  kinds, hidden until the workshop defines its first field and subject to the plan's custom-fields
  feature (`recordEntityTypes`, same file).
- Field types: `text`, `number`, `date`, `select`, `checkbox`, `textarea`. A definition's `name` must be
  `^[a-z0-9_]+$`, max 50; `label` max 100. Unique per `(organizationId, name, entityType)`.
- Values: `CustomFieldValue(fieldId, entityId, entityType, value: String)`, unique `(fieldId, entityId)`
  (`prisma/schema/custom-fields.prisma`). There is no organisation column on values; they're scoped
  through the definition.
- Bulk: the app writes values one `upsert` per field (`customFieldActions.ts:316`,
  `recordCustomFieldValues.server.ts:89`); the backup restore uses `createMany`
  (`src/lib/backup/import.ts:1115`). The importer can use `createMany({ skipDuplicates: true })` for first
  loads and `upsert` on `fieldId_entityId` for changes, inside the order's transaction.
- Definitions are created on first sight with `name` slugged from the label (e.g. `Referral source` →
  `referral_source`), `fieldType: 'text'`, `isActive: true`.

---

## Part 2: Shopmonkey spikes (documentation only, provisional)

A condensed copy of every table's fields, types and enums is in `docs/fork/spikes/SHOPMONKEY-SCHEMAS.md`.
Webhooks (for M7): payload `{ apiVersion, operation: INSERT|UPDATE|DELETE, table, data, diff[] }`, signed
per Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of
"id.timestamp.body">`); whether the secret carries a `whsec_` prefix is unstated **[docs]**. EDS: CDC of
the shop's database with a bulk export, Enterprise only, PII tokenized **[docs]**.

Sources: Shopmonkey's published table schemas (`https://shopmonkey.dev/schema/<Table>`, e.g.
`/schema/Order`) and API reference (`https://shopmonkey.dev`). Every answer below is **docs only** until
`scripts/shopmonkey/spike.ts` records it against a real account (blocker B1). The spike already asks
each question; its `_summary.json` holds the answers in the same order.

### S1. Key status, identity, company and locations

- `Authorization: Bearer <key>` against `https://api.shopmonkey.cloud/v3/...`. Keys are created by Admins
  (Settings → Integration → API Keys) and carry their creator's permissions and location access. `401` =
  bad key; `403` with code `API-472811` = the key's user lacks a permission or location.
- `GET /v3/auth/api_key/status`: documented as "200 with a JSON object"; **the body isn't documented**.
  → `test()` treats 200 + `success: true` as valid and shows Shopmonkey's `message` on 401/403.
- **Identity: `GET /v3/user/me`**, which needs no ids: `companyId`, `currentLocationId`, `locations[]`
  (`{companyId, id, name}`), `company` (`name`, ...) and `location` (address, `timezone`).
  `GET /v3/company/:id` gives the company with `locations[]` as ids only.
- **Locations:** the current docs only list `PUT /v3/location/:id`; `GET /v3/location` is in archived docs
  (Nov 2025). → `remoteOptions.locations` tries `GET /v3/location` and falls back to `user/me.locations`
  **[provisional: S1]**. Location count: open (B2).

### S2. Paging and filters

- Envelope: `{ success, data, meta: { hasMore, total } }` for lists; `{ success, data }` for one record;
  errors `{ success: false, code, message, documentation_url, data }`.
- GET lists take `limit`, `skip`, `orderby` (lower-case), `where`, `ids`, `include`; search bodies take
  `where`, `orderBy` (camel-case), `limit`, `skip`. **No maximum or default `limit` is documented**;
  community clients use 100.
- `where` uses **Prisma-style operators** (`equals`, `in`, `gte`, `lte`), shown in the timesheet and
  appointment search docs. No `$gt`. The query-string encoding is undocumented (most likely URL-encoded
  JSON).
- **Field report (unofficial, from a community client run against live shops):** the plain GET lists
  (`/v3/order`, `/v3/appointment`) **ignore `where`** and return an **unstable order** between identical
  calls, so skip-paging can repeat or miss records. Search endpoints apply their filters.
- **Consequences for M2/M3 [provisional: S2]:** page with `limit=100` and an explicit `orderby` on `id`;
  de-duplicate by `id`; finish on `hasMore === false` or a short page; and after a backfill, re-list
  once and compare counts with `meta.total`. Incremental pulls use `where: { updatedDate: { gte } }` where
  it's honoured (searches) and otherwise re-list and skip unchanged records by `payloadHash` (cheap,
  because staging already skips unchanged payloads). The spike measures each form (`whereForms`) and
  whether a sorted list is stable (`stableWithOrderbyId`).
- `GET /v3/order` documents `include: { services: { include: { labors, parts, tires, fees, subcontracts } } }`,
  which would fetch an order page with its lines in one call. The spike records whether it works.

### S3. Rate limit

Not published ("reach out to support"). A 429 carries `Retry-After` (seconds),
`X-RateLimit-Limit-Minute` and `X-RateLimit-Remaining-Minute` (rolling 60 s), and every response has
`x-request-id`. → the client paces itself from those headers (M2). Backfill estimate, to be replaced by
the spike's measured limit: calls ≈ list pages + orders × (services 1 + payments 1 + authorizations 1 +
files 1 + PDF 0–1), so **4–5 calls per order**, or 1–2 if `include` works. At an assumed 120 calls/min,
50,000 orders take roughly 28–35 hours with children fetched separately, 7–14 with `include`. Hence the
resumable checkpoints and the CLI.

### S4. Paths and shapes

Read endpoints the importer needs (from the API reference; `:id` is a Shopmonkey id):

| Need | Endpoint | Note |
| --- | --- | --- |
| List orders / get order | `GET /v3/order`, `GET /v3/order/:id` | |
| Order services with lines | `GET /v3/order/:orderId/service` | Services carry nested `labors`, `parts`, `tires`, `fees`, `subcontracts` **(assumed from MAPPING [docs]; re-verify)**. Parts and tires also have `GET /v3/order/:orderId/part` and `/tire`. |
| Order payments | `POST /v3/integration/payment/search` with `where: { orderId }` | **No** `GET /v3/order/:id/payment` in the reference. The spike tries both. |
| Order authorizations | `GET /v3/order/:id/authorization` | `Authorization` rows (method, date, note, `authorizedCostCents`) with `AuthorizationService` per service. |
| Invoice PDF | `GET /v3/order/:id/pdf?document_type=invoice` | Binary. `document_type` is required: `invoice`, `estimate`, `quote`, `repairOrder`, `worksheet` or `inspection`. |
| Order files | Embedded in Find Order (`GET /v3/order/:id`) as `files[]`: `{ id, fileName, fileSize, fileType, thumbnailUrl, url }` | Listing **[docs]**. Whether `url` downloads without the key, and for how long, is **open (S4)**. |
| Customers | **`POST /v3/customer/search`** (there is no `GET /v3/customer` list), `GET /v3/customer/:id` | |
| Customer emails / phones | **Embedded** in every customer read as `emails[]` and `phoneNumbers[]` | Separate `email` / `phone_number` tables underneath. `POST /v3/customer/email/search` and `/phone_number/search` look customers up **by address** (`{ emails: [...] }`, max 5), not by customer, so the extractor doesn't use them. |
| Customer vehicles | `GET /v3/customer/:id/vehicle` | **There is no `GET /v3/vehicle` list**: vehicles are reached through customers (or by id from orders). Vehicles with no owner are only reachable by id from an order. |
| Vehicle owners | `GET /v3/vehicle/:parentId/owners` | `vehicle_owner` rows: `customerId`, `vehicleId`, `createdDate`, nothing else. No "current" flag. |
| Inventory parts / tires / labor / fees | `POST /v3/inventory_part/search`, `/inventory_tire/search`, `/inventory_labor/search`, `/inventory_fee/search` | No GET lists. |
| Everything else | `GET /v3/<table>` | `tax_config`, `labor_rate`, `workflow_status`, `user`, `timesheet`, `canned_service`, `inspection`, `inspection_template`, `appointment`, `vendor`, `inventory_category`, `referral_source`, `label`, `payment_type_config`, `message`, `purchase_order`. |

**Never called:** `GET /v3/vehicle/vin/:vin` and `/v3/vehicle/license_plate/...` decode a vehicle with a
data provider and may be billed. The spike and the importer leave them alone.

**Consequence for M3:** the extractor walks customers (search) → their vehicles and contacts, then
orders → their vehicles by id for any vehicle not seen yet. Search endpoints are `POST`, so the client's
allowlist must cover `/v3/<table>/search` and `/v3/<table>/<sub>/search` (done in the spike client).

### S5. Money

Taken from the schemas:

- **Lines carry no total.** `labor`: `hours`, `rateCents`, `multiplier`, `multiplierType` (`Hours`/`Rate`),
  `discountCents`, `discountPercent`, `discountValueType` (`Percent`/`FixedCents`), `costHours`,
  `costRateCents`, `costTotalCents`. `part`/`tire`: `quantity`, `retailCostCents`, `wholesaleCostCents`,
  discount fields; tires add `federalExciseTaxCents`, `wasteTireFee`. `subcontract`: `costCents`,
  `retailCostCents`, discount fields. `fee`: `feeType` (`FixedCents`, `PercentService`,
  `PercentLineItem`), `amountCents`, `percent`, `subtotalCents`, `lineItemEntity`.
- **Services carry computed totals:** `calculatedLaborCents`, `calculatedPartsCents`,
  `calculatedTiresCents`, `calculatedSubcontractsCents`, `calculatedFeeCents`, `calculatedEpaCents`,
  `calculatedShopSuppliesCents`, `calculatedDiscountCents`, `calculatedTaxCents` (+ GST/PST/HST) and
  `totalCents`.
- **Orders carry per-category sums:** `laborCents`, `partsCents`, `tiresCents`, `subcontractsCents`,
  `feesCents`, `epaCents`, `shopSuppliesCents`, `discountCents`, `taxCents` (+ GST/PST/HST),
  `totalCostCents`, `paidCostCents`, `remainingCostCents`.
- **EPA and shop supplies** are service fields (`epaCents`/`epaPercent`/`epaValueType`,
  `shopSuppliesCents`/...), computed into `calculatedEpaCents`/`calculatedShopSuppliesCents`. They are
  not `fee` rows in the schema, so the double-count risk in MAPPING §6.2 looks unlikely, but it's
  re-verified on recorded orders (the transform warns `epa_also_fee` if a fee is named like EPA or shop
  supplies).

**Formula (PROVISIONAL(M0:S5)), used by the synthetic fixtures and the M4 assertions:**
line total = gross − `discountCents`, where gross is `round(hours × rateCents × multiplier)` for labor,
`round(quantity × retailCostCents)` for parts and tires, and `retailCostCents` for a subcontract; a
`FixedCents` fee is `amountCents`, a percent fee is `round(percent% × the service's line base)`. A
service's `calculated*Cents` are the sums of its lines by category. An order sums the services that
count (not `Declined`, no `deferredDate`); `totalCostCents = subtotal − discountCents + taxCents`.
Because lines carry no total of their own, **the importer reconciles per service** (lines by category vs
`calculated*Cents`) as well as per order. MAPPING §6.2 updated.

### S6. Taxes

`tax_config` (one per location): `taxSystem` (`US`, `CA`, `MX`), `taxPercent`, `gstPercent`,
`pstPercent`, `hstPercent`, and per category `laborTaxable`, `partTaxable`, `subcontractTaxable`,
`epaTaxable`, `shopSuppliesTaxable` (each with `…GST`/`…PST`/`…HST` variants), plus shop supplies caps.
Lines and services carry `taxable`, `taxableGST`, `taxablePST`, `taxableHST`; services carry `taxPercent`
and their own `gst/pst/hstPercent`. Customers carry `taxExempt`, `gstExempt`, `pstExempt`, `hstExempt`.
→ `taxable` on a Torqvoice line is the line's own `taxable` (for `CA`: true if any of the GST/PST/HST
flags is true). A Canadian order with more than one non-zero of GST/PST/HST becomes `taxComponents`.

### S7. Inspections

`inspection`: `orderId` (**required: every inspection belongs to an order**), `templateId`, `name`,
`note`, `completed`, `completedDate`, `checklistStage` (`RepairOrder`/`Invoice`). `inspection_item`:
`inspectionId`, `name`, `message`, `ordinal`, `status` **`Green` / `Yellow` / `Red` / `NotApplicable`**
(nullable), `inspectorUserId`, `recommendedCannedServiceIds`, plus `inspection_item_status_detail` rows
(checkbox labels per status). Templates: `inspection_template` + `inspection_template_item` (same
`status` enum as a default). Photos: `GET /v3/inspection` and `/v3/inspection/:id` embed `items[]`, each
with `files[]` (`{ id, fileName, fileSize, fileType, thumbnailUrl, url }`) and `statusDetails[]`
**[docs]**; downloading `url` is **open (S7)**. Rating map
(MAPPING §8): `Green → pass`, `Yellow → attention`, `Red → fail`, `NotApplicable → not_applicable`,
`null → not_inspected`.

### S8. Timesheets

`timesheet`: `technicianId` (a user id), `activity` **`General` / `Order` / `Service` / `Labor`**,
`orderId`, `serviceId`, `laborId` (nullable), `clockIn`, `clockOut` (nullable while `inProgress`),
`duration` (number, **unit not stated: open S8**), `type` (`Timeclock`/`Manual`), `flatRate`,
`rateCents`, `note`. → minutes are always derived from `clockIn`/`clockOut`; `duration` stays in
`SourceRecord`. An open shift (no `clockOut`) becomes a `TechnicianShift` with `clockOut: null`.

### S9. Workflow statuses

`workflow_status`: `name`, `position`, and two flags, **`repairOrderWorkflow`** and **`invoiceWorkflow`**,
plus archiving rules. There's no stage field. Orders carry `workflowStatusId`, `workflowStatusPosition`
and `workflowStatusDate`. → Default stage (until the operator maps it, blocker B6): a status in the
invoice workflow → `completed`; in the repair-order workflow, the first by `position` → `pending`, the
rest → `in-progress`. Better than position alone, and still editable in M8.

### S10. Catalog

`canned_service` (+ `canned_service_labor`, `_part`, `_tire`, `_fee`, `_subcontract`; same fields as
order lines, with service-level calculated totals), `inventory_part` (`name`, `number`, `sku`,
`quantity`, `availableQuantity`, `minCriticalQuantity`, `reorderQuantity`, `retailCostCents`,
`wholesaleCostCents`, `binLocation`, `categoryId`, `vendorId`), `inventory_tire` (the same plus size,
load and speed ratings, `federalExciseTaxCents`, `wasteTireFeeCents`, `tireModelId`), `vendor` (`name`,
`accountNumber`, contact name/email/`contactPhone` object, address, `url`), `inventory_category`
(`name`, `parentId`). Counts: open (S12).

### S11. Recognisable numbers

`customer.publicId` and `order.number` are both **strings** in the schema (`order.number: string`). They
may well be digits in practice, but the importer can't assume it. → `customerNumber` takes `publicId`
only when it's all digits and unique; `invoiceNumber`/`quoteNumber` take `number` as is; the numbering
step (MAPPING §9) only sets an empty format when every imported number is all digits.

### S12. Counts

Open until a key exists. The spike records `meta.total` where a list or search returns one: orders
(the paging probe), customers (an unfiltered, sorted search), and every catalog and configuration table
it samples. Vehicles have no list, so it estimates them from the customers' own `vehicleCount` (and
vehicles without an owner are only reachable through orders). Files are counted per order from
`files[]`, not in total. Some searches document no `meta` at all, so a total may come back empty;
`_summary.json` says which. Sizing assumption until then: 50,000 orders (blocker B3).
