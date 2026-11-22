# A6: Hardening

**Goal:** confidence to put the API in front of a client's integration.

## Tasks
1. Playwright: `e2e/specs/public-api.spec.ts` creates a key in Settings, calls create customer → create work order → add lines → record payment over HTTP, then checks the UI shows it and the webhook delivery log has the events.
2. Contract tests: generate requests from `openapi.json` for every endpoint (property-based, e.g. with `fast-check`), and assert responses validate and nothing returns 500.
3. Isolation sweep: one test that seeds two workshops and hits every route with workshop A's key and workshop B's ids. Everything is 404.
4. Load check: 20 requests per second against list endpoints on 50,000 work orders for 2 minutes. p95 under 500 ms; add indexes where needed.
5. Security review, written up in `docs/fork/SECURITY-REVIEW.md`: key storage, timing-safe compares, SSRF on webhook URLs (the existing `src/features/webhooks/Lib/ssrf.ts`), upload limits, error messages leaking internals, logs free of PII and keys, dependency audit.
6. `docs/fork/API-GUIDE.md`: a short guide for BlueLabel's developers (auth, paging, sync loop with `updatedSince` + webhooks + `/deleted`, idempotency, errors), with curl examples.
7. **API keys' service users on the Team page** (from A1): each key's service user is an `OrganizationMember`,
   so it is listed on Settings → Team and counted by `memberSeats` (`src/features/team/Lib/memberSeats.ts`).
   Self-hosted installs have every seat, so nothing is refused, but the list is confusing. Label them as API
   keys on the Team page (their role stays editable there: that is how a key's scope is managed) and leave
   them out of the seat count, each with a `// fork:` filter on `apiKey: null`.

## Acceptance
- [ ] All of the above pass in CI, and the review lists no open high-severity findings.
