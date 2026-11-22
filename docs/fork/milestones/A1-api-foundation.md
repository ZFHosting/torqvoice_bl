# A1: API foundation

**Goal:** API keys with scoped service users, a request wrapper that every public endpoint uses, the
shared conventions (paging, idempotency, ETags, errors), and a generated OpenAPI document. Ship one
read-only endpoint (`GET /api/v1/settings`) end to end, to prove the stack.

## Read first
- `docs/fork/API.md` (all of it)
- `src/lib/with-api-auth.ts` (the shape to mirror; reuse `apiOk`, `apiError`, `documentLockedResponse`)
- `src/lib/rate-limit.ts`, `src/lib/permissions.ts`, `src/lib/auth.ts` (bearer plugin, so you know what *not* to collide with)
- `prisma/schema/organization.prisma` (`OrganizationMember.role`, `roleId`), `prisma/schema/auth.prisma`
- `src/lib/features.ts` (the `api` plan flag)

## Tasks
1. `src/features/public-api/Lib/keys.server.ts`:
   - `createApiKey({ organizationId, name, roleId, createdById, expiresAt?, ipAllowlist? })`. In one
     transaction it creates the service `User` (`name: "API: <name>"`, email `api+<cuid>@invalid.local`,
     no `Account`), the `OrganizationMember` with the chosen custom role, and the `ApiKey` row. It returns
     the plaintext key once, formatted `tvk_<8-char prefix>_<32 bytes base64url>`.
   - `verifyApiKey(token)`: parse the prefix, find by prefix, compare HMAC with `timingSafeEqual`, and
     reject revoked, expired or IP-disallowed keys. It updates `lastUsedAt` at most once a minute.
   - `revokeApiKey(id)`: sets `revokedAt` and removes the service user's membership.
2. `withPublicApi(request, handler, { requiredPermissions?, rateLimit? })` in `Lib/withPublicApi.ts`:
   - Accepts only `tvk_` bearer tokens.
   - Gives the handler `{ organizationId, userId (service user), apiKeyId, permissions }`.
   - Checks permissions with `hasAllPermissions`.
   - Applies a per-key rate limit. Extend `rateLimit` with a key option, or wrap its store; read
     `src/lib/rate-limit.ts` before deciding.
   - Refuses with `forbidden` when the workshop's `getFeatures(...).api` is false.
   - Answers with the `apiError` shapes.
3. `Lib/pagination.ts`: the cursor is base64url of `{ u: updatedAt ISO, i: id }`. `pageArgs(query)`
   returns Prisma `where` / `orderBy` / `take: limit + 1`. `pageMeta(rows)` returns `nextCursor` and `hasMore`.
4. `Lib/idempotency.ts` (stores and replays responses for POST with `Idempotency-Key`), `Lib/etag.ts`
   (ETag from `updatedAt`, `If-Match` check). Add a cron in `src/lib/cron/` that purges idempotency rows
   older than 24 h, registered the way the other cron tasks are.
5. `Lib/openapi.ts`: collects every resource's zod schemas from `Schema/*` and builds an OpenAPI 3.1
   document with `z.toJSONSchema`. `GET /api/v1/openapi.json` serves it, unauthenticated and cached.
6. **Settings → API keys** page (`src/app/(authenticated)/settings/api-keys/page.tsx`): list keys
   (name, prefix, role, created, last used), create (pick a role, show the key once with a copy button),
   revoke. Owner/admin only, with server actions in `Actions/apiKeyActions.ts` using `withAuth` and
   `audit`. Add the page to the settings nav with `gate: 'api'`, like the webhooks page.
7. `GET /api/v1/settings` (currency, time zone, tax setup, default labor rate, numbering format), with
   schema, serializer, route and tests, as the pattern for A3.

## Acceptance
- [ ] Tests: a valid key; a revoked key gets 401; an expired key gets 401; a disallowed IP gets 403; a missing permission gets 403; the rate limit gets 429 with `Retry-After`; a key from workshop A can't see workshop B.
- [ ] The plaintext key isn't stored or logged anywhere (grep the test logs).
- [ ] `openapi.json` validates (add `@apidevtools/swagger-parser` or similar as a devDependency in a test).
- [ ] Revoking a key in the UI takes effect on the next request.

## Out of scope
Resource endpoints beyond `/settings` (A3, A4).
