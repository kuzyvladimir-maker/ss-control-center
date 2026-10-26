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
