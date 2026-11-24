# Load check: the public API's lists (A6)

The question (A6 task 4): with 50,000 work orders in a workshop, do the API's list endpoints hold 20 requests a second
for two minutes with a p95 under 500 ms?

**Yes: p95 91 ms, p99 128 ms over 2,400 requests, every one answered 200.** No index was needed.

## How it ran (2026-11-24)

- **Data:** a local database made for it (`torqvoice_fork_load`, migrated with `prisma migrate dev`), seeded by
  `scripts/load-check/seed.ts`. One workshop with 5,000 customers, 10,000 vehicles, 50,000 work orders over three
  years, 20,000 payments, and twelve full-access keys (so 20 requests a second stay under each key's 120 a minute).
  SYNTHETIC data.
- **Server:** the production build (`next build`, `next start`) on the developer machine (Windows 11, Postgres 16 in
  Docker on the same machine), one process, background jobs off.
- **Load:** `scripts/load-check/run.ts`, open loop (one request every 50 ms whether or not the last one answered),
  rotating twelve list requests a syncing client and a dashboard would make, for 120 seconds, after a short warm-up
  (the first requests after a start compile routes and fill caches: a cold 10-second run's p95 was 1.4 s).

| Request | n | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: |
| `/work-orders?limit=50` | 200 | 81 | 107 | 156 |
| `/work-orders?limit=200` | 200 | 73 | 102 | 140 |
| `/work-orders?status=completed&limit=50` | 200 | 66 | 94 | 180 |
| `/work-orders?updatedSince=…&limit=100` | 200 | 51 | 73 | 163 |
| `/work-orders?cursor=…` (the next page) | 200 | 61 | 83 | 118 |
| `/work-orders?openOnly=true&limit=50` | 200 | 59 | 80 | 117 |
| `/work-orders?include=lines,payments&limit=20` | 200 | 82 | 112 | 151 |
| `/customers?limit=50` | 200 | 20 | 27 | 42 |
| `/customers?q=…&limit=50` | 200 | 26 | 40 | 64 |
| `/vehicles?limit=50` | 200 | 24 | 33 | 42 |
| `/payments?limit=50` | 200 | 63 | 83 | 105 |
| `/quotes?limit=50` | 200 | 16 | 20 | 27 |
| **All** | **2,400** | **58** | **91** | **128** |

## Running it again

Only against a local server and a database made for it (`seed.ts` refuses a database on any other host, or one
without test, e2e or load as a word of its name, `scripts/load-check/guard.ts`; `run.ts` refuses anything but
`127.0.0.1` or `localhost`):

```bash
createdb torqvoice_fork_load && DATABASE_URL=postgresql://…/torqvoice_fork_load npx prisma migrate dev
DATABASE_URL=postgresql://…/torqvoice_fork_load LOAD_KEYS_FILE=/tmp/load-keys.json \
  npx tsx --import ./scripts/shopmonkey/register.mjs scripts/load-check/seed.ts
npm run build && DATABASE_URL=postgresql://…/torqvoice_fork_load npx next start --port 3101
LOAD_BASE_URL=http://127.0.0.1:3101 LOAD_KEYS_FILE=/tmp/load-keys.json npx tsx scripts/load-check/run.ts
```

`LOAD_RPS` and `LOAD_SECONDS` change the rate and the length. It exits 1 when the p95 is over 500 ms or any request
didn't answer 200.
