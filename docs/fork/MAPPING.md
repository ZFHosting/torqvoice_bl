# Shopmonkey → Torqvoice mapping

The contract the importer is built and tested against. Each Shopmonkey object either **maps** to a
Torqvoice model, **extends** Torqvoice (a fork schema addition, X-numbered below), or is **archive
only** (kept in `SourceRecord`, exposed through the API, not shown in the app yet).

Status markers:
- **[docs]**: confirmed from shopmonkey.dev.
- **[M0]**: not confirmed. Verify in the M0 spike against a real account, record a fixture, and update
  this file.
- **[provisional: Sx]**: M0 ran without a Shopmonkey key, so this is our reading of the published schemas
  (`https://shopmonkey.dev/schema/<Table>`) and API reference, not a recorded fact. Code that relies on it
  carries `// PROVISIONAL(M0:Sx)` and is listed in `docs/fork/PROGRESS.md` under "Re-verify with real
  Shopmonkey data". `docs/fork/spikes/RESULTS.md` has the reasoning for each.

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
`(organizationId, source, table, remoteId)`, holding the payload unchanged. Transform and load only ever read
`SourceRecord`, so they don't care which adapter fetched the data.

| Adapter | What it gets | When to use |
| --- | --- | --- |
| **REST API v3** (primary) | Everything the API exposes, including order services with nested labors, parts, tires, fees and subcontracts **[docs]**, payments, timesheets **[docs]**, the invoice PDF (`GET /v3/order/:id/pdf?document_type=invoice`) **[docs]**, order files (`files[]` on `GET /v3/order/:id`) **[docs]** | Default. Works on every Shopmonkey plan that has API keys. |
| **EDS** (optional) | Change-data-capture of the shop's database into Postgres, with a one-time `eds import` snapshot backfill **[docs]** | Only if the shop has Shopmonkey Enterprise. Fastest and most complete for history, but PII is tokenized in EDS, so emails and phone numbers still come from the API **[docs]**. |
| **CSV exports** (fallback) | Customers, vehicles, fleets, vendors, inventory and reports **[docs]** | Only to fill gaps or cross-check counts. No line items, so it can't produce 1:1 work orders on its own. |

**API facts that shape the extractor**
- Base `https://api.shopmonkey.cloud/v3`, `Authorization: Bearer <key>` **[docs]**.
- Only admins can create keys (Settings → Integration → API Keys), and a key has its creator's permissions,
  so the key must come from an admin. Check it with `GET /v3/auth/api_key/status` **[docs]**.
- Lists use `limit` / `skip` / `orderby` / `where` query params and return `meta.hasMore` and `meta.total`
  **[docs]**. `where` uses Prisma-style operators (`equals`, `in`, `gte`, `lte`) **[docs]**; no maximum
  `limit` is documented, and a field report says GET lists ignore `where` and aren't stable without a
  sort, so the extractor pages with `limit=100`, an explicit `orderby` on `id`, de-duplicates by id, and
  relies on `payloadHash` for incremental pulls where `where` isn't honoured **[provisional: S2]**.
- Customers, inventory parts and tires have **no GET list**: they're enumerated with `POST .../search`
  **[docs]**. Vehicles have no list at all: they're reached through `GET /v3/customer/:id/vehicle` and by id
  from orders **[docs]**. Customer emails and phones are embedded in every customer read **[docs]**.
- Rate limits aren't published. A 429 comes with `Retry-After`, `X-RateLimit-Limit-Minute` and
  `X-RateLimit-Remaining-Minute` **[docs]**. The client paces itself from those headers.
- Every response has `x-request-id`. Log it with every failure **[docs]**.
- Webhooks: Appointment, Customer, Inspection, Inventory, Message, Order, Payment, PurchaseOrder, User,
  Vehicle, Vendor. The payload has `operation` (INSERT/UPDATE/DELETE), `table`, `data`, and `diff` on
  updates. Deliveries are signed per the Standard Webhooks spec, and the endpoint has to answer within 55 s **[docs]**.

**What the extractor stages (M3, `src/integrations/shopmonkey/extract/tables.ts`)** **[provisional: S2, S4]**
- Every table in §3, the archive-only ones included, under its Shopmonkey table name, plus `company`
  (`GET /v3/company/:id`, the connection's account id), `location`, `workflow` and `line_item_assignment`
  (who was assigned to a line: archived; M4 doesn't read it, see §3). A list that isn't there (`404` on an
  archive-only table) is skipped with a warning; one the import needs fails the run.
- Children per parent: a customer's vehicles; a vehicle's owners; an order's services (with their lines),
  payments (the payment search by `orderId`), authorizations, files and invoice PDF; an inspection's photos.
  A customer or vehicle an order names that no list returned is fetched by id, and its own children follow.
- Files are records of their own, `order_file`, `inspection_file` and `invoice_pdf`: the entry as Shopmonkey
  sent it, plus two keys of the importer's, `_parent` (`{ table, remoteId }`, and `itemId` for an inspection
  photo) and `_staged` (`{ path, bytes, sha256, contentType }` under `dataRoot()`, or `{ skipped }` with why).
  Any key starting with `_` is the importer's, never Shopmonkey's.
- Location: records whose `locationId` (or `locationIds`) names another location are left out, checked on
  every record because GET lists were reported to ignore `where`.
- Messages are archived whatever `includeMessages` says; the setting decides whether M5 loads them (B4).
- Orders created before `historyFrom` are staged, but their services, payments, files and PDFs aren't fetched, and
  the load leaves them out (M6): they stay in the archive, with `SourceRecord.loadSkip = history`, and so do any of
  their payments and files staged before the setting was set. One rule decides both (`createdBeforeHistory`).
  Set after a load, it leaves the orders loaded earlier as they are: linked and in Torqvoice, no longer updated.
- A child no longer returned by its parent (a service removed from an order) keeps its row, with
  `remoteDeletedAt` set.

**Not fetched** (a call per record each, for data nothing maps yet; archive-only candidates if a shop needs
them): a vehicle's mileage, engine and tire-pressure logs, images, deferred services and order details
(`/v3/vehicle/:id/...`); order part and tire summaries (`/v3/order/:id/part|tire[/summary]`, the same lines as
the services carry); inspection quick notes; message thread metadata; role notification settings; inventory
templates (`/v3/inventory_part|tire/template/search`).

**Archive-only data the extractor can't reach** **[provisional: S4]**: the fleet entity behind
`customer.fleetId` (no Fleet table or endpoint in the published reference; the id stays in the customer's
payload); the images of signed documents (`order_signed_invoice`, `order_signed_inspection`: no read endpoint
in the reference; the authorization rows that record a signature are staged); purchase-order lines, unless
`GET /v3/purchase_order` embeds them (the payload is staged as returned, so embedded lines come with it). Each
is re-checked with a key (B1).

**How a re-run sees changes** **[provisional: S2]** (the sync window after the backfill is §13): a table with a
list is re-read whole (or by `updatedDate`
for searches with `--since`), and an unchanged record writes nothing. Records reached only as children are
refetched when their parent's payload changes: a vehicle when its customer changes, its owners when the
vehicle changes, an order's services, payments, authorizations and files when the order changes. An edit to
a child alone (a vehicle's mileage, a payment's note) isn't seen until its parent changes; M7's webhooks (and
its polling backstop) have to cover those. A parent's hash leaves out the links of its `files[]` entries,
which may be signed per read, so a fresh link alone doesn't refetch its children; file links are always read
fresh from the parent by id at download time. A file that fails to download for now (a 5xx, an expired
link, a timeout) isn't staged and leaves its parent pending, so the next run tries again; one refused for
good (too large, a type the app doesn't take, a private address, not a link) is staged with `_staged.skipped`.

---

## 2. Fork schema extensions (built in M1)

All in `prisma/schema/fork.prisma` unless noted. "Upstream column" means a nullable column added to
an upstream model with a `/// fork:` comment.

| Id | Addition | Why |
| --- | --- | --- |
| **X1** | `SourceRecord` (organizationId, connectionId, source `'shopmonkey'`, table, remoteId, payload Json, payloadHash, remoteUpdatedAt, fetchedAt, remoteDeletedAt). Unique `(organizationId, source, table, remoteId)`: one Shopmonkey connection per workshop (§3), and a reconnect or a restore makes a new connection id, so the id can't be part of the key (M1 review). `connectionId` records which connection last fetched the row; it is a plain id, not a foreign key: connections hold credentials and are never in a backup, while the archive is (M1). | Lossless archive. Transform reruns without refetching. The API's `/source-records` endpoint reads from it. |
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
| Tax Config | Workshop tax settings (`src/features/settings/Lib/workshopTax.ts`) | Default rate from `taxPercent` (US) or the GST/PST/HST percents (CA), which become tax components. Shape **[docs]**, RESULTS S6. |
| Labor Rate | Workshop default labor rate setting | Others are archive only. |
| Workflow Status | `WorkOrderStatus` | Each one is filed under a stage (`pending`, `in-progress`, `completed`) by an operator mapping in the import UI. The default, until the operator changes it: a status in Shopmonkey's invoice workflow → `completed`; in the repair-order workflow, the first by `position` → `pending` and the rest → `in-progress` (RESULTS S9, blocker B6). `name` and `sortOrder` are kept. |
| User | `Technician` (+ optional `User` invite) | A Technician is created for every Shopmonkey user that appears on labor lines, assignments or timesheets. Login accounts are invited by hand in the UI; the importer never creates passwords. |
| Customer | `Customer` | See §4. |
| Email, PhoneNumber | `Customer.email` / `Customer.phone` (primary) + `CustomerContact` (X4) | Primary first, then the oldest. |
| Fleet | `Customer` (fleet) + `Vehicle.fleetNumber` | A fleet customer is `customerType: Fleet` (custom field "Customer type"); the vehicle's `unit` is its fleet number **[docs]**. The fleet entity behind `customer.fleetId` is archive only **[provisional: S4]**. |
| Vehicle | `Vehicle` | See §5. |
| VehicleOwner | `Vehicle.customerId` | `GET /v3/vehicle/:id/owners` returns `vehicle_owner` rows (`customerId`, `vehicleId`, `createdDate`) with no "current" flag **[docs]**. The most recently created row is the current owner; more than one row warns `vehicle_multiple_owners` **[provisional: S4]**. History is archive only. |
| Canned Service | `LaborPreset` + `LaborPresetItem` + `LaborPresetPart` | Fees inside a canned service become preset items with pricing type `shopFee`. |
| Inventory Part | `InventoryPart` | See §7. |
| Inventory Tire | `InventoryPart` with category `Tires` | The size goes in `description` ("Size …", before the note). The model is only an id (`tireModelId`), kept in the archive. |
| Inventory Labor / Fee | `LaborPreset` (one line each) | Or archive only, at the operator's choice. |
| Inventory Category | `InventoryPart.category` | |
| Vendor | `InventoryPart.supplier*` fields | The vendor entity itself is archive only. |
| Order, `status = Estimate` | `Quote` + `QuotePart` / `QuoteLabor` + `WorkJob` | See §6. |
| Order, `status = RepairOrder \| Invoice` | `ServiceRecord` + lines + `WorkJob` + `ServiceRecordMeta` | See §6. |
| Service (on an order) | `WorkJob` (X2) | Deferred services also create a `VehicleFinding` (§6.4). |
| labors / parts / tires / subcontracts / fees | `ServiceLabor` / `ServicePart` with `lineKind` (X3) | See §6.2. |
| Payment | `Payment` | See §6.5. |
| Authorization | `ServiceRecordMeta.authorizedAt` + archive | `GET /v3/order/:id/authorization`: method, date, note, `authorizedCostCents`, per-service status **[docs]**. Signed documents (`order_signed_invoice`, `order_signed_inspection`) are archive only; fetching their images is **[provisional: S4]**. |
| Order files | `ServiceAttachment` | Downloaded into `uploadsRoot()/<org>/services/`, the same place the upload route writes. Listed as `files[]` (`id`, `fileName`, `fileSize`, `fileType`, `thumbnailUrl`, `url`) on Find Order **[docs]**; downloading `url` (with or without the key) is **[provisional: S4]**. |
| Invoice PDF | `ServiceAttachment` (category `document`, `includeInInvoice: false`, description "Original Shopmonkey invoice") | Keeps the exact historical document. Optional (setting `downloadInvoicePdfs`). |
| Appointment | `Appointment` | Linked to the customer and vehicle. Set `ServiceRecord.startDateTime` when the order references it. |
| Inspection Template | `InspectionTemplate` / `Section` / `Item` | `standard: "custom"`, `country: null`. |
| Inspection | `Inspection` + `InspectionItem` + photos in `imageUrls` | Every Shopmonkey inspection belongs to an order (`orderId` required). Condition values per §8 **[docs]**. Photos are `items[].files[]` on the inspection **[docs]**; downloading them is **[provisional: S7]**. |
| Timesheet, activity `Order` / `Service` / `Labor` | `TimeEntry` (`source: "shopmonkey"`) | `durationMinutes` from `clockIn` and `clockOut`. The source `duration` has no stated unit **[provisional: S8]**, so it's only kept in `SourceRecord`. An entry without `orderId` becomes a shift. |
| Timesheet, activity `General` | `TechnicianShift` (X6) | |
| Message | `SmsMessage` / `EmailMessage` | Phase 2. Archive only until then (always staged, §1). |
| Custom fields (customer, vehicle, order) | `CustomFieldDefinition` + `CustomFieldValue` | Torqvoice entity types are `customer`, `vehicle`, `service_record` and `quote`. Definitions are created on first sight. |
| Labels | `ServiceRecordMeta.labels`; customer and vehicle labels go in a custom field "Labels" | |
| Referral Source | Customer custom field "Referral source" | |
| Statement, Purchase Order, PO lines, Part Return, Inventory Transfer, Labor/Pricing Matrix, Message Template, Role, Brand, Tire Model, TPI Scan, Payment Term/Type config, Workflow | Archive only | Line item assignments are archived too. M4 doesn't read them: their shape isn't in the synthetic fixtures, and a line's technician is its own `technicianId`. Whether assignments name technicians the lines don't is re-checked with a key (B1). |

---

## 4. Customer

| Shopmonkey | Torqvoice | Rule |
| --- | --- | --- |
| `firstName`, `lastName`, `companyName` | `name`, `company` | `name` is the full name, or `companyName` when there's no person. `company` is `companyName` when both exist. |
| `publicId` | `customerNumber` | Only if it's numeric and unique in the org. Otherwise auto-assign the way `createCustomer` does (highest numeric `customerNumber` + 1, starting at 1001; `customerActions.ts:150-160`), after every numeric `publicId` has been placed, so an assigned number can't take one that's still to come. Unique per org (`@@unique([organizationId, customerNumber])`). `publicId` is a string in the schema **[docs]**; whether it's digits in practice is **[provisional: S11]** |
| primary email / phone | `email`, `phone` | The first with a value, primary first, then the oldest. Phones are normalized with the import pipeline's helpers (`src/features/import/Lib/normalize.ts`) and the workshop country code. `Customer.phone` is the number alone (texts go to it); the contact keeps the extension ("+1… ext. 12"). |
| `address1`, `address2`, `city`, `state`, `postalCode`, `country` | `address` | Composed as multiple lines, in the order the invoice prints. The components stay in `SourceRecord`. |
| `note` | `notes` | |
| `taxExempt` (+ gst/hst/pst exempt) | `taxExempt` | `true` if any of them is true. The detail is archive only. |
| primary email's `subscribed` | `reminderOptOut` | Opted out only when the primary email says `subscribed: false` (an explicit unsubscribe). `marketingOptIn` is per email (and deprecated on the customer), defaults to false and is not an opt-out: it's kept on `CustomerContact.marketingOptIn`. Unknown means not opted out **[provisional: S4]**. `preferredContactMethod` is archive only. |
| `customerType = Fleet` | custom field "Customer type" | |
| `customFields`, `labels`, `referralSourceId` | custom fields | |
| `createdDate` | `createdAt` | |
| `deleted = true` | not imported | Kept in `SourceRecord` with `remoteDeletedAt`. |
| — | `userId` | Required by Torqvoice. Use the user who started the import run. |

## 5. Vehicle

| Shopmonkey | Torqvoice | Rule |
| --- | --- | --- |
| `year`, `make`, `model` | `year`, `make`, `model` | Required in Torqvoice. When missing, use `make: "Unknown"`, `model: "Unknown"`, `year: 0`, and warn `vehicle_missing_ymm` so the reconciliation report lists it. Year 0 is hidden by the shared name helper everywhere ("Unknown Unknown"), and the vehicle form asks for a real year on the next save (RESULTS T4). |
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
| `recommendation` | `invoiceNotes` **[provisional: S4]** (whether it prints on Shopmonkey's invoice needs a recorded PDF; if it doesn't, use `diagnosticNotes`) | `notes` |
| `status` + workflow stage | `status`: Invoice → `completed`; RepairOrder → the stage of its mapped `WorkOrderStatus`, or `completed` if `completedDate` is set | `status` (Torqvoice values: `draft`, `sent`, `accepted`, `rejected`, `expired`, `converted`, `changes_requested`): `accepted` if `authorized`; `rejected` if every service was declined; `expired` if `dueDate` has passed; `sent` if `messagedDate` is set; otherwise `draft` |
| `workflowStatusId` | `customStatusId` (+ `customStatusSince` = `workflowStatusDate`) | — |
| `orderCreatedDate` / `createdDate` | `serviceDate` = `repairOrderDate` ?? `orderCreatedDate`; `createdAt` = `createdDate` | `createdAt` |
| `invoicedDate` | `invoiceDate` and `sentAt`. After the record and its lines are written, call `issueInvoice(id, orgId, 'backfill')` from `src/features/invoices/Lib/issueInvoice.ts`. That's the app's own "freeze older invoices" path: it dates `issuedAt` to `sentAt` and freezes what the sheet prints (RESULTS T5: confirmed, PDF checked). The edit lock follows the workshop's lock settings and `sentAt`, exactly as for the app's own invoices. **Before issuing, the loader refuses to run while any connection subscribed to `service.update` is active** (accounting: Xero, QuickBooks, Fiken, Zoho Books; calendars: Google, Microsoft 365, Zoom), because `issueInvoice` notifies them and would push the whole history to them (RESULTS T5) | — |
| `dueDate` / `paymentDueDate` | `invoiceDueDate` | `validUntil` = `dueDate` |
| `mileageIn` / `mileageOut` | `mileage` / `ServiceRecordMeta.mileageOut` | — |
| `customerId`, `vehicleId` | `vehicleId`. Also `customerId` when the order's customer differs from the vehicle's current owner. The app copes; the job's customer wins on the invoice, screens and reports, but the job is also listed in the current owner's portal (RESULTS T3, blocker B10) | `customerId`, `vehicleId` |
| `assignedTechnicianIds` | `technicianId` = first; the rest become `ServiceRecordHelper` | — |
| `serviceWriterId` | `ServiceRecordMeta.serviceWriterName` (the user's name). `serviceWriterUserId` stays null: it holds a local member, and the importer creates no logins | — |
| `purchaseOrderNumber` | `customerReference` | `customerReference` |
| `labels` (an object in the schema **[docs]**; its shape is **[provisional: S4]**, read as label names) | `ServiceRecordMeta.labels` | archive |
| `discountCents`, `discountPercent`, `appliedDiscount*` | `discountType` (`percent` / `fixed`), `discountValue`, `discountAmount` | same |
| `taxCents`, `gstCents`, `pstCents`, `hstCents` | `taxAmount`; `taxComponents` when more than one is non-zero; `taxRate` = the Tax Config rate | same |
| `totalCostCents` | `totalAmount` and `cost` (the spreadsheet importer sets both to the total, `importActions.ts:624-626`; `cost` is the fallback total for records without itemised totals) | `totalAmount` |
| `partsCents + laborCents + tiresCents + subcontractsCents + feesCents (+ epa + shopSupplies)` | `subtotal` = the sum of the stored line totals, checked against these in M6 | same |
| `paid`, `paidCostCents`, `remainingCostCents` | derived from payments (§6.5). Never set `manuallyPaid` | — |
| `deleted = true` | not imported (archive) | not imported |
| `customFields` | custom fields (`service_record`) | custom fields (`quote`) |
| — | `importBatchId` | — |

Bill-to on historical invoices: `issueInvoice(..., 'backfill')` snapshots `record.customer ?? vehicle.customer`
(`issueInvoice.ts:21`), so with `customerId` set as above, the frozen copy and the PDF already show the
order's customer (RESULTS T5). No patching of `issuedData` is needed. Customer and vehicle details are
frozen as they are at import time, which is Shopmonkey's current state, not the state on the invoice
date; the original Shopmonkey PDF (optional, `downloadInvoicePdfs`) keeps the exact historical document.

### 6.2 Lines

Every Shopmonkey service becomes a `WorkJob` (X2), and its lines point to it through `jobId`.
`ordinal` sets the order.

| Shopmonkey line | Torqvoice | Field rules |
| --- | --- | --- |
| `labors[]` | `ServiceLabor`, `lineKind: "labor"` | `description` = name, with the note appended on a new line; `hours`; `rate` = `rateCents/100`; `total` = `round(hours × rateCents × multiplier) − discountCents`, divided by 100. Lines carry **no total of their own** **[docs]**; the formula is **[provisional: S5]** and is checked per service against `calculatedLaborCents`; `technicianId` mapped; `completed`; `costHours`; `costRate`; `discountAmount`; `pricingType: "hourly"` |
| `parts[]` | `ServicePart`, `lineKind: "part"` | `name`, `partNumber`, `quantity`, `unitPrice` = `retailCostCents/100`, `unitCost` = `wholesaleCostCents/100`, `total`, `discountAmount`, `note`, `inventoryPartId` mapped; `sourceExtra`: sku, binLocation, vendorId, reserved, inventoryStatus, purchaseStatus |
| `tires[]` | `ServicePart`, `lineKind: "tire"`, `category: "Tires"` | As parts, named `calculatedName` (else `name`); `sourceExtra`: size, sizeFormat, sku, tireIdentificationNumbers, tireModelId, federalExciseTaxCents, wasteTireFee. Whether FET and the waste fee are inside the line or added on top is **[provisional: S5]** (the synthetic fixtures carry 0) |
| `subcontracts[]` | `ServicePart`, `lineKind: "subcontract"`, `category: "Sublet"` | `quantity` 1, `unitCost` = `costCents/100`, `unitPrice` = `retailCostCents/100`; vendor in `sourceExtra` |
| `fees[]` | `ServiceLabor`, `lineKind: "fee"`, `pricingType: "shopFee"` | `description` = name, `hours` 1, `rate` = `total` = `amountCents/100`. Shopmonkey's `amountCents` is taken whenever the fee carries it, a percent fee's too; only without it is the amount worked out, as `percent` of the fee's `subtotalCents`, else of the service's line base **[provisional: S5]**. `feeType`, `percent`, `amountCents`, `subtotalCents` in `sourceExtra` |
| service `calculatedEpaCents`, `calculatedShopSuppliesCents` | `ServiceLabor`, `lineKind: "epa"` / `"shopSupplies"`, `pricingType: "shopFee"`, one per service where non-zero | They're service fields, not `fee` rows, in the schema **[docs]**. A fee named like EPA or shop supplies on a service that also carries EPA or shop supplies warns `epa_also_fee` **[provisional: S5]**. |
| taxability | `taxable` | The line's own `taxable` (CA: true if any of `taxableGST`/`taxablePST`/`taxableHST` is) **[docs]**. EPA and shop supplies lines take `epaTaxable` / `shopSuppliesTaxable` from the tax config; fees aren't taxed (no flag) **[provisional: S6]**. |

### 6.3 Status of services

`authorizationStatus`, `recommended` and `hidden` go on `WorkJob` as they are. Lines of a service that
was **declined** or **deferred** are still imported, under their job, but they don't count toward the
document's totals: a service counts toward the order's totals unless it's `Declined` or has a `deferredDate`
**[provisional: S5]**. Keep them out of
`subtotal`, with `QuotePart.excluded` / `QuoteLabor.excluded` on quotes.

### 6.4 Deferred and recommended work

A service with `deferredDate` set also creates a `VehicleFinding`:
`description` = service name, `notes` = the service's note plus "Deferred (<deferredReason>)", where `deferredReason` is an enum (`Archived`, `Declined`, `InvoicedNotAuthorized`) **[docs]**, `status: "open"`, `severity: "needs_work"`,
`serviceRecordId` = the order it was deferred on. When a later order revives it (`revivedFromId`),
set `resolvedServiceRecordId` to that later order.

### 6.5 Payments

| Shopmonkey | Torqvoice `Payment` |
| --- | --- |
| `id` | `externalId`, with `provider: "shopmonkey"` (the existing unique `(serviceRecordId, provider, externalId)` makes reruns safe) |
| `amountCents` | `amount`. `transactionType: Refund` → `-abs(amountCents)/100`, `note` starting `Refund`. Shopmonkey's own error PAYM-101beb ("Refunded amount must be a negative value") suggests refunds are stored negative already; `-abs` is right either way **[provisional: S5]**. `chargeId` (the charge it refunds) goes in the note. Totals and balances are right (signed sums everywhere). When a refund brings the order's net paid to zero or below, warn `refund_net_nonpositive`: upstream then shows it unpaid with the full total due (RESULTS T2) |
| `recordedDate` ?? `createdDate` | `date` |
| `paymentType` | `method`: Cash → `cash`; Card → `card`; ACH/Zelle/Interac/Venmo/PayPal → `transfer`; anything else → `other`. The exact type goes in `note` as `"Shopmonkey: <paymentType>"`, plus `checkNumber` and `cardDigits` |
| `note` | appended to `note` |
| `status` ≠ `Succeeded` | not imported (archive) |
| `transactionType` other than `Charge` or `Refund` (a dispute, a transfer) | not imported (archive), warned `payment_type_unsupported` |
| `deposit = true` | imported as a payment on the order; `note` says "Deposit" |
| `refunded`, `refundedAmountCents` on a charge | archive only. The refund itself is its own `transactionType: Refund` row and is imported once, from that row; subtracting `refundedAmountCents` from the charge as well would count it twice **[provisional: S5]** |

Open balances survive: Torqvoice works out paid or unpaid from payments, so an unpaid Shopmonkey invoice
arrives unpaid. This is the main difference from the spreadsheet importer, which marks history as paid.

### 6.6 Fallbacks and warnings (M4)

The transforms never invent data silently: where Torqvoice needs a value Shopmonkey didn't give, they use the
fallback below and return a warning (code in brackets) for the M6 report.

- Customer with no name or company: "Shopmonkey customer <publicId or id>" [`customer_missing_name`]. An email
  that doesn't look like one is kept [`customer_invalid_email`]. A referral source not in the archive is kept by
  its id [`customer_referral_unresolved`].
- Vehicle with no year, make or model: §5's Unknown/Unknown/0 [`vehicle_missing_ymm`]; more than one owner row
  [`vehicle_multiple_owners`]; an owner that wasn't imported [`vehicle_owner_unresolved`].
- Order lines that don't add up to a service's `calculated*Cents`, or an order whose subtotal, discount and tax
  don't give `totalCostCents` [`money_mismatch`, with both numbers]; a fee named like EPA or shop supplies
  [`epa_also_fee`]; a RepairOrder whose workflow status has no stage [`order_status_unmapped`, `in-progress`]; a
  vehicle or customer that wasn't imported [`order_vehicle_unresolved`, `order_customer_unresolved`]; no order date
  at all [`order_missing_date`, the run's date]; an Invoice with no `invoicedDate` is left unissued
  [`invoice_not_issued`]. `invoiceDate`/`sentAt` are set for Invoices only: a RepairOrder carrying an `invoicedDate`
  stays an open work order.
- Payment on an order that isn't a loaded work order [`payment_order_not_loaded`, not imported]; a dispute or a
  transfer [`payment_type_unsupported`, not imported]; no date [`payment_missing_date`, not imported]; refunds that
  bring the net paid to zero or below [`refund_net_nonpositive`].
- Timesheet on an order that isn't a work order: kept as a shift [`timesheet_order_not_loaded`]; with no clock-in or
  an unimported technician: not imported [`timesheet_missing_clock_in`, `timesheet_technician_unresolved`].
- Appointment with no usable end: an hour long [`appointment_end_assumed`]; with no start: not imported
  [`appointment_missing_start`].
- Inspection whose order's vehicle, or whose template, wasn't imported: not imported (Torqvoice needs both)
  [`inspection_vehicle_unresolved`, `inspection_template_unresolved`].
- A percent catalog fee becomes a preset item with rate 0, and a canned service's percent fee one at today's amount
  [`preset_percent_fee`]: a preset holds no percentage.
- A user's colour name maps to hex (`blue` → `#3b82f6`); an unknown one keeps Torqvoice's default.
- Text the transforms write for people ("EPA", "Shop supplies", "Deferred (…)", "Refund of …", "Deposit", the
  payment note's "Shopmonkey: <type>", "check …", "card ending …", "reason: …", "Shopmonkey note", "Shopmonkey
  customer <id>") goes through `TransformContext.label`: M5 passes the workshop's translator
  (`resolveDocumentLocale`, AGENTS "Whose language"; `messages/<locale>/integrations.json` → `shopmonkeyImport`),
  and without one it's English (the snapshots).

## 7. Inventory

| Shopmonkey Inventory Part | `InventoryPart` |
| --- | --- |
| `name`, `number` (else `partNumber`), `note` | `name`, `partNumber`, `description` (the parts fixtures carry `note`, not `description`) |
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
template. Item ratings map to Torqvoice condition values from
`src/features/inspections/Lib/conditions.ts` (both enums **[docs]**):

| Shopmonkey `inspection_item.status` | Torqvoice condition |
| --- | --- |
| `Green` | `pass` |
| `Yellow` | `attention` |
| `Red` | `fail` |
| `NotApplicable` | `not_applicable` |
| `null` (not graded) | `not_inspected` |

Templates import on the `basic` scale (no `dangerous` step: Shopmonkey has three grades). The item's
`message` maps to its notes, and the selected `inspection_item_status_detail` labels are appended to them.
Photos (`items[].files[]`, **[docs]**) are downloaded and stored the way `InspectionItem.imageUrls`
expects; how `url` downloads is **[provisional: S7]**.

## 9. Numbering after import

Imported numbers are kept exactly as they are. After the final import, set
`workshop.invoicePrefix` / `workshop.invoiceStartNumber` (`src/lib/job-number.ts`) so the next job continues
after the highest Shopmonkey number. If Shopmonkey numbers are plain integers, the format is set to `''` (no
`{year}-`) and `workshop.invoiceStartNumber` to the highest imported number + 1. Both are required: an empty
format makes the next number continue after the highest plain number, but **left at `{year}-`, numbering
restarts from the newest job's digits** (spike: imported 1041, 1077, 1050 → next `2026-1051`). Confirmed
in RESULTS T1.

**Proposed, not applied (M5).** Every load works this out from the workshop's highest plain job number
(imported or not: the next number has to clear all of them) and reports it: `workshop.invoicePrefix` → `''`,
and `workshop.invoiceStartNumber` → highest + 1 (only when the format changes, or a different start is set).
The CLI applies it with `--apply-numbering`, and the cutover (§13) as its step 4; the import screen's loads don't
(M8). A dry run proposes the same and writes nothing. Quotes need nothing: a new quote is numbered `QT-` after the newest quote's digits, which no
imported number (unprefixed) can collide with.

### 9.1 Settings a load proposes (M5)

Proposed with every run, applied with `--apply-settings` (written as the run's user and listed in the run's
audit event under `applied`). Only keys whose value would change are listed.

| Setting | From |
| --- | --- |
| `workshop.taxEnabled`, `workshop.defaultTaxRate` | Tax config: `taxPercent`, or the sum of the GST/PST/HST percents |
| `workshop.taxMode`, `workshop.taxComponents` | `split` with one component per non-zero GST/PST/HST when there's more than one, else `single` |
| `workshop.taxSelective`, `workshop.taxAppliesToParts` / `Labor` / `ShopFee` | Selective when parts, labor or shop supplies aren't all taxable; parts from `partTaxable*`, labor from `laborTaxable*`, shop fee from `shopSuppliesTaxable` **[provisional: S6]** |
| `workshop.defaultLaborRate` | The default labor rate (§3) |
| `workshop.unitSystem` | The oldest vehicle's `mileageUnit`: `Mile` → `imperial`, `Kilometer` → `metric` |
| `workshop.timezone` | The location's `timezone`, when it's a valid IANA zone |

`taxInclusive` isn't proposed (Shopmonkey's taxes are added on top). The location's name is reported when it
differs from the workshop's, never applied: renaming the workshop is the operator's, in Settings.

### 9.2 How a load writes (M5)

- **Links.** One `IntegrationLink` per loaded row, written in the record's transaction, `remoteId`
  `<table>:<id>` (a Shopmonkey id is only unique within its table), `checksum` the hash it was loaded from,
  `metadata.createdByRun` on rows the run created. The same mapping is kept on the `SourceRecord`
  (`localEntity`, `localId`, `loadedHash`), which a backup carries and a link doesn't: a load after a restore
  or a reconnect finds the row through it (checked to be the workshop's), writes the link again, and creates
  nothing.
- **Units.** Each record (an order with everything on it) is its own transaction; a failure rolls back that
  record alone, is counted with its error's name (never its message), and the run carries on. A dry run is
  one transaction with a savepoint per record, rolled back at the end. A record's hash covers its source
  payload and the local ids its rows point at (vehicle, customer, technicians, inventory parts, status, work
  order): a dependency created again, or loaded late, re-points what uses it on the next run. An order's hash
  also covers its services, payments, authorizations, owner and stage; an inspection's its photos. Files aren't
  in an order's hash: each is attached once by its own link, checked on every run, so one staged later still
  arrives. Every imported invoice is offered for issuing on every run, so one a past run didn't reach (a crash,
  a failed issue) is issued next time; failures are counted in the summary and the audit event.
- **Changes during the sync window.** An estimate that becomes a repair order is loaded as a work order and its
  quote marked `converted` into it (as the app's own conversion does); one that turns back into an estimate keeps
  its work order (warned `order_back_to_estimate`). A timesheet that moves between a shift and a time entry (its
  order became, or stopped being, a loaded work order) replaces the importer's other row. A row deleted in the app
  is created again on the next load, warned `row_recreated`. The vehicle's Shopmonkey note follows changes (one
  removed in Shopmonkey is left). Estimate files stay in the archive (`order_file`) until the estimate becomes a
  work order, when they're attached to it; the API reaches them meanwhile through `/source-records`.
- **Undo** (`run.ts undo --connection <id> --run <run id>`, by the run id a load prints first) removes what the
  run created and nothing it only matched or updated: customers, vehicles, work orders and inspections by their
  import batch (found by `mapping.shopmonkeyRunId`), by the spreadsheet importer's undo rules; quotes, inventory,
  presets, appointments, templates, time, technicians and statuses by the run's links; findings and attachments
  it added to rows it didn't create; the vehicle notes it wrote; the custom fields it defined (linked) that no
  value uses (converted quotes: see below). A row the workshop uses since is kept with its link, so a later load matches it: a template an inspection made in the
  app uses, a technician with time, helpers, a login or lines outside the run, a status a work order is in, an
  inventory part a line, preset or stock movement of the workshop's names. What's removed loses its links and
  archive mappings, so a later load creates it again; so does any link or mapping of the connection whose row
  is gone (undoing an older run can take a newer run's work order with its vehicle). Each undo records one audit
  event, `shopmonkey.import_undo`, with what it removed and kept (`--user`, a member of the workshop; the
  connection's creator by default). Settings applied with `--apply-*` aren't changed back. Settings → Data lists
  a run's batches but offers no spreadsheet Undo for them (the action refuses it too). After a restore, links are
  rebuilt as matched rather than created and the run's custom field links aren't rebuilt, so undoing a run from
  before the restore removes only its batch rows (customers, vehicles, work orders, inspections).
- **Technicians.** A technician the workshop had (one the operator matched a user to, or re-linked after a
  restore) is never renamed or recoloured from Shopmonkey; only one a run created follows it.
- **Issuing.** The guard against connections that hear `service.update` is checked again just before issuing:
  with one turned on mid-run, nothing is issued (warned `issue_postponed`) and the next run issues them.
- **Vehicle notes after a restore.** A note has no archive record of its own, so with its link gone the
  vehicle's note under the same title is taken to be it and updated, not written a second time. The title is the
  workshop's current language's: a workshop that changed language between a load and a restore gets a second
  note in the new language (the old one stays).
- **Undo and converted quotes.** A quote converted into a work order an undo removes (that run's, or a later
  run's on that run's vehicle) is put back to `accepted` with no pointer, so the app can convert it; the next
  load converts it again while Shopmonkey has the order as a repair order.
- **Guarded since M7/M8:** two loads of one connection at once (the load lock, §13; a dry run takes it too), and a
  second load or cutover queued from the import screen while one is queued or running (refused; a copy of a running
  job the queue starts again after ten minutes leaves it alone). Still so: a dry run holds one transaction for the
  whole run (up to an hour), which can make the app wait on the same unique keys (customer numbers) meanwhile. Each
  committed record also wakes the workshop's open screens once (the realtime extension in `src/lib/db.ts`), so a
  large load is best run outside opening hours.
- **Files.** A placed file is named from the workshop, its record and its content (UUID-shaped, so the file
  manager's sweep looks after it): placing it again, as rewriting a changed inspection does, finds the copy
  already in uploads after the staged copy is gone. A file gone from both places is warned `file_missing`
  and forgotten by the archive (its hash and its parent's children fetch cleared), so the next extract
  downloads it again and the next load attaches it. Imported order files are `includeInInvoice: true`, like
  a file uploaded in the app (they show on the share page); the original invoice PDF is `false`.
- **Words.** What the importer writes itself (the custom fields it makes, `Customer type`/`Fleet`,
  `Labels`, `Referral source`, the original invoice's name and description, the batch name, the stock movement
  notes, and §6.6's words) is in the workshop's language (the part history labels the `import` reason)
  (`resolveDocumentLocale`); a custom field's machine name stays the English label's, so a language change
  doesn't make a second field. The run's time zone and phone country are the workshop's
  (`workshop.defaultCountryCode`, else US).
- **Edits in the app** (task 12). The work order and quote pages rewrite every line on save and send no line
  ids, so the save matches each line to the one it replaces: the same name (parts: name and part number;
  labor: description and pricing), first not yet taken, in order; then a part left over by its part number.
  The matched line keeps its job, kind, technician, completion, cost, discount, note and source fields. A line
  that matches nothing (new, a renamed labor line, a part renamed and renumbered) gets none: a removed line
  plus an added one looks like a rename, and a technician or job moved onto the wrong line is worse than one
  lost. What it came from stays in the archive.

## 10. Known non-1:1 points (tell the client)

- One Shopmonkey location per Torqvoice install, unless you have the white-label license.
- Invoices print lines flat until the job grouping (X2) is drawn on the invoice (milestone M9, optional).
  The grouping is stored and served by the API from day one.
- Vendors, purchase orders, statements, pricing matrices and message history are archive only in this
  phase. They're readable through `/api/v1/source-records` but not shown in the app.
- Login accounts aren't migrated. Staff get invited.
- Refunds arrive as negative payments. Totals and balances are right, but upstream Torqvoice shows a refund
  as a positive "received" row on the work order screen, and an invoice refunded in full as unpaid with its
  whole total due (the share page even offers to take payment again). The reconciliation report lists
  those orders (`refund_net_nonpositive`).
- Jobs a vehicle's previous owner paid for are billed to that owner, but they're also listed in the
  vehicle's current owner's portal (RESULTS T3, blocker B10).
- Customer and vehicle details on imported invoices are frozen as they are in Shopmonkey at import time,
  not as they were on the invoice date.
- **Renaming a labor line, or renaming and renumbering a part, on an imported work order or quote** drops
  that line's job, technician, cost and source fields (§9.2): the page sends no line ids, so a renamed line
  can't be told from a new one. Every other edit keeps them; the originals stay in the archive.

---

## 11. Fields kept in the archive only

Every source field the transforms (M4, `src/integrations/shopmonkey/transform/`) leave out of the Torqvoice
rows, per table and per record nested in one, as their field specs list them (`transform/specs.ts`). `transform/fields.test.ts` fails on a fixture field that is
neither mapped nor listed here, and `transform/mapping-doc.test.ts` fails when this table and the specs disagree.
They stay in `SourceRecord` and are served by `/api/v1/source-records`. Fields read only to find a related record
(`companyId`, `locationId`) are listed too. **[provisional: S4]**: built from the synthetic fixtures, which carry
the fields the importer reads plus a few around them; recorded fixtures will add more.

| Shopmonkey table or nested record | Archive only |
| --- | --- |
| `customer` | `companyId`, `deletedDate`, `deletedReason`, `discountPercent`, `externalId`, `fleetId`, `locationId`, `locationIds`, `metadata`, `preferredContactMethod`, `preferredLanguage`, `updatedDate`, `website` |
| `vehicle` | `companyId`, `deletedDate`, `hin`, `licensePlateCountry`, `locationId`, `locationIds`, `metadata`, `name`, `updatedDate` |
| `user` | `assignedServiceWriter`, `assignedTechnician`, `canTrackTime`, `companyIds`, `customFields`, `laborRateId`, `locationIds`, `phone`, `roleIds`, `updatedDate` |
| `workflow_status` | `archiveWhenInactive`, `archiveWhenPaid`, `companyId`, `daysToArchive`, `inactiveOrderWarningThreshold`, `locationId`, `metadata`, `updatedDate` |
| `order` | `archived`, `companyId`, `deletedDate`, `deletedReason`, `files`, `hasPayments`, `invoiceLockState`, `invoiced`, `locationId`, `metadata`, `paid`, `paidCostCents`, `publicId`, `remainingCostCents`, `taxConfigId`, `updatedDate`, `workflowStatusPosition` |
| `order_service` | `calculatedDiscountPercent`, `calculatedGSTCents`, `calculatedHSTCents`, `calculatedPSTCents`, `categoryId`, `companyId`, `createdDate`, `discountCents`, `discountPercent`, `discountValueType`, `epaCents`, `epaPercent`, `epaValueType`, `excludedFromDeferred`, `gstCents`, `gstPercent`, `gstValueType`, `hideLineItemPricing`, `hstCents`, `hstPercent`, `hstValueType`, `lineItemInventoryStatus`, `lineItemOrder`, `locationId`, `metadata`, `pricing`, `pstCents`, `pstPercent`, `pstValueType`, `revived`, `shopSuppliesApplied`, `shopSuppliesCents`, `shopSuppliesPercent`, `shopSuppliesValueType`, `sourceServiceId`, `taxCents`, `taxPercent`, `taxValueType`, `updatedDate` |
| `payment` | `bulkPaymentId`, `companyId`, `locationId`, `metadata`, `paymentMode`, `provider`, `receiptNumber`, `refunded`, `refundedAmountCents`, `statementId`, `updatedDate` |
| `timesheet` | `companyId`, `createdDate`, `duration`, `flatRate`, `inProgress`, `laborId`, `locationId`, `metadata`, `number`, `rateCents`, `serviceId`, `type`, `updatedDate` |
| `appointment` | `allDay`, `color`, `companyId`, `confirmationStatus`, `locationId`, `metadata`, `origin`, `publicId`, `recurring`, `sendConfirmation`, `sendReminder`, `updatedDate`, `useEmail`, `useSMS` |
| `inventory_part` | `availableQuantity`, `companyId`, `createdDate`, `discountCents`, `federalExciseTaxCents`, `locationId`, `maxCriticalQuantity`, `metadata`, `reservedQuantity`, `sizeFormat`, `taxable`, `tireModelId`, `updatedDate`, `wasteTireFeeCents` |
| `inventory_tire` | `availableQuantity`, `companyId`, `createdDate`, `discountCents`, `federalExciseTaxCents`, `locationId`, `maxCriticalQuantity`, `metadata`, `reservedQuantity`, `sizeFormat`, `taxable`, `tireModelId`, `updatedDate`, `wasteTireFeeCents` |
| `inventory_labor` | `categoryId`, `companyId`, `costHours`, `costRateCents`, `createdDate`, `discountCents`, `discountPercent`, `discountValueType`, `locationId`, `metadata`, `multiplier`, `multiplierType`, `rateId`, `taxable`, `taxableGST`, `taxableHST`, `taxablePST`, `updatedDate` |
| `inventory_fee` | `categoryId`, `companyId`, `costHours`, `costRateCents`, `createdDate`, `discountCents`, `discountPercent`, `discountValueType`, `locationId`, `metadata`, `multiplier`, `multiplierType`, `rateId`, `taxable`, `taxableGST`, `taxableHST`, `taxablePST`, `updatedDate` |
| `canned_service` | `bookable`, `companyId`, `createdDate`, `locationId`, `lumpSum`, `metadata`, `pricing`, `publicId`, `recommended`, `updatedDate` |
| `inspection_template` | `companyId`, `locationId`, `metadata`, `updatedDate` |
| `inspection` | `checklistStage`, `companyId`, `createdById`, `locationId`, `metadata`, `ordinal`, `recommended`, `updatedDate` |
| `company` | `createdDate` |
| `location` | `address1`, `address2`, `archived`, `city`, `companyId`, `country`, `createdDate`, `deleted`, `email`, `latitude`, `locationId`, `longitude`, `metadata`, `phone`, `postalCode`, `state`, `updatedDate`, `website` |
| `tax_config` | `applyServiceDiscountToTaxableItemsFirst`, `companyId`, `createdDate`, `epaPercent`, `hash`, `includeEpaOnLabor`, `includeEpaOnParts`, `laborShopSupplies`, `locationId`, `metadata`, `partShopSupplies`, `priceCalculatorVersion`, `shopSuppliesConfig`, `shopSuppliesMaxCapCents`, `subcontractTaxable`, `updatedDate`, `version` |
| `labor_rate` | `companyId`, `flatRate`, `locationId`, `metadata`, `updatedDate` |
| `vendor` | `accountNumber`, `address1`, `city`, `companyId`, `contactFirstName`, `contactLastName`, `country`, `createdDate`, `deleted`, `locationId`, `metadata`, `postalCode`, `state`, `updatedDate` |
| `inventory_category` | `companyId`, `createdDate`, `deleted`, `locationId`, `metadata`, `parentId`, `parentName`, `updatedDate` |
| `label` | `color`, `companyId`, `createdDate`, `entity`, `locationId`, `metadata`, `saved`, `updatedDate` |
| `referral_source` | `companyId`, `createdDate`, `editable`, `locationId`, `metadata`, `reserved`, `updatedDate` |
| `authorization` | `authorizedCostCents`, `companyId`, `customerId`, `locationId`, `metadata`, `method`, `note`, `serviceAuthorizationReset`, `serviceWriterId`, `services`, `updatedDate` |
| `vehicle_owner` | `companyId`, `metadata`, `updatedDate` |
| `customer.emails[]` | `companyId`, `customerId`, `locationId`, `metadata`, `updatedDate` |
| `customer.phoneNumbers[]` | `companyId`, `country`, `customerId`, `locationId`, `metadata`, `updatedDate` |
| `order_service.labors[]` | `cannedServiceId`, `categoryId`, `companyId`, `completedDate`, `costTotalCents`, `createdDate`, `labels`, `locationId`, `metadata`, `orderId`, `ordinal`, `serviceId`, `showHours`, `showNote`, `updatedDate` |
| `order_service.parts[]` | `cannedServiceId`, `categoryId`, `companyId`, `createdDate`, `discountPercent`, `discountValueType`, `labels`, `locationId`, `metadata`, `orderId`, `ordinal`, `reduceInventoryCount`, `serviceId`, `showCostAndQuantity`, `showNote`, `showPartNumber`, `updatedDate` |
| `order_service.tires[]` | `binLocation`, `cannedServiceId`, `categoryId`, `companyId`, `createdDate`, `discountPercent`, `discountValueType`, `generatedBrandName`, `generatedModelName`, `inventoryStatus`, `labels`, `locationId`, `metadata`, `orderId`, `ordinal`, `purchaseStatus`, `reduceInventoryCount`, `reserved`, `serviceId`, `showNote`, `showPartNumber`, `showPriceAndQuantity`, `updatedDate` |
| `order_service.subcontracts[]` | `cannedServiceId`, `categoryId`, `companyId`, `createdDate`, `discountPercent`, `discountValueType`, `labels`, `locationId`, `metadata`, `orderId`, `ordinal`, `serviceId`, `showNote`, `updatedDate` |
| `order_service.fees[]` | `cannedServiceId`, `categoryId`, `companyId`, `createdDate`, `labels`, `laborId`, `locationId`, `metadata`, `orderId`, `ordinal`, `partId`, `serviceId`, `showNote`, `subcontractId`, `tireId`, `updatedDate` |
| `canned_service.labors[]` | `cannedServiceId`, `note`, `ordinal`, `taxable` |
| `canned_service.parts[]` | `cannedServiceId`, `note`, `ordinal`, `taxable`, `wholesaleCostCents` |
| `canned_service.tires[]` | `cannedServiceId`, `note`, `ordinal`, `taxable`, `wholesaleCostCents` |
| `canned_service.subcontracts[]` | `cannedServiceId`, `costCents`, `note`, `ordinal`, `taxable`, `vendorId` |
| `canned_service.fees[]` | `cannedServiceId`, `ordinal` |
| `inspection_template.items[]` | `createdDate`, `inspectionTemplateId`, `recommendedCannedServiceIds`, `status` |
| `inspection.items[]` | `createdDate`, `inspectionDate`, `inspectionId`, `inspectorUserId`, `publicId`, `recommendedCannedServiceIds`, `reviewStatus` |
| `files[]` | `thumbnailUrl` |

## 12. Reconciliation (M6)

`src/integrations/shopmonkey/reconcile/`, run by `scripts/shopmonkey/run.ts reconcile --connection <id> [--json]`
and kept as the connection's `state.lastReconciliation` (each gate with a `code` and `values` for the import page to
word, and an English `summary` for the command line). It explains; people decide.

**Every staged record lands in exactly one bucket** (`reconcile/tables.ts` `place`), checked in this order:

| Bucket | When |
| --- | --- |
| `loaded` | Its link (`SourceRecord.localEntity/localId`) names a row that exists in the workshop; for a payment, a `Payment` with its `externalId` |
| `missing` | Its link names a row that is gone (deleted in the app): **named, count gate fails** |
| `deleted` | Shopmonkey deleted it (`remoteDeletedAt`, which the extract sets for a payload marked deleted) |
| `failed` | The load's unit for it threw (`loadSkip = failed`) |
| `skipped` | The load left it out, for the reason it wrote on `SourceRecord.loadSkip` (below), or a reason worked out here |
| `archive` | An archive-only table (§3, §11) |
| `settings` | Read whole into settings and fields: `tax_config`, `labor_rate`, `workflow`, `referral_source`, `label` |
| `folded` | Part of a loaded parent's rows: an order's `order_service` (a deferred one is linked to its finding) and `authorization`, a vehicle's `vehicle_owner`, an inspection's photos (`inspection_file`, placed in its items' `imageUrls`). A child of a parent that isn't loaded takes its parent's fate: `deleted` with it, or `skipped` as `parent_not_loaded`; a child whose parent isn't in the archive at all is `unaccounted` |
| `unaccounted` | None of these: **named, count gate fails** |

**Why a record was left out** (`SourceRecord.loadSkip`, written by the load where it decides; cleared when the
record is linked, or for a payment when its row is written): `history` (an order created before `historyFrom`, §1);
a transform's warning code from §6.6 (`payment_type_unsupported`, `payment_missing_date`, `appointment_missing_start`,
`inspection_vehicle_unresolved`, `timesheet_missing_clock_in`, …); `payment_not_succeeded` (§6.5);
`payment_order_not_loaded` (its order isn't a loaded work order: a quote, a skipped or failed order);
`files_not_on_work_order` (a quote's or a skipped order's files); `user_not_referenced` (a Shopmonkey user no order,
timesheet or appointment names, and the operator didn't map); `not_imported` (a transform left it out without a
warning). Worked out in the report, not written: `file_not_staged` (the extract didn't download it,
`_staged.skipped`) and `parent_not_loaded`. A deleted order's payments are `deleted` with it. A payment's reason is written every run, after its order's unit, so an
archive loaded before M6 has them after one more load.

**Money**, in cents, over a cent. Per imported work order: Torqvoice's counted lines (§6.3: not under a Declined or
deferred job) against Shopmonkey's subtotal (§6.1's categories); its stored total against `totalCostCents`; what the
app counts as paid (its payments, or the whole total when marked paid by hand) against `paidCostCents`; its balance
against `remainingCostCents`. Per imported estimate: its total against `totalCostCents`. A difference is
**explained** only by:

| Rule | Explains |
| --- | --- |
| `money_mismatch` (§6.6) | A lines difference on an order the load warned about on `subtotal` (Shopmonkey's own lines and subtotal disagree), while the work order's lines and Shopmonkey's subtotal are both, to the cent, what they were then (`state.lastLoad.mismatchedLines`). A change on either side since is unexplained |
| `payment_type_unsupported`, `payment_missing_date` (§6.5, §6.6) | A paid (and the matching balance) difference that comes, to the cent, to the payments the load left out for those reasons and hasn't imported since |

Anything else is unexplained and fails the money gate: a line changed or broken since the load, a payment added
in the app during the sync window (M7 brings those over), a total edited by hand.

**Invoices** are as the transform has them: an order with `status: Invoice` and an `invoicedDate` (a RepairOrder
carrying an `invoicedDate` stays an open work order, §6.6).

**Gates** (all must pass for cutover):
- counts: no `missing` or `unaccounted`, and the extract read every record Shopmonkey listed in its last whole read
  of each table (a `--since` delta's count is only what changed, and isn't held to it);
- money: no unexplained difference;
- receivables: what the imported invoices still have open equals Shopmonkey's `remainingCostCents` for them, to the
  cent. A balance difference a rule explains still fails it: the shop decides. Open balances on Shopmonkey invoices
  that weren't imported (`historyFrom`, failed) are reported beside it, not compared, and so is the number of
  imported work orders Shopmonkey has deleted since (still in Torqvoice, counted on both sides);
- failures: no order failed to load, in the archive (`loadSkip = failed`) or in the last load (an order whose update
  failed keeps its link: `state.lastLoad.counts.order.failed`).

By month, on the workshop's clock, both sides: invoiced, tax, discounts (by invoice date), payments (by payment date),
and what was open at each month's end. 25 invoices picked at random (seeded) are listed with both totals for a person
to compare. Unmapped fields are read from the 2,000 most recently updated records of each table.

## 13. The sync window and cutover (M7)

Between the backfill and cutover the shop still works in Shopmonkey, and Torqvoice follows it. Nothing is ever
written to Shopmonkey. Code: `src/integrations/shopmonkey/webhook.ts`, `sync/`, `load/edits.ts`, `load/lock.ts`.

**Webhooks** **[provisional: S1]**: Shopmonkey's deliveries are verified per the Standard Webhooks spec (`webhook-id`,
`webhook-timestamp`, `webhook-signature` `v1,<base64>`, HMAC-SHA256 of `id.timestamp.body` with the `whsec_` secret,
several signatures allowed while a secret rotates, five minutes' tolerance either way). The secret is the
connection's `webhookSecret` credential; the endpoint is `/api/integrations/shopmonkey/<connection id>/webhook`. A
delivery is acted on once (its id in `InboundWebhookDelivery`, kept a week, removed with its connection) and only says
which record to read again: its `table` and `data.id`, a payment's `data.orderId` (payments are staged from their
order). It queues a `refetch` job per record (`refetch:<table>:<id>`; a second delivery about the record joins the one
waiting) and answers at once. A table that isn't read by id, or a body without an id, is logged and answered 200.

**Refetch**: the record by id (`/v3/<table>/:id`) and its children, read again whatever its own hash says (a webhook
may be about a service alone); children that no longer come back are marked deleted. A 404 marks the record deleted
(`remoteDeletedAt`) **[provisional: S1]**. Another location's record is left out. The last refetch of a burst loads (one
load for many deliveries).

**Polling** (`sync.delta`, every ten minutes): a delta extract from each table's watermark (the newest `updatedDate`
read, every location's) less five minutes (a table without one: the last run's start less five minutes). Searches
filter by `updatedDate`; the large GET lists (orders, appointments, inspections, messages, purchase orders, scans:
`recentFirst` in `extract/tables.ts`) are read newest first, each page starting ten records back from the last (so up to
ten deletes between two pages skip nothing), and stop at the first page that reaches the delta's start; if a page, or
one page after another, isn't newest first, the list is read whole, with a warning **[provisional: S2]**. Other GET lists
are small and read whole. A load follows when the delta changed anything, or when a refetch staged something no load
has taken yet (`state.syncPending`, kept through a failed load).

**What polling can't see**: a change to a child alone (a vehicle's colour, a payment's note) until its parent changes,
and a record **deleted** in Shopmonkey (a deleted record isn't listed; one Shopmonkey only marks `deleted` is seen when
it is listed again). The webhook covers both, so a workshop that relies on polling alone keeps, after cutover, records
Shopmonkey deleted during the sync window.

**When the sync loads**: only after the operator's first load (`state.lastLoad`), never while another extract runs,
never after cutover. As the member who made the connection (while still a member), with the status and technician
mappings saved on the import screen (`state.mapping`, M8; the defaults for any it doesn't name), as every load uses. Every load holds the connection's load lock (a PostgreSQL session advisory lock on a connection of
its own): a second load is refused (`LoadBusy`), and the sync tries again a minute later (`sync.load`). While a
connection that hears invoices is on (accounting), the sync stages but doesn't load (M5's guard), and says so in the
log. The sync's loads are full loads (unchanged records skipped by their hash); one that wrote nothing records no
audit event. An undo takes the same lock and clears `state.lastLoad`, so the sync stops loading until the operator
loads again (otherwise its next load would create what the undo removed).

**Conflicts**: Shopmonkey wins until cutover. A row is edited in Torqvoice when its `updatedAt` is later than its
link's `lastSyncedAt`. A load syncs the links of exactly the rows it wrote, at the end of the transaction that wrote them
(the rows it touched in passing included: an appointment setting its work order's start, an inspection pointing its
work order at it, an estimate converted, unless that row was edited in Torqvoice, which a write in passing doesn't
overwrite), and the invoices it issued; so an edit made in Torqvoice, even while a load runs, stays an edit. A changed record overwriting an edited row warns `local_edit_overwritten` (in
`state.lastLoad.warnings`).

**Deletes** (after each sync load, `state.lastSync`):

| Shopmonkey deletes | Torqvoice |
| --- | --- |
| A record only in the archive (never loaded, or left out) | Nothing; the archive keeps it, marked deleted. |
| A loaded work order, quote or appointment, unchanged in Torqvoice since its last sync | Deleted, with its `DeletedRecord` tombstone (named after the member the sync loads as), its custom field values and files, and one `shopmonkey.sync_delete` audit event per run; its link and mapping go. A work order puts no stock back: its imported lines never took any (part counts come from Shopmonkey). |
| The same, edited since: the row (`updatedAt` past its link's sync), or anything the workshop added to a work order, told by kind and link, never by time: a status report or equipment, a payment that isn't Shopmonkey's, an attachment or time entry with no import link, a concern beside the complaint's, more jobs than Shopmonkey's services | Kept; listed (`keptDeletes`, reason `edited`). |
| An invoice that is locked | Kept; listed (`locked`). |
| Any other loaded record (customer, vehicle, part, technician, attachment) | Kept; listed (`policy`): removing it would take the history hanging off it (B16). |

**Cutover** (`run.ts cutover --connection <id> --shop-stopped [--dry-run]`, `docs/fork/CUTOVER.md`): the operator's word
that the shop has stopped; the webhook refetches still waiting, a sync run under way finished, then a fresh delta for
every table from where it ended, a load and the delete policy; the reconciliation (§12), stopping at any failing gate;
the numbering proposal (§9) applied; `state.cutover` set; the sync's queued jobs cancelled and its schedule put off for
good (`state.scheduleRuns['sync.delta']` set as late as a date can be); a reminder to delete the webhook in Shopmonkey
and revoke the API key. After cutover a load, an extract (CLI or screen) and the webhook refuse. A dry run goes through
every step and changes nothing in the workshop (its refetches and delta stage, as the sync would, and leave the load
to it).
