# M2: Shopmonkey connector and client

**Goal:** a `shopmonkey` connector a workshop can connect with an API key, with an HTTP client that is
read-only, paces itself, and logs safely.

## Read first
- `CONTRIBUTING.md` (connector rules), `src/integrations/registry.ts`
- `src/features/integrations/Lib/types.ts` (`ConnectorManifest`, `ConnectorServer`, `ConnectorContext`, `JobHandler`)
- `src/features/integrations/Lib/http.ts`, `jobs.ts`, `connections.ts`, `vault.ts`
- An existing connector with jobs and a webhook: `src/integrations/xero/` (`manifest.ts`, `server.ts`, `webhook.ts`)
- `docs/fork/spikes/RESULTS.md` (S1–S3)

## Tasks
1. `src/integrations/shopmonkey/manifest.ts`: id `shopmonkey`, category `other`, `countries: 'global'`,
   `selfHostedOnly: true`, auth with one password-type credential `apiKey`. Settings:
   - `locationId` (remote-select from the locations endpoint)
   - `includeFiles` (boolean, default true)
   - `downloadInvoicePdfs` (select: none / last 2 years / all)
   - `includeMessages` (boolean, default false)
   - `historyFrom` (date, optional)

   Add the logo at `public/images/integrations/shopmonkey.svg`. Use a plain generic icon, **not**
   Shopmonkey's logo.
2. `src/integrations/shopmonkey/client.ts`, built on the connector `http`:
   - Allows only `GET` and an explicit allowlist of `POST .../search` paths. Anything else throws before
     any network call. Test this.
   - Paces itself: reads `X-RateLimit-Remaining-Minute` and `X-RateLimit-Limit-Minute`, slows down below
     10% remaining, honours `Retry-After` on 429, and retries 5xx with jittered backoff (the connector
     `shouldRetry` hook).
   - Pages with `limit` / `skip` through an async iterator over `meta.hasMore`, plus a `where` builder
     using the syntax confirmed in S2.
   - Logs method, path, status, duration and `x-request-id`. Never query values that could hold PII,
     never response bodies.
3. `src/integrations/shopmonkey/money.ts`: `centsToAmount(cents: number | null | undefined): number`,
   rounded to 2 decimals, with tests on edge values.
4. `server.ts`: `test()` calls the key status endpoint; `identify()` returns the company name and id;
   `remoteOptions.locations`; `jobs: {}` for now. Register it in `registry.ts`.

## Acceptance
- [ ] Connecting with a valid key shows the company name. A bad key shows Shopmonkey's message.
- [ ] Unit tests: the method allowlist, 429 with `Retry-After`, slowing down at low remaining, paging to the end, and redacted logs.
- [ ] The registry test passes.

## Out of scope
Extracting data (M3).
