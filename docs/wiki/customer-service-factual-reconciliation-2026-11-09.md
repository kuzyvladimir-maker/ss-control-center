# Customer Service: factual reconciliation (2026-11-09)

Owner request: Telegram topic 42, 09 November. Repeated decision digests included answered Dee, Scott and Russell orders.

## Findings

Direct production MCP was available without connector-forge. All five incoming messages for the three orders were already SENT; Dee's latest card was SENT, Scott's and Russell's cards were SUPERSEDED. `cs_open_threads` nevertheless returned Dee and Scott from the 06 November scan with `stale=true`. The reminder prompt permitted displaying stale rows. The VPS scan bridge was stopped, and its HTTP response write could terminate the process when a caller disconnected.

## Implementation

- `inbox-watch.ts` returns no decision rows when the observation is stale (existing 60-minute freshness limit, stricter than the requested two hours). It excludes answered messages and terminal cards. Other inbox summaries use the same filtered decisions.
- Full, exact-account paginated scans still reconcile absent orders; their live cards become SENT with scan provenance. BuyerMessage remains RESOLVED when absence proves closure but does not prove an actual send time. No invented response timestamp.
- `scan-inbox.js` reads the latest seller reply in Response Needed threads. Only replies after the latest buyer message close older incoming messages. `answered.ts` retires live cards and cancels queued work transactionally; a claimed SEND is not overwritten.
- `POST /api/customer-hub/manual-close`: authenticated direct API, store 1/order/time/screenshot. Stores screenshot bytes and SHA-256 in a `Setting cs_manual_close:*` audit, closes earlier incoming messages and their cards, cancels queued tasks. Same proof is idempotent; future timestamps, missing screenshots and in-flight SEND are rejected. No marketplace send occurs.
- `GET /api/customer-hub/open-threads`: authenticated direct API for the digest, no connector-forge.
- `ops/customer-service/manual-close.py`, installed as `/root/.openclaw/workspace/scripts/cs_manual_close.py`: `python3 …/cs_manual_close.py --order 111-4672452-6889854 --sent-at 2026-11-08T15:35:59Z --screenshot /root/.openclaw/workspace/media/cs_send_111-4672452-6889854_20261108.png`.
- `ops/customer-service/digest.py`, installed as `scripts/cs_digest.py`: deterministic filtering; stale/error emits one inability-to-verify line, fresh empty inbox emits NO_REPLY. Existing `cs-open-reminder` cron runs this script and relays its output, keeping its schedule.
- Existing half-hour scanner recovers a stopped Windows `SalutemCsScanBridge` task and explicitly reconciles after completing a scan. Bridge tolerates disconnected HTTP callers. Telegram listener is unchanged.

## Checks

Customer Service regression tests include answered/terminal/stale digest exclusion, manual closure validation, screenshot audit, idempotence, queued-task cancellation, claimed-SEND protection, and excluding newer buyer messages. Python digest regression covers the three named cases and stale timestamps. Scanner tests cover pagination, account binding and incomplete scans.

Operational proof is stored outside git in `ss-control-center/data/cs-reconcile-20261109/`. Production verification and deployment results are recorded below after completion.
