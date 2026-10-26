# /shipping slowness: one Prisma client meant one DB lock (2026-10-26)

**Symptom.**
- /shipping hung on "Fetching orders from Veeqo…".
- `/api/shipping/dashboard` and `/api/dashboard/summary` hit the 300 s
  function limit.
- Even trivial endpoints took between 0.3 s and 165 s. For example,
  `/api/shipping/nan-rates/pending` reads one small table.

**Measured before the fix.**
- In the dashboard, `SELECT stores` (about 40 ms when run directly on Turso)
  took **39 s**. Veeqo took 0.45 s. The total was 199 s.
- `/pending` and `/api/alerts/unacknowledged` took 165 s.
- Turso queried directly from the iMac took 39–58 ms. The database was fine.

**Root cause.** `@prisma/adapter-libsql` runs every query of a client through
**one mutex**: both `performIO` and `startTransaction` acquire the same lock.
The app used one global client per function instance. A Vercel instance
serves many requests at once, so every query of every request queued behind
every other one. That included:
- the 7 s SkuShippingData pull;
- the plan's per-order queries;
- alert polling;
- crons.

The weather engine and class resolution added more per-order queries on
2026-10-25/26, which made the queue noticeably longer.

**Fix.** `src/lib/prisma.ts` now creates a pool of 4 clients
(`PRISMA_POOL_SIZE`, at most 8), each with its own lock. A client is chosen
once per **synchronous slice** of code and rotated on the next microtask.

Array transactions such as `prisma.$transaction([prisma.a.update(), …])` are
built inline, so the whole array lands on one client and stays atomic. This
was verified with a forced unique-violation rollback. Interactive transactions
use their own `tx` client and are not affected.

**Also added.**
- Timeouts on the weather and geocoding fetches (5–6 s).
- An in-memory ZIP cache.
- Bounds on the date loops so an invalid date cannot spin forever.
- Stage timings: `Server-Timing` on the dashboard and `timing` in the plan
  response.

**After the fix.**

| Call | Result |
|---|---|
| dashboard | 0.5–2 s |
| `/pending` and alerts | 0.18–0.4 s, including while a 30-order plan is running |
| plan, 30 orders | 31 s total; Veeqo quotes dominate |

The dashboard occasionally spikes to 18–32 s when a new instance cold-starts
under load. The SkuShippingData full read still takes about 7 s on Turso
itself; it is cached per instance.

## Follow-up, 2026-10-26 midday: the regression and the real culprit

**Regression (12:2x ET).** Even with the pool:

| Call | Measured |
|---|---|
| dashboard | 31–127 s (`db_stores` alone 30.8 s) |
| `/pending` | up to 134 s |
| alerts | up to 52 s |
| plan | 56–65 s, of which `db_sku_database` was 39–41 s |

**Culprit.** The plan pulled the whole SkuShippingData table (5,957 rows).
On a cold instance that took about 40 s, and it held its pool client's adapter
mutex for the whole pull. Every query from any request that rotated onto that
client waited behind it. The plan only ever reads the first-line SKU of each
order. **Fix:** `fetchSkuRows(skus)` does a keyed `IN` query, about 50 ms on
production (commit 34e59ce21). `fetchSkuDatabase()` is still used by the
`/api/sku` page.

**Tried and reverted: `concurrentLibSql`.** This wrapper made plain queries
lock-free and kept the mutex only around transactions (commit e5c108a04).

- Locally it worked.
- On production, under concurrent page polling plus a plan, the libsql client
  on an instance got stuck. Every later `/api/shipping/plan` on that instance
  hung before its first Veeqo call and hit the 300 s limit (12:47–12:58 ET).
- Reverted in b21499a56.

Was the wrapper really the cause? Probably not. See the next section: Turso
had a live incident at the same time.

## Real root cause: Turso us-east-1 incident + WebSocket transport (13:00–13:45 ET)

After the revert, the first loaded plan **still** hung 279 s, so the wrapper
wasn't it.

**Turso status.** "Elevated timeouts in us-east-1" (our region), opened
16:18 UTC = 12:18 ET, status *investigating*. Reproduced locally against
production:

| Operation | Result during the incident |
|---|---|
| Plain SELECT | about 0.2 s |
| Single-statement write | 0.05 s (no-op UPDATE, then insert + delete of a probe draft) |
| Any transaction (interactive, array, nested create, even a read-only `batch`) | hangs indefinitely |
| WebSocket transport (`libsql://` → `wss`) | at times even a plain SELECT hung |

Any hung call holds its pool client's adapter mutex. With no deadline, that
client was wedged for good.

**Fix (commit 702fce660).**

- **Transport.** `src/lib/prisma.ts` rewrites `libsql://` to `https://`.
  HTTP sends one request per statement or stream step, which is what Turso
  recommends for serverless.
- **Deadline.** A custom `fetch` with `AbortSignal.timeout` (30 s, set by
  `TURSO_FETCH_TIMEOUT_MS`). libsql passes in a cross-fetch Request, so
  `tursoFetch` rebuilds it for the platform fetch. A dead call now fails and
  frees the client instead of wedging it.
- **Plan save.** The plan saves its draft as single-statement inserts (plan
  row, then each item) instead of one nested create, which runs as a
  transaction. Zero `startTransaction` calls, verified with a spy.
- **Not touched.** `/api/shipping/buy` has no transactions (a read plus
  single `update`s), so buying is unaffected.

**After (13:42–13:45 ET, three rounds, plan for 10 orders and 2 orders run
side by side with page polling).**

| Call | Result |
|---|---|
| plan, 10 orders | 7.9 / 8.0 / 7.7 s, no hangs (was 56–65 s, then 279 s) |
| plan, 2 orders | 1.1 / 0.6 / 3.6 s |
| dashboard | 0.4–0.8 s typically |

Dashboard spikes still reached 30–60 s, multiples of the 30 s deadline.
Another client was being held by a slow query: see the next section.

## Pending: index on ShippingPlanItem(status, updatedAt)

Every `/shipping` refresh writes a draft plan, so `ShippingPlanItem` holds
150,670 rows across 4,806 plans; only 2,526 are bought.

"Bought today" in `/api/dashboard/summary`, drive-backfill and package
history filter by `status` with no index. That is a full scan: 20 s locally,
and past the 30 s deadline in production (logged
`shippingPlanItem.count … aborted due to timeout`).

- Schema `@@index([status, updatedAt])` is added.
- Migration: `node --env-file=.env scripts/turso-migrate-shipping-plan-item-status-index.mjs`.
  It is a single idempotent `CREATE INDEX IF NOT EXISTS`, not a batch.
- **Not yet applied to Turso.** Applying a production schema change needs the
  owner's word.

Old draft plans (never bought) could also be pruned. That would be an
irreversible delete, so it is only a proposal.
