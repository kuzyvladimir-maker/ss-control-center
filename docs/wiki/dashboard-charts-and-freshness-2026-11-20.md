# Dashboard: charts, freshness, CS fallback (2026-11-20)

Owner request (topic 8, 20.11 10:05 ET). Commits `bf9b51d75`, `3232a6f84`.

## Fixed

| Problem | Cause | Fix |
|---|---|---|
| "Updated 1h ago" on every open | Page awaited `/api/sync/quick` with a 9 s cap; the sync takes 11–15 s on prod, so the cap always fired. Summary is stale-while-revalidate (up to 10 min) and was never re-read after the sync landed | Quick sync runs in parallel with the tiles (28 s cap). When it lands, the page re-reads `/api/dashboard/summary?fresh=1` (forces a rebuild, `fresh` is not part of the cache key) and bumps the sales cards + charts. Debounce raised 45 → 60 s |
| Cases open = "Unknown" | `screenInbox()` blanks metrics once the screen check is stale | Summary reads the raw `cs_seller_screen_v1` setting and returns `customerService.lastKnown` (last verified count, threads, failure reason). Tile/queue show it labelled "As of … · not current". Never presented as live |
| Sales today -82% | Partial today vs full yesterday | Compared with yesterday up to the same wall-clock time (`yesterdaySameTime`) |
| Russian string in Customer queue | Hard-coded | English; dashboard builds its own English CS notices instead of using `queueView().reason` (CS lane owns that file) |

## Charts (`/api/dashboard/charts`, `src/components/dashboard/DashboardCharts.tsx`)

- Sales by day, 7/30/90 toggle, previous period of equal length as dashed grey line.
- Orders by hour, cumulative, today vs yesterday.
- Sparklines: Sales today (14 full days), MTD (running total), Forecast (5 full months, bars), Frozen at risk (medium+ per week), Adjustments 30d (charged per week).
- Same store selection and cancelled rule as `/api/dashboard/sales`. No rows → empty state with reason.

## Trap: local dev writes to prod SyncLog

Opening the Dashboard on a local `next dev` with `.env` (prod Turso) fires
`/api/sync/quick` with the LOCAL store1 LWA secret, which is outdated → an
`error` row in prod `SyncLog` → prod banner "Amazon orders sync failing".
Happened once during this verification; superseded by a prod quick sync at
15:23 UTC. Don't open the Dashboard locally against prod DB, or refresh the
local LWA secret first.
