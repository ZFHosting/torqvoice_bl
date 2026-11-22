# Shopmonkey → Torqvoice mapping

The contract the importer is built and tested against. Each Shopmonkey object either **maps** to a
Torqvoice model, **extends** Torqvoice (a fork schema addition, X-numbered below), or is **archive
only** (kept in `SourceRecord`, exposed through the API, not shown in the app yet).

Status markers:
- **[docs]**: confirmed from shopmonkey.dev.
- **[M0]**: not confirmed. Verify in the M0 spike against a real account, record a fixture, and update
  this file.

Shopmonkey money is integer cents (`*Cents`). Torqvoice money is `Float` in major units. Convert with
`cents / 100`, rounded to 2 decimals, in one helper (`src/integrations/shopmonkey/money.ts`). Never
recompute historical totals with Torqvoice's `documentTotals`. Store Shopmonkey's totals as they are,
then let reconciliation (M6) prove the lines add up to them.

Timestamps: Shopmonkey dates are ISO date-times. Store them as UTC `DateTime`. Set `createdAt` from
`createdDate` explicitly. `updatedAt` is `@updatedAt` and will be the import time; the source's
`updatedDate` lives in `IntegrationLink.remoteUpdatedAt`.

---

## 1. Where the data comes from

All three adapters write the same thing: one `SourceRecord` row per Shopmonkey object, keyed by
`(connectionId, table, remoteId)`, holding the payload unchanged. Transform and load only ever read
`SourceRecord`, so they don't care which adapter fetched the data.

| Adapter | What it gets | When to use |
| --- | --- | --- |
| **REST API v3** (primary) | Everything the API exposes, including order services with nested labors, parts, tires, fees and subcontracts **[docs]**, payments, timesheets **[docs]**, files and PDFs **[M0: paths]** | Default. Works on every Shopmonkey plan that has API keys. |
| **EDS** (optional) | Change-data-capture of the shop's database into Postgres, with a one-time `eds import` snapshot backfill **[docs]** | Only if the shop has Shopmonkey Enterprise. Fastest and most complete for history, but PII is tokenized in EDS, so emails and phone numbers still come from the API **[docs]**. |
| **CSV exports** (fallback) | Customers, vehicles, fleets, vendors, inventory and reports **[docs]** | Only to fill gaps or cross-check counts. No line items, so it can't produce 1:1 work orders on its own. |

**API facts that shape the extractor**
- Base `https://api.shopmonkey.cloud/v3`, `Authorization: Bearer <key>` **[docs]**.
- Only admins can create keys (Settings → Integration → API Keys), and a key has its creator's permissions,
  so the key must come from an admin. Check it with `GET /v3/auth/api_key/status` **[docs]**.
- Lists use `limit` / `skip` / `orderby` / `where` query params and return `meta.hasMore` and `meta.total`
  **[docs]**. Max `limit` and the `where` syntax (needed for `updatedDate >` incremental pulls) **[M0]**.
- Rate limits aren't published. A 429 comes with `Retry-After`, `X-RateLimit-Limit-Minute` and
  `X-RateLimit-Remaining-Minute` **[docs]**. The client paces itself from those headers.
- Every response has `x-request-id`. Log it with every failure **[docs]**.
- Webhooks: Appointment, Customer, Inspection, Inventory, Message, Order, Payment, PurchaseOrder, User,
  Vehicle, Vendor. The payload has `operation` (INSERT/UPDATE/DELETE), `table`, `data`, and `diff` on
  updates. Deliveries are signed per the Standard Webhooks spec, and the endpoint has to answer within 55 s **[docs]**.

---

## 2. Fork schema extensions (built in M1)

All in `prisma/schema/fork.prisma` unless noted. "Upstream column" means a nullable column added to
an upstream model with a `/// fork:` comment.

| Id | Addition | Why |
| --- | --- | --- |
| **X1** | `SourceRecord` (organizationId, connectionId, source `'shopmonkey'`, table, remoteId, payload Json, payloadHash, remoteUpdatedAt, fetchedAt, remoteDeletedAt). Unique `(connectionId, table, remoteId)`. | Lossless archive. Transform reruns without refetching. The API's `/source-records` endpoint reads from it. |
| **X2** | `WorkJob` (organizationId, serviceRecordId?, quoteId?, name, note, ordinal, authorizationStatus, recommended, hidden, lumpSum, fixedPrice?, deferredDate?, deferredReason?, totalAmount, discountAmount, taxAmount). Upstream column `jobId` on `ServicePart`, `ServiceLabor`, `QuotePart` and `QuoteLabor`. | A Shopmonkey order is a list of **services** (jobs), each holding its own lines. Torqvoice lines are flat. Without this, the grouping (and per-job authorization and deferral) is lost. |
| **X3** | Upstream columns on `ServiceLabor` and `QuoteLabor`: `lineKind`, `technicianId` (FK Technician, SetNull), `completed`, `costHours`, `costRate`, `discountAmount`, `sourceExtra Json`. On `ServicePart` and `QuotePart`: `lineKind`, `discountAmount`, `note`, `sourceExtra Json`. | Per-line technician and cost are what tech pay and profitability need. `lineKind` records the original type (`labor`, `fee`, `epa`, `shopSupplies`, `part`, `tire`, `subcontract`), so the API can hand back exactly what Shopmonkey had. |
| **X4** | `CustomerContact` (customerId, kind `'email'\|'phone'`, value, label/type, isPrimary, marketingOptIn, subscribed). | Shopmonkey keeps several emails and phones per customer **[docs]**. Torqvoice has one of each, which keeps holding the primary. |
| **X5** | `ServiceRecordMeta` 1:1 with ServiceRecord (sourceStatus, serviceWriterUserId?, serviceWriterName, mileageOut, labels String[], authorizedAt, completedAt, fullyPaidAt, purchaseOrderNumber). | Order facts with no Torqvoice column, kept out of the upstream model. |
| **X6** | `TechnicianShift` (organizationId, technicianId, clockIn, clockOut?, durationMinutes?, note, source, sourceRemoteId). | Shopmonkey timesheet entries with activity `General` aren't tied to an order **[docs]**, and Torqvoice's `TimeEntry.serviceRecordId` is required. Hourly pay needs shifts. |

Deliberately **not** extended in this phase (archive only, API-reachable): vendors as entities, purchase
orders, statements, labor and pricing matrices, message templates, roles, Carfax flags, payment-processor
detail (fees, disputes, settlements), campaign attribution.

---

## 3. Entity map

Import order follows dependencies: settings → staff → customers → vehicles → catalog → orders → order
children → calendar → inspections → time.

| Shopmonkey | Torqvoice | Notes |
| --- | --- | --- |
| Company / Location | `Organization` + `AppSetting` | **One location per install.** More than one location needs Torqvoice's white-label license (`maxOrganizations`). The importer takes a `locationId` setting and imports that location only. |
| Tax Config | Workshop tax settings (`src/features/settings/Lib/workshopTax.ts`) | Default rate. GST/PST/HST become tax components **[M0: shape]**. |
| Labor Rate | Workshop default labor rate setting | Others are archive only. |
| Workflow Status | `WorkOrderStatus` | Each one is filed under a stage (`pending`, `in-progress`, `completed`) by an operator mapping in the import UI. The default comes from position, and `name` and `sortOrder` are kept. |
| User | `Technician` (+ optional `User` invite) | A Technician is created for every Shopmonkey user that appears on labor lines, assignments or timesheets. Login accounts are invited by hand in the UI; the importer never creates passwords. |
| Customer | `Customer` | See §4. |
| Email, PhoneNumber | `Customer.email` / `Customer.phone` (primary) + `CustomerContact` (X4) | Primary first, then the oldest. |
| Fleet | `Customer` (fleet) + `Vehicle.fleetNumber` | Fleet details **[M0]**. |
| Vehicle | `Vehicle` | See §5. |
| VehicleOwner | `Vehicle.customerId` | The current owner wins. Ownership history is archive only **[M0: endpoint and shape]**. |
| Canned Service | `LaborPreset` + `LaborPresetItem` + `LaborPresetPart` | Fees inside a canned service become preset items with pricing type `shopFee`. |
| Inventory Part | `InventoryPart` | See §7. |
| Inventory Tire | `InventoryPart` with category `Tires` | Size and model go in `description`. |
| Inventory Labor / Fee | `LaborPreset` (one line each) | Or archive only, at the operator's choice. |
| Inventory Category | `InventoryPart.category` | |
| Vendor | `InventoryPart.supplier*` fields | The vendor entity itself is archive only. |
| Order, `status = Estimate` | `Quote` + `QuotePart` / `QuoteLabor` + `WorkJob` | See §6. |
| Order, `status = RepairOrder \| Invoice` | `ServiceRecord` + lines + `WorkJob` + `ServiceRecordMeta` | See §6. |
| Service (on an order) | `WorkJob` (X2) | Deferred services also create a `VehicleFinding` (§6.4). |
| labors / parts / tires / subcontracts / fees | `ServiceLabor` / `ServicePart` with `lineKind` (X3) | See §6.2. |
| Payment | `Payment` | See §6.5. |
| Authorization | `ServiceRecordMeta.authorizedAt` + archive | E-signature images are attached as files **[M0]**. |
| Order files | `ServiceAttachment` | Downloaded into `uploadsRoot()/<org>/services/`, the same place the upload route writes **[M0: list/download paths]**. |
| Invoice PDF | `ServiceAttachment` (category `document`, `includeInInvoice: false`, description "Original Shopmonkey invoice") | Keeps the exact historical document. Optional (setting `downloadInvoicePdfs`). |
| Appointment | `Appointment` | Linked to the customer and vehicle. Set `ServiceRecord.startDateTime` when the order references it. |
| Inspection Template | `InspectionTemplate` / `Section` / `Item` | `standard: "custom"`, `country: null`. |
| Inspection | `Inspection` + `InspectionItem` + photos in `imageUrls` | Condition values per §8 **[M0]**. |
| Timesheet, activity `Order` / `Service` / `Labor` | `TimeEntry` (`source: "shopmonkey"`) | `durationMinutes` from clockIn and clockOut; the source `duration` unit is **[M0]**. |
| Timesheet, activity `General` | `TechnicianShift` (X6) | |
| Message | `SmsMessage` / `EmailMessage` | Phase 2. Archive only until then. |
| Custom fields (customer, vehicle, order) | `CustomFieldDefinition` + `CustomFieldValue` | Torqvoice entity types are `customer`, `vehicle`, `service_record` and `quote`. Definitions are created on first sight. |
| Labels | `ServiceRecordMeta.labels`; customer and vehicle labels go in a custom field "Labels" | |
| Referral Source | Customer custom field "Referral source" | |
| Statement, Purchase Order, PO lines, Part Return, Inventory Transfer, Labor/Pricing Matrix, Message Template, Role, Brand, Tire Model, TPI Scan, Payment Term/Type config | Archive only | |

---

## 4. Customer

| Shopmonkey | Torqvoice | Rule |
| --- | --- | --- |
| `firstName`, `lastName`, `companyName` | `name`, `company` | `name` is the full name, or `companyName` when there's no person. `company` is `companyName` when both exist. |
| `publicId` | `customerNumber` | Only if it's numeric and unique in the org. Otherwise auto-assign the way `createCustomer` does **[M0]**. |
| primary email / phone | `email`, `phone` | Phones are normalized with the import pipeline's helpers (`src/features/import/Lib/normalize.ts`) and the workshop country code. |
| `address1`, `address2`, `city`, `state`, `postalCode`, `country` | `address` | Composed as multiple lines, in the order the invoice prints. The components stay in `SourceRecord`. |
| `note` | `notes` | |
| `taxExempt` (+ gst/hst/pst exempt) | `taxExempt` | `true` if any of them is true. The detail is archive only. |
| `preferredContactMethod`, `marketingOptIn` | `reminderOptOut` | Opted out only when Shopmonkey says no marketing. Unknown means not opted out. |
| `customerType = Fleet` | custom field "Customer type" | |
| `customFields`, `labels`, `referralSourceId` | custom fields | |
| `createdDate` | `createdAt` | |
| `deleted = true` | not imported | Kept in `SourceRecord` with `remoteDeletedAt`. |
| — | `userId` | Required by Torqvoice. Use the user who started the import run. |

## 5. Vehicle

| Shopmonkey | Torqvoice | Rule |
| --- | --- | --- |
| `year`, `make`, `model` | `year`, `make`, `model` | Required in Torqvoice. When missing, use `make: "Unknown"`, `model: "Unknown"`, `year: 0`, and list the vehicle in the reconciliation warnings. Check how the UI shows year 0 **[M0]**. |
| `submodel`, `drivetrain`, `licensePlateState` | custom fields "Submodel", "Drivetrain", "Plate state" | |
| `coalescedVINorHIN` (fallback `vin`) | `vin` | |
| `licensePlate` | `licensePlate` | Through `normalizePlate` from `src/lib/license-plate.ts`. |
| `color` (enum) | `color` | Lowercased. |
| `engine` | `engineSize` | |
| `transmission` | `transmission` | `Manual` → `manual`; any `Automatic*` → `automatic`. The exact value goes in a custom field when it isn't plain Automatic. |
| — | `fuelType` | Set to `null` explicitly. The column defaults to `gasoline`, which would be invented data. |
| `type` | `bodyType` | |
| `unit` | `fleetNumber` | |
| `mileage` | `mileage` | Integer. The workshop unit system is set from `mileageUnit` on the first vehicle seen. |
| `note` | `Note` (title "Shopmonkey note") | Only when not empty. |
| owner | `customerId` | §3, VehicleOwner. |
| `customFields`, `labels` | custom fields | |
| `createdDate` | `createdAt` | |
| — | `userId` | The run's user, as for customers. |

## 6. Orders

### 6.1 Header

| Shopmonkey | ServiceRecord (RO / Invoice) | Quote (Estimate) |
| --- | --- | --- |
| `number` | `invoiceNumber` | `quoteNumber` |
| `name` ?? `coalescedName` ?? `generatedName` ?? first service name ?? `"Order #" + number` | `title` | `title` |
| `complaint` | one `ServiceConcern` (description = the text) | `description` |
| `recommendation` | `invoiceNotes` **[M0: check it prints on the Shopmonkey invoice; if not, use `diagnosticNotes`]** | `notes` |
| `status` + workflow stage | `status`: Invoice → `completed`; RepairOrder → the stage of its mapped `WorkOrderStatus`, or `completed` if `completedDate` is set | `status` (Torqvoice values: `draft`, `sent`, `accepted`, `rejected`, `expired`, `converted`, `changes_requested`): `accepted` if `authorized`; `rejected` if every service was declined; `expired` if `dueDate` has passed; `sent` if `messagedDate` is set; otherwise `draft` |
| `workflowStatusId` | `customStatusId` (+ `customStatusSince` = `workflowStatusDate`) | — |
| `orderCreatedDate` / `createdDate` | `serviceDate` = `repairOrderDate` ?? `orderCreatedDate`; `createdAt` = `createdDate` | `createdAt` |
| `invoicedDate` | `invoiceDate` and `sentAt`. After the record and its lines are written, call `issueInvoice(id, orgId, 'backfill')` from `src/features/invoices/Lib/issueInvoice.ts`. That's the app's own "freeze older invoices" path: it dates `issuedAt` to `sentAt` and captures the snapshot, so imported invoices are locked like issued ones **[M0: run it on a fixture and check the PDF]** | — |
| `dueDate` / `paymentDueDate` | `invoiceDueDate` | `validUntil` = `dueDate` |
| `mileageIn` / `mileageOut` | `mileage` / `ServiceRecordMeta.mileageOut` | — |
| `customerId`, `vehicleId` | `vehicleId`. Also `customerId` when the order's customer differs from the vehicle's current owner **[M0: confirm the app copes with both set]** | `customerId`, `vehicleId` |
| `assignedTechnicianIds` | `technicianId` = first; the rest become `ServiceRecordHelper` | — |
| `serviceWriterId` | `ServiceRecordMeta.serviceWriterUserId` / `serviceWriterName` | — |
| `purchaseOrderNumber` | `customerReference` | `customerReference` |
| `labels` | `ServiceRecordMeta.labels` | archive |
| `discountCents`, `discountPercent`, `appliedDiscount*` | `discountType` (`percent` / `fixed`), `discountValue`, `discountAmount` | same |
| `taxCents`, `gstCents`, `pstCents`, `hstCents` | `taxAmount`; `taxComponents` when more than one is non-zero; `taxRate` = the Tax Config rate | same |
| `totalCostCents` | `totalAmount` (and `cost`, which the spreadsheet importer also sets to the total **[M0]**) | `totalAmount` |
| `partsCents + laborCents + tiresCents + subcontractsCents + feesCents (+ epa + shopSupplies)` | `subtotal` = the sum of the stored line totals, checked against these in M6 | same |
| `paid`, `paidCostCents`, `remainingCostCents` | derived from payments (§6.5). Never set `manuallyPaid` | — |
| `deleted = true` | not imported (archive) | not imported |
| `customFields` | custom fields (`service_record`) | custom fields (`quote`) |
| — | `importBatchId` | — |

Bill-to on historical invoices: `issueInvoice(..., 'backfill')` snapshots the customer and vehicle as
they are at import time, which is Shopmonkey's current state. If the order's customer differs from the
vehicle's current owner, overwrite the customer block of `issuedData` with the order's customer after the
capture. The shape is in `src/features/invoices/Lib/issuedInvoice.ts` **[M0]**.

### 6.2 Lines

Every Shopmonkey service becomes a `WorkJob` (X2), and its lines point to it through `jobId`.
`ordinal` sets the order.

| Shopmonkey line | Torqvoice | Field rules |
| --- | --- | --- |
| `labors[]` | `ServiceLabor`, `lineKind: "labor"` | `description` = name, with the note appended on a new line; `hours`; `rate` = `rateCents/100`; `total` = Shopmonkey's line total after `multiplier` and `discountCents` **[M0: confirm the formula against `totalCents`]**; `technicianId` mapped; `completed`; `costHours`; `costRate`; `discountAmount`; `pricingType: "hourly"` |
| `parts[]` | `ServicePart`, `lineKind: "part"` | `name`, `partNumber`, `quantity`, `unitPrice` = `retailCostCents/100`, `unitCost` = `wholesaleCostCents/100`, `total`, `discountAmount`, `note`, `inventoryPartId` mapped; `sourceExtra`: sku, binLocation, vendorId, reserved, inventoryStatus, purchaseStatus |
| `tires[]` | `ServicePart`, `lineKind: "tire"`, `category: "Tires"` | As parts; `sourceExtra`: size, sku, tireIdentificationNumbers, federalExciseTaxCents, wasteTireFee |
| `subcontracts[]` | `ServicePart`, `lineKind: "subcontract"`, `category: "Sublet"` | `quantity` 1, `unitCost` = `costCents/100`, `unitPrice` = `retailCostCents/100`; vendor in `sourceExtra` |
| `fees[]` | `ServiceLabor`, `lineKind: "fee"`, `pricingType: "shopFee"` | `description` = name, `hours` 1, `rate` = `total` = `amountCents/100` (or the computed percent amount); `feeType` and `percent` in `sourceExtra` |
| order/service `epaCents`, `shopSuppliesCents` | `ServiceLabor`, `lineKind: "epa"` / `"shopSupplies"`, `pricingType: "shopFee"` | **[M0: make sure these aren't also present as `fees[]` lines, or they get counted twice]** |
| taxability | `taxable` | From Shopmonkey's per-line or per-service tax setting **[M0]**. Fall back to the workshop's defaults. |

### 6.3 Status of services

`authorizationStatus`, `recommended` and `hidden` go on `WorkJob` as they are. Lines of a service that
was **declined** or **deferred** are still imported, under their job, but they don't count toward the
document's totals. Check how Shopmonkey's `totalCostCents` treats them **[M0]**, and keep them out of
`subtotal`, with `QuotePart.excluded` / `QuoteLabor.excluded` on quotes.

### 6.4 Deferred and recommended work

A service with `deferredDate` set also creates a `VehicleFinding`:
`description` = service name, `notes` = `deferredReason`, `status: "open"`, `severity: "needs_work"`,
`serviceRecordId` = the order it was deferred on. When a later order revives it (`revivedFromId`),
set `resolvedServiceRecordId` to that later order.

### 6.5 Payments

| Shopmonkey | Torqvoice `Payment` |
| --- | --- |
| `id` | `externalId`, with `provider: "shopmonkey"` (the existing unique `(serviceRecordId, provider, externalId)` makes reruns safe) |
| `amountCents` | `amount`. `transactionType: Refund` → negative amount **[M0: confirm negative payments total correctly; if not, net refunds into the charge and record them in `note`]** |
| `recordedDate` ?? `createdDate` | `date` |
| `paymentType` | `method`: Cash → `cash`; Card → `card`; ACH/Zelle/Interac/Venmo/PayPal → `transfer`; anything else → `other`. The exact type goes in `note` as `"Shopmonkey: <paymentType>"`, plus `checkNumber` and `cardDigits` |
| `note` | appended to `note` |
| `status` ≠ `Succeeded` | not imported (archive) |
| `deposit = true` | imported as a payment on the order; `note` says "Deposit" |

Open balances survive: Torqvoice works out paid or unpaid from payments, so an unpaid Shopmonkey invoice
arrives unpaid. This is the main difference from the spreadsheet importer, which marks history as paid.

## 7. Inventory

| Shopmonkey Inventory Part | `InventoryPart` |
| --- | --- |
| `name`, `partNumber`, `description` | same |
| `sku` | `barcode`, only if unique in the org (the column is unique per org). Otherwise it goes in `tags` as `sku:<value>` |
| quantity on hand | `quantity`, plus one `StockMovement` with reason `"import"` so the history explains the starting count |
| minimum / reorder point | `minQuantity` |
| wholesale / retail cost | `unitCost` / `sellPrice` |
| bin location | `location` |
| category | `category` |
| vendor | `supplier` (+ phone, email, url from the Vendor record) |
| — | `userId` = the run's user |

## 8. Inspections

Every Shopmonkey inspection becomes a Torqvoice `Inspection` against a template imported from Shopmonkey's
template. Shopmonkey's item ratings (for example good / needs attention / urgent) map to Torqvoice
condition values from `src/features/inspections/Lib/conditions.ts`. The exact enum on both sides
**[M0]** goes here as a table once confirmed. Photos are downloaded and stored the way
`InspectionItem.imageUrls` expects. Notes map to notes.

## 9. Numbering after import

Imported numbers are kept exactly as they are. After the final import, set
`workshop.invoicePrefix` / `workshop.invoiceStartNumber` (`src/lib/job-number.ts`) so the next job continues
after the highest Shopmonkey number. If Shopmonkey numbers are plain integers, the format is empty (no
`{year}-`) **[M0: check the settings screen and `jobNumberPattern` accept an empty format]**.

## 10. Known non-1:1 points (tell the client)

- One Shopmonkey location per Torqvoice install, unless you have the white-label license.
- Invoices print lines flat until the job grouping (X2) is drawn on the invoice (milestone M9, optional).
  The grouping is stored and served by the API from day one.
- Vendors, purchase orders, statements, pricing matrices and message history are archive only in this
  phase. They're readable through `/api/v1/source-records` but not shown in the app.
- Login accounts aren't migrated. Staff get invited.
