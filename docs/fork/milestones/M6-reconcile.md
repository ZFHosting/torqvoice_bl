# M6: Reconcile

**Goal:** a report that proves the import is complete and correct, and blocks cutover when it isn't.

## Read first
- `docs/fork/MAPPING.md`, M4's warnings model, M5's loaders

## Tasks
1. `src/integrations/shopmonkey/reconcile/engine.ts` builds a `ReconciliationReport` from `SourceRecord`,
   `IntegrationLink` and the app tables. It contains:
   - **Counts** per Shopmonkey table: total on Shopmonkey (`meta.total` captured at extract), staged,
     loaded, archive-only, skipped. Skips are broken down by reason (deleted, failed with error, filtered
     by `historyFrom`, other location). Every staged record must land in exactly one bucket.
   - **Money, per order:** Shopmonkey total vs Torqvoice `totalAmount`, Shopmonkey paid vs the sum of
     payments, Shopmonkey remaining vs the Torqvoice balance. List every difference over $0.01.
   - **Money, in aggregate by month:** invoiced, tax, discounts, payments, and open receivables at the
     end of each month, on both sides.
   - **Spot checks:** 25 random invoices, with Shopmonkey number, Torqvoice link and both totals side by
     side, for a person to open and compare.
   - **Warnings:** M4 and M5 warnings grouped by code with counts, plus the first 20 examples of each.
   - **Unmapped fields:** source keys seen and not mapped, with how often they're non-empty, so a field
     that matters and isn't in `MAPPING.md` gets noticed.
2. **Gates** (all must pass for cutover): counts fully accounted for; zero unexplained money differences;
   open receivables equal to the cent; no failed orders. Explained differences come from a rule listed in
   `MAPPING.md` and referenced by code.
3. Output: stored as JSON in the connection's `state.lastReconciliation`, rendered in M8, and printed by
   `scripts/shopmonkey/run.ts reconcile --connection <id> [--json]`.

## Acceptance
- [ ] On the fixture set, all gates pass.
- [ ] Deliberately corrupting one line total in the database makes the money gate fail and name the order.
- [ ] Deleting one imported customer makes the count gate fail and name it.
- [ ] The report runs in under a minute on 50,000 orders (test with generated data and `npm run test:db`).

## Out of scope
Fixing differences automatically. The report explains; people decide.
