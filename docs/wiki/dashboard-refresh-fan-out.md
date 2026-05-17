# Dashboard Refresh button — full sync fan-out

## Symptom

The Dashboard "Refresh" button used to call `/api/sync` which only ran:
- Amazon orders sync (last 30d per store)
- Amazon financial events

So after pressing Refresh, **Walmart 30d, Walmart Returns/Refunds, Health, Procurement counters** in the sidebar and KPI strip would all still read whatever the daily cron last wrote — sometimes 23 hours stale. The "Synced just now" chip in the page header made it look fresh because it just reflected when the browser hit the API, not when the DB last got marketplace data.

## Fix

`POST /api/sync` (job=all) now also fans out to the cron-only routes via self-fetch with `Authorization: Bearer ${CRON_SECRET}`:

| Cron route | What it refreshes |
|---|---|
| `/api/cron/walmart` | Walmart orders, returns, adjustments, shipment monitor, perf snapshots |
| `/api/cron/account-health-amazon` | Amazon Reports API metrics (Late Shipment, Order Defect, etc.) |
| `/api/cron/account-health-walmart` | Walmart Insights API performance + item compliance |
| `/api/cron/procurement-priority` | Procurement priority detection + Telegram alerts |

Each runs independently via `Promise.allSettled` — a failure in one doesn't stop the others. Outcomes are echoed back in the `results` field of the POST response.

`maxDuration = 300` is set on the route so Vercel's 60s default doesn't cut the function off mid-fan-out.

## "Synced just now" chip

`syncedAt` returned by `GET /api/dashboard/summary` now reads from the most recent successful `SyncLog.completedAt` instead of `new Date()`. The header chip now honestly says "Synced 4h ago" when the DB hasn't been refreshed, so stale dashboards are obvious.

## Required env

`CRON_SECRET` must be set on the Vercel project. Without it, fan-out skips with a clear error in `results.cronFanOut.error` and only Amazon orders + finances get refreshed (the legacy `/api/sync` behaviour).
