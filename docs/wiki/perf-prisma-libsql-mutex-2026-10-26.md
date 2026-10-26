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

## 15:10 ET: /shipping 504 again — the summary count, fixed without the index

The owner saw `HTTP 504` on `/shipping` with every counter at 0.

**Measured 15:13–15:16 ET.** `/api/shipping/dashboard` took 142 s and 196 s.
Its own stages were small (`db_stores` 48 ms, `veeqo_orders` 293 ms, probe
0 ms), and each of its DB queries is an index seek of 50–65 ms (EXPLAIN on
Turso). The rest was queueing.

The sidebar polls `/api/dashboard/summary` every 60 s from every open tab.
That fires ~25 queries in one synchronous slice, so they all land on one pool
client. Among them, the "bought today" count scanned the whole 150k-row
`ShippingPlanItem` table:

| Query | Time on Turso |
|---|---|
| full scan | 70–87 s |
| previous run | logged `aborted due to timeout` at 30 s |

The scan held its client the whole time, and `/shipping`'s 50 ms queries
queued behind it.

**Fix without a schema change (bd1ad6449).** Every bought row carries a
tracking number (bought rows with `trackingNumber IS NULL`: 0), and
`ShippingPlanItem_trackingNumber_idx` already exists. Adding
`trackingNumber > ''` moves the planner to `SEARCH … USING INDEX
ShippingPlanItem_trackingNumber_idx (trackingNumber>?)`. The count drops to
~0.1 s warm, with 16 s once on a cold cache during the incident. drive-backfill
got the same filter.

| Call (prod) | Before (15:13) | After (15:29–15:30) |
|---|---|---|
| /api/shipping/dashboard | 142 / 196 s | 0.52–0.65 s |
| /api/dashboard/summary | 500 at 30–31 s | 200, 0.75 s warm (23 s once, cold) |
| plan, all ready orders | — | 4.3–8.5 s |
| plan, 2 orders | — | 0.5–2.2 s |
| pending / alerts | 0.18–1.9 s | 0.18–0.25 s |

The `(status, updatedAt)` index is still not applied. The owner gave a go at
15:28, but the local Claude Code guard refuses production schema changes.
It is no longer needed for speed. The lesson stands: on this table any filter
without an indexed column is a 70 s scan while Turso is degraded.

### Same session: Veeqo 502 on /procurement (c85843cc4)

There was one occurrence in 3 h, at 14:01:42 ET. Two "Bought" clicks on two
lines of order 2221739393 came 1.5 s apart. Both read the order's notes and
appended a rewritten `[PROCUREMENT]` block in parallel, and the second got
Veeqo's gateway 502. The 502 was an HTML page, which ended up in the red
banner. This was not our rate limit, which Veeqo answers with 429.

What changed:

- The error text drops HTML pages (`Veeqo API error 502: Veeqo is temporarily
  unavailable, try again`) and caps other bodies at 500 characters.
- GET backoff is 0.5 / 1.5 / 4.5 s.
- The notes PUT appends, so it is never blindly re-sent. After a 5xx it
  re-reads the order and re-sends only when the latest block doesn't already
  hold the desired state.
- The card's error banner has a "Try again" button.
- Actions on lines of one order are queued client-side.

### Same session: NAN "Buy label" grey (e4dfdb47a)

In Shopify mode the button only opens Shopify admin, yet it was gated by the
Veeqo plan. Whenever the page's plan failed (the 504 above) or hadn't loaded,
it was grey. It is now gated by a fresh Shopify rate snapshot
(`NAN_RATES_STALE_MIN` = 30). When it can't be bought, the card says why: no
snapshot, refresh in flight, or stale with the capture time.

## 15:30–16:05 ET: the remaining 10+ s (Jackie measured 16.3 s)

All stages are now marked in `Server-Timing` (f19634756, 3f9101541):
`/api/shipping/dashboard` per DB stage, `/api/dashboard/summary` per batch.

**/shipping list (`/api/shipping/dashboard`).** It takes 0.5–1.7 s. The
outliers were Veeqo's own order list once at 8.4 s, and DB stages queued
behind the summary (next point).

**Summary.** Its ~29 reads ran in one `Promise.all`, which is one slice, so
they all landed on one pool client. Several of them are full scans:

| Read | Cold time |
|---|---|
| `WalmartPerformanceSnapshot` | 6.5 s |
| `FrozenRiskAlert` | 5.4 s |
| `SyncLog` | 3.9 s |
| `ShippingAdjustment` | 1.9–3.7 s |
| "bought today" via the trackingNumber index | 29 s cold (0.1 s warm) |

"Bought today" is slow cold because it still fetches ~2.5k fat rows to check
`status`/`updatedAt`. Serially the summary took 25–65 s cold and held that
client the whole time.

Fix (9ce15a7e4):

- `prismaReports` is a separate set of 4 clients, rotated per property access
  so independent reads spread.
- The summary is stale-while-revalidate per instance: fresh 30 s, max stale
  10 min, single-flight rebuild via `after()`.

Locally a cold build took 13.8 s instead of 34–65 s, and a repeat 1 ms. The
`(status, updatedAt)` index would make "bought today" index-only. It is still
not applied: the guard refused it again.

**Plan (prices).** It took 11–15 s with 17 ready orders: 5 concurrent orders,
one Veeqo quote each. Two changes:

- 7 of the 17 were NAN in Shopify mode. The page no longer asks Veeqo for
  them (50492f53a).
- With 10 orders it is still 8.4–13.7 s. Veeqo's rate quote alone takes
  1.9–4.5 s per order right now, measured one order at a time.

Concurrency stays 5. Veeqo answered 429 fifty times between 08:00 and 10:00
ET, and each order also PUTs its package (not retried). The quote POST is now
retried on 429/5xx like a GET (`readOnlyPost`, a42324cf3); nothing else that
POSTs is.
