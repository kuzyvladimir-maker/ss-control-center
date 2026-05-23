# 🚀 Phase 2.5 — Distribution

> **Started:** 2026-05-20 · **Status:** Shipped (Stage 7 — Amazon SP-API PUT + Walmart MP_ITEM_4.7 feed + DRY-RUN safety + status poller)
> **Spec:** continuation of Phase 2.4 — picks up `ChannelSKU.validation_status='PASSED'`

---

## TL;DR

**This is the first stage that actually writes to marketplaces.** Until this stage the pipeline lives entirely on internal DB + R2; from here on, Amazon and Walmart see real PUT/POST calls.

* **Amazon** — `PUT /listings/2021-08-01/items/{sellerId}/{sku}` with the constructed listing payload. Optional `?mode=VALIDATION_PREVIEW` query param for a server-side dry-run that never publishes. PUT is idempotent (same payload to same SKU = same submission_id on retry).
* **Walmart** — Items API feed submission, `feedType=MP_ITEM_4.7` (MP_ITEM_FEED family).
* **DRY RUN is default** — `apply: false` is the default; the API route only writes for real when the query param is `dryRun=false` (anything else, including absent, is treated as dry-run).
* **Status poller** — Amazon `GET /listings/.../issues` + Walmart feed status. Background-cron-friendly route lets n8n keep PENDING/SUBMITTED rows progressing toward LIVE / FAILED.

## Pipeline shape

```
PASSED ChannelSKU rows  →  /publish endpoint (dryRun=false to actually submit)
   ↓ runDistribution({ apply, draftId|skuIds })
   ↓ resolve channel → SP-API credentials via account-map.ts
   ↓ filter out STORE5 RETAILER (US suspended, refresh_token revoked)
   ↓ filter out STORE4 SIRIUS  (no SP-API app yet)
   ↓ for each remaining SKU:
   ↓   amazon-publish.ts or walmart-publish.ts builds + sends payload
   ↓   sleep SLEEP_MS_AMAZON (250 ms) / SLEEP_MS_WALMART (170 ms) per call
   ↓   record listing_status, submission_id, distribution_errors
   ↓   sendSuccessAlert / sendFailureAlert (Telegram)
   ↓   running error_rate > maxErrorRate (default 0.10) → abort batch
   ↓ poll-pending cron route reads SUBMITTED rows, walks them to LIVE/FAILED
```

## Module surface

```
src/lib/bundle-factory/distribution/
├── account-map.ts             ← channel → SP-API store credentials
│                                STORE5 (RETAILER) marked suspended 2026-05-17;
│                                STORE4 (SIRIUS) marked no-app
├── amazon-publish.ts          ← PUT /listings/2021-08-01/items/{sellerId}/{sku}
│                                supports mode=VALIDATION_PREVIEW
│                                PUT is idempotent (per Amazon docs)
├── walmart-publish.ts         ← feedType=MP_ITEM_4.7 submission
├── status-poller.ts           ← Amazon GET issues + Walmart feed status
└── distribution-pipeline.ts   ← orchestrator: rate limits, error budget,
                                  Telegram alerts, run summary
```

## API surface

| Method + URL | Purpose |
|---|---|
| `POST /api/bundle-factory/drafts/[id]/publish` | Submit every PASSED ChannelSKU in the draft. Query `dryRun=false` to actually write. |
| `POST /api/bundle-factory/skus/[id]/publish` | Single-SKU submit (useful for retry after partial-batch failure). |
| `POST /api/bundle-factory/skus/[id]/poll-status` | Force a status check now (Amazon issues / Walmart feed). |
| `GET  /api/bundle-factory/drafts/[id]/distribution-status` | Read-only roll-up across all SKUs in the draft. |
| `POST /api/bundle-factory/distribution/poll-pending` | Cron-friendly: walks SUBMITTED rows toward LIVE / FAILED. |

## DB schema additions

`ChannelSKU` gains 5 columns for distribution:

* `listing_status` (text) — `PENDING | SUBMITTED | LIVE | FAILED`
* `submission_id` (text) — Amazon submissionId or Walmart feedId
* `published_at` (datetime) — when LIVE was confirmed
* `distribution_errors` (text, JSON) — array of error objects from the marketplace
* `distribution_attempt_count` (int)
* `last_status_check_at` (datetime) — last poller pass against this SKU

State machine:
```
PENDING → SUBMITTED → LIVE
                   ↘ FAILED  ← (issues found in poller)
```

## Safety mechanisms

1. **DRY RUN by default.** Operator must explicitly pass `?dryRun=false` on the POST. Anything other than literal `"false"` (including absent) is treated as dry-run.
2. **VALIDATION_PREVIEW (Amazon).** First call optionally goes with `?mode=VALIDATION_PREVIEW`, which makes the SP-API server validate the payload without publishing. Available as a per-call flag in `amazon-publish.ts`.
3. **Per-marketplace rate limits.** Amazon throttles at ~5 req/sec — code sleeps `SLEEP_MS_AMAZON=250` ms between calls (= 4 req/sec, conservative). Walmart is configured at `SLEEP_MS_WALMART=170` ms (~6 req/sec).
4. **Auto-abort on error budget.** Running `error_rate > maxErrorRate` (default 0.10 = 10%) inside the batch aborts the remaining submissions. Prevents one bad payload from torching the whole draft.
5. **Suspended-store blocklist.** `account-map.ts` short-circuits STORE5 (US suspended 2026-05-17; refresh_token revoked) and STORE4 (no SP-API app yet). The pipeline silently skips these channels.
6. **Idempotent re-runs.** Amazon PUT means re-sending the same payload to the same SKU returns the same submission_id; safe to retry without creating duplicates.

## Telegram alerts

`distribution-pipeline.ts` calls:

* `sendSuccessAlert(sku, marketplace, listingUrl)` when a SKU flips to LIVE.
* `sendFailureAlert(sku, marketplace, errorPayload)` on terminal failure.

Routed through the same Telegram channel that handles Critical Alerts. Useful so Vladimir doesn't have to babysit the UI during a big batch.

## What this phase does NOT do

* No A+ Content / EBC submission — only the base listing.
* No image upload to Amazon (gallery beyond main) — main image is referenced via R2 URL in the listing payload; Amazon CDN-pulls.
* No Walmart Quality Score / SEO post-publish steps.
* No automatic relisting / inventory replenishment — Veeqo + Phase 2.7+ owns that.
* No multi-region — US marketplace only (`ATVPDKIKX0DER` for Amazon).

## Operator runbook — first real publish

1. From the draft detail page (validation_status=PASSED for every SKU), click **Dry run publish**. Watch the per-SKU result panel — expect green "validation_preview ok" badges across the board.
2. If clean, click **Publish for real**. Confirm modal pops up listing every channel + SKU that will be written. Vladimir's only manual gate.
3. Watch Telegram for `sendSuccessAlert` pings.
4. After ~5–30 min, the cron job (`/poll-pending`) walks SUBMITTED rows to LIVE. The `last_status_check_at` field shows when each row was last touched.
5. **On batch abort** — read the abort reason from the run summary. Common: Amazon validation error on the same field across all channels (e.g. country_of_origin missing) — fix the source draft + re-validate, don't retry distribution.

## Vladimir's to-do list after merge

1. **n8n cron** — wire a 5-min cron pointing at `POST /api/bundle-factory/distribution/poll-pending`. The route returns the count of rows transitioned per call.
2. **Telegram channel** — should already work (same channel as Critical Alerts).
3. **First publish should be a single-SKU dry-run** — pick the simplest draft, dry-run it, inspect the constructed payload in `distribution_errors` (it'll be there even on success as `validation_preview_response`), then go for real.
4. **STORE4 SIRIUS unlock** — to add SIRIUS to the publish blast, Vladimir needs to create a SP-API developer app for that account and add credentials to `account-map.ts`.
5. **STORE5 RETAILER** — US listing on this account is suspended (2026-05-17). Even after suspension lifts, the LWA refresh_token has been revoked; reauthorize before re-enabling.
