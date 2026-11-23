# A2: Domain service extraction

**Goal:** move each domain's write logic out of its server actions into a service function that both the
action and the API call. The actions' names, inputs and results stay exactly as they are, so open
browser tabs and upstream merges aren't affected.

## Why
Today the logic lives inside the server actions (for example `createCustomer` in
`src/features/customers/Actions/customerActions.ts`: limits, validation, custom fields, numbering, then
the write). The API must not copy that logic, or the two will drift.

## Read first
- `AGENTS.md` ("Server actions", "Action names are an API", "Four things an action may also need")
- `src/lib/with-auth.ts`, `src/lib/audit.ts`
- Each domain's `Actions/` files before touching them

## Pattern
```ts
// src/features/customers/Lib/customerService.server.ts
export type ServiceCtx = { organizationId: string; userId: string; actor: 'user' | 'api' }

export async function createCustomerService(ctx: ServiceCtx, input: CreateCustomerInput) {
  // the exact body that was inside the action, unchanged in behaviour
}

// src/features/customers/Actions/customerActions.ts: same export, same input, same result
export async function createCustomer(input: unknown) {
  return withAuth(async (ctx) => createCustomerService(
    { organizationId: ctx.organizationId, userId: ctx.userId, actor: 'user' },
    createCustomerSchema.parse(input)), { audit: /* unchanged */ })
}
```
The API route calls `createCustomerService` and then `logAudit` with the **same event** the action's
`audit` option produces. Put the event builder next to the service (`customerAuditEvents.ts`), so both
callers use one definition. Deletes also write `DeletedRecord`.

## Order (one PR per domain, each green on its own)
1. customers (+ custom fields). Contacts (X4) have no action to extract: their service is written with
   their endpoints in A4 (`/customers/{id}/contacts`).
2. vehicles (+ notes)
3. service records: create draft, update header, lines (add, update, remove), status changes. Jobs (X2)
   have no action to extract: their service is written with their endpoints in A4.
4. payments (including the invoice issuing they trigger)
5. quotes (+ convert to job, via `src/features/quotes/Lib/copyQuoteToJob.ts`)
6. appointments
7. technicians, time entries (reuse `src/features/time-tracking/Lib/timeEntries.ts`), shifts (X6)
8. inventory (+ stock adjust), labor presets
9. findings
10. webhooks (subscription management)

## Acceptance (per domain PR)
- [ ] Existing Vitest and Playwright tests for that domain pass without changes to their expectations.
- [ ] A new test calls the service directly and asserts the same rows and audit event as the action.
- [ ] The diff to the `Actions/` file is the move only: no behaviour change, and the same exports.

## Out of scope
New behaviour. If a bug turns up while moving code, note it in the PR and fix it in a separate PR.
