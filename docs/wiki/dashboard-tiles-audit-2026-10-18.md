# Dashboard tiles audit — 2026-10-18

Owner report (Telegram topic 8): several Dashboard tiles always read 0, and
"Awaiting ship 72" disagreed with the Shipping Labels page (46).

## Root causes found

| Tile | Showed | Why | Fix |
|---|---|---|---|
| Awaiting ship | 72 (real 46) | Counted `AmazonOrder.status = Unshipped` in our DB. The 2-hourly `/api/cron/orders-amazon` pulled orders **created** in the last 3 days, so an order shipped >3 days after purchase never got its new status. Last full 30-day sync: 2026-09-25. | Tile reads the live `/api/shipping/dashboard` count (same as the sidebar badge and the Shipping page). Cron now uses `LastUpdatedAfter` (`syncOrders(i, 3, "updated")`). One-off backfill of store1 cleared 20 stale rows. |
| Health issues | 0 | No `AccountHealthSnapshot` since 2026-06-30. The 07:00 cron requested the report and polled for ~6s; Amazon needs ~30s; nobody polled again and the next day's run expired the job (~370 expired jobs). Also SP-API 403 for store2/3/5 since ~Oct 6–8 (store2: "LWA secret token expired"). | New `/api/cron/account-health-amazon-poll` every 15 min 07:00–10:45 UTC; job expiry 30 min → 6 h. Verified: fresh store1 report done in 30s. Tile shows "Stale · since …" when the snapshot is older than 2 days. |
| Frozen 30d | 0 | `FrozenIncident` table is empty — rows are only created manually. | Tile is now "Frozen at risk": pending `FrozenRiskAlert` (medium+) for ship dates today or later, from the nightly weather-risk cron; low-risk count as a chip. |
| Cases open / A-to-Z | 3 / 15 | All-time open `CsCase` (April, Walmart) and claims parked in `EVIDENCE_GATHERED` since 2026-04-12. | Cases = open CsCase + unanswered BuyerMessage, last 30 days, live channels only. A-to-Z active = in-flight AND opened in last 60 days. |
| Customer queue | Walmart msgs 70d old | Store filter was bypassed for "All stores", and the Walmart store is inactive. | Always filter by channel; drop messages older than 30 days. |
| Orders 30d sub-text | "S1 516 · S2 0" | Hard-coded S1/S2. | Lists every store with orders (S1 516 · S3 84). |

## New: "Data feeds need attention" banner

`/api/dashboard/summary` returns `dataIssues[]`: SP-API 403 per store (from
the latest `ReportSyncJob` errors), stores with no new orders for >3 days,
stale Account Health, and a Customer Hub inbox with no Amazon message for >7
days. A dead source is now visible instead of reading as 0.

## Still open (outside code)

- Store2/3/5 SP-API 403: the owner must renew the LWA client secret / re-authorize in Developer Central. Until then store3 orders and sales stop at 2026-10-07.
- Customer Hub has ingested no Amazon buyer message since 2026-05-30 — a separate investigation.
- Local `.env` VEEQO_API_KEY is rejected (401); prod key works.

## Round 2 — every element vs its target page (same day)

| Element | Leads to | Source | Was | Now |
|---|---|---|---|---|
| 5 sales cards | /analytics?period=… | AmazonOrder+WalmartOrder, ET, non-cancelled | Page ignored `?period=`, opened on Last 30 days; failed load = endless skeleton | Page reads `?period=` (forecast→MTD); error shown. Sales Overview still includes cancelled + Veeqo eBay/TikTok/Shopify, so totals legitimately differ (documented, not changed). |
| Awaiting ship | /shipping | Veeqo live (`/api/shipping/dashboard`) | DB count | Same as page + sidebar |
| "N shipped today" chip, Shipping progress | /shipping | was Amazon status=Shipped | Not labels | `ShippingPlanItem` bought today (ET) = labels bought via Shipping Labels; panel clickable |
| To buy | /procurement | `fetchProcurementCards` distinct orders | Match | Match (no change) |
| Cases open | /customer-hub | `src/lib/customer-hub/live-counts.ts` | Tile, hub card and badge used 3 definitions | One definition = hub "Unread messages" (live channels). Hub stats now exclude the inactive Walmart store too. |
| A-to-Z chip | /customer-hub | same helper | Counted chargebacks too; hub all-time | `claimType A_TO_Z`, in-flight, ≤60 days — both hub and tile |
| Sidebar Customer hub badge | /customer-hub | summary `customerHub.attention` | open cases | = hub headline "N items need your attention" |
| Health issues | /account-health | latest snapshot per active store | `take:10`, done-only, no store filter | Same query as the page hero; "deactivated" chip |
| Frozen at risk | /frozen-analytics | `FrozenRiskAlert` pending, ship date ≥ today | Page included past-dated alerts | Alerts API `upcoming=1`; page badge = tile value |
| Adjustments 30d | /adjustments?period=30d | dispute-board "Charged", Amazon board accounts, by charge date | createdAt-netted sum the page never showed | Same as board "30 days"; page reads `?period=` |
| Sidebar Adjustments badge | /adjustments | `/api/adjustments/autopilot` fileable (15-min poll) | 182 "unreviewed" — no such bucket on the page | = "Очередь споров" ready-to-file count |
| Awaiting fulfilment table | /shipping?q=<order> | Veeqo | Unsorted, rows not clickable | Sorted by ship-by (dispatch_date first); each row opens the order in Shipping (`?q=` pre-fills search) |
| Customer queue | /customer-hub?message=<id> | BuyerMessage NEW+ANALYZED, oldest first | NEW only; store/order fields never rendered (wrong names); rows not clickable | Fixed fields; each row opens that message |
| Refresh | POST /api/sync | — | Result swallowed; SyncLog "done" even if all stores failed | Result/failed steps shown under the header; SyncLog "error" when no store synced |
| "Generate plan" | /shipping | — | Misleading — no such action | Renamed "Open shipping" |
| Synced Xh ago | — | SyncLog | Any job (Walmart poll, heartbeats) | Amazon orders feed only (`orders-amazon` cron now writes SyncLog) |

Not changed: summary runs the full `fetchProcurementCards` (live Veeqo + SP-API) on every call and the sidebar polls it every 60 s — a cost risk worth a cached count later.
