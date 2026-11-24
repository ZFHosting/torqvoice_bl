# Security review: the public API (A6)

A review of the fork's public REST API (`src/features/public-api/`, `src/app/api/v1/<resource>`) and what it touches
(webhooks, uploads, the Shopmonkey archive), before it is put in front of a client's integration. Done 2026-11-24 on
`fork/A6-hardening`, by reading the code, running the tests named below, and `npm audit`.

Severity is for this system as deployed (self-hosted, one container behind a reverse proxy): **high** means an
outsider or another workshop can read or change data, or take the service down cheaply; **medium** needs a valid key,
a misconfiguration, or a rare race; **low** is defence in depth.

**Open high-severity findings: none.**

## Findings

| # | Area | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| 1 | Key storage | Only an HMAC-SHA256 of the whole key is stored, peppered with `API_KEY_PEPPER` (or a value derived from `BETTER_AUTH_SECRET` under its own label); the key is shown once. `keys.server.ts`. | — | Sound |
| 2 | Timing | The key check compares hashes with `timingSafeEqual` after a length check (`keys.server.ts`); webhook signatures are compared the same way (`webhooks/Lib/sign.ts`). | — | Sound |
| 3 | SSRF | Webhook URLs are checked when saved and again when delivered (`webhooks/Lib/ssrf.ts`, `webhookService.server.ts`, `deliver.ts`), so a name that resolves elsewhere later is caught; redirects are not followed (`redirect: 'manual'`). | — | Sound |
| 4 | Tenancy | Every query is scoped by the key's workshop, lookups by id included; another workshop's id answers exactly like one that doesn't exist (404). Proven per endpoint (A3, A4 tests) and by one sweep over every route (`public-api-isolation.db.test.ts`). | — | Sound |
| 5 | Logs | A failed request logged the whole error object, and so did a failed idempotent store; a service's message or a Prisma error's meta can quote what was sent. | Medium | **Fixed**: both log the method, path, the error's class and code only (`withPublicApi.ts`, `idempotency.ts`). No log in the API prints a key, a body or a header. |
| 6 | Errors | A 500 answers `server_error` and a fixed sentence; a 400 lists the request's own fields and messages (zod); nothing internal reaches the client. | — | Sound |
| 7 | Uploads | An upload without a `Content-Length` was read whole before its size was checked, and Next's body limit is 2 GB (`next.config.ts`). A key could hold that much memory per request. | Medium | **Fixed**: read as it arrives and stopped past its limit (`writeRoute.ts`, `readBounded`, tested with an endless stream). Types are checked by their first bytes; stored names are the server's. |
| 8 | IP allowlist | Compared as exact strings: `::ffff:203.0.113.7` didn't match `203.0.113.7`, nor `2001:DB8::1` match `2001:db8::1`. | Low | **Fixed**: both sides in one spelling (`Lib/ipAddress.ts`, tested). |
| 9 | Client address | The allowlist and the failed-authentication block (30 a minute, before any key lookup) read `X-Real-IP` (or `CF-Connecting-IP` when trusted), as upstream's rate limiter does. Only a proxy that overwrites it makes it trustworthy; the shipped `docker-compose.yml` publishes port 3000 directly, where a caller can send any `X-Real-IP`: to get past an allowlist, or to spend another address's failures and lock a valid key out. | Medium | **Documented**, not changed: Next's route handlers don't expose the socket address, so there is nothing safer to fall back to without upstream's limiter changing too. API.md §2 and the API keys screen say a proxy must overwrite `X-Real-IP`; a deployment behind one (the documented production setup) is not affected. |
| 10 | Key lifetime | A key outlives the admin who made it: it belongs to the workshop, so an integration doesn't stop when a member leaves. | Low | **Accepted**: owners and admins see every key in Settings → API keys and revoke it there (at once); a key's scope is its role. |
| 11 | Rate limit | 120 requests a minute per key, in process. Several app instances would each allow 120. | Low | **Accepted** for the single-container deployment; note it before scaling out. |
| 12 | CORS | No CORS headers: browsers can't call the API from another origin with a key. | — | Sound (server-to-server only). |
| 13 | Idempotency | Stored answers are scoped by workshop and key; a different body under the same key is a 409. What it can't promise is in API-GUIDE.md (a retry after 5 minutes when storing the answer failed runs the write again). The purge test deleted every expired row in the shared test database. | Low | **Fixed** (the test ages only its own row and purges at the real time). The limits are documented. |
| 14 | Webhook payloads | A fork event's `data` is the API's serialized resource, read scoped by workshop only once a webhook subscribes (`eventHook.ts`); one that can't be read goes as its id. Signed as upstream's are. | — | Sound |
| 15 | Archive access | `/source-records` and `include=source` hand out the source's raw payload (which can hold more than a resource shows); both need `read:settings`. | — | Sound |
| 16 | Dependencies | `npm audit --omit=dev`: 3 high, 3 moderate, all upstream's: `effect` (ReDoS in a schema's template-literal regex) through `prisma` → `@prisma/config`, and `minimatch` through `archiver` → `readdir-glob`. Neither is reachable with request data: Prisma's config parses the install's own `prisma.config.ts`, and `archiver` globs the server's own backup paths. | Low | **Accepted**, upstream's to bump; re-run `npm audit` after each upstream merge. |

## How to check

```bash
npx vitest run src/__tests__/features/public-api            # ip-address, read-bounded, dispatcher-fork, …
E2E_DATABASE_URL=postgresql://…/torqvoice_fork_test npm run test:db   # tenancy, idempotency, isolation sweep
npm audit --omit=dev
```
