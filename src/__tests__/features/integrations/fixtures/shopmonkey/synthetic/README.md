# SYNTHETIC Shopmonkey fixtures

**These are invented, not recorded.** No Shopmonkey API key was available in M0 (blocker B1 in
`docs/fork/PROGRESS.md`), so this folder holds fixtures built from Shopmonkey's published table schemas
(`https://shopmonkey.dev/schema/<Table>`) with made-up values. Field names and enums are Shopmonkey's;
the shapes of API responses (nesting, envelopes) are our reading of the docs.

Regenerate with `npx tsx scripts/shopmonkey/build-synthetic-fixtures.ts`. Don't edit the JSON by hand:
the money is generated from the lines under one provisional formula, so hand edits break it.

Every code path that depends on something these fixtures assume carries a `PROVISIONAL(M0:Sx)` comment
and is listed under "Re-verify with real Shopmonkey data" in `docs/fork/PROGRESS.md`. When a key is
available, record real fixtures (`scripts/shopmonkey/spike.ts`, then `anonymize-fixtures.ts`, which
writes `../recorded/`), run the importer's tests against them, and delete this folder.

## File format

One file per Shopmonkey table: `{ table, source: "synthetic", synthetic: true, endpoint, total, records }`.
Recorded fixtures use the same format with `source: "recorded"` and `anonymized: true`.

## What's in it

| Case | Where |
| --- | --- |
| Estimate, sent, not authorized | order `1001` |
| Repair order in a workflow status, two technicians, service writer, PO number, EPA, a recommended service not yet authorized | order `1002` |
| **Complex invoice:** four services, line discount, fixed and percent fees, shop supplies, four tires, a sublet, a declined and deferred service, cash deposit, card payment, partial refund, failed charge, inspection with a photo, timesheet | order `1003` |
| Invoice billed to the vehicle's **previous owner**, order-level percent discount, paid by check and **refunded in full**, vehicle with no year/make/model | order `1004` |
| Deleted order (archived, never loaded) | order `1005` |
| Person, fleet company with contact, deleted customer, company-only customer with a non-numeric `publicId` | `customer.json` |
| Several emails and phones per customer, marketing opt-in on one | `email.json`, `phone_number.json` |
| Vehicle with two owners over time | `vehicle_owner.json` (`syn_veh_3`) |
| Shifts (`General`), one still open, and a labor timesheet | `timesheet.json` |

## Conventions

- Ids start with `syn_`. VINs start with `TVFX`. Emails are `@example.test`. Phones are `+1202555 01xx`.
- Money is integer cents. A line's total is its gross (hours × rate × multiplier, or quantity × retail)
  minus its `discountCents`; services carry `calculated*Cents` and `totalCents`; orders carry the
  per-category cents of the services that count (not declined, not deferred), `discountCents`,
  `taxCents` and `totalCostCents`. PROVISIONAL(M0:S5).
