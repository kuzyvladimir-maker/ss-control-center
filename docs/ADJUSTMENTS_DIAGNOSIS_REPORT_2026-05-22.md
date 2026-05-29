# Adjustments Module — Diagnosis Report

**Date:** 2026-05-22
**Auditor:** Claude Code
**Scope:** Read-only audit of `/adjustments` and supporting code, DB, env, SP-API integration. No fixes applied.

---

## 1. EXECUTIVE SUMMARY

The Adjustments page is wired end-to-end at the surface level (page → API routes → Prisma models → DB) and the SP-API auth + transport layer works. **The reason every counter shows `0` is that the Amazon adjustment parser filters on three `AdjustmentType` values (`ShippingChargeback`, `CarrierAdjustment`, `WeightAdjustment`) that do not exist in real Amazon Finances v0 responses** — the actual API returns 100+ events per store per week with types like `PostageBilling_PostageAdjustment`, `PostageBilling_Postage`, `PostageBilling_Insurance`, etc. None of these match the filter, so `parseAdjustments` returns `[]` on every scan and nothing is persisted.

Five secondary issues compound this:

1. The Adjustments page does NOT have a Sync button, Upload CSV button, or store/date-range filter — the only mutation entrypoint is the manual `POST /api/adjustments` for hand-creation; the sync route `/api/adjustments/scan` exists but is never invoked from the UI.
2. The sidebar badge "15" next to Adjustments comes from `AtozzClaim.count(active)`, not from `ShippingAdjustment.count()` — wrong field wired in [SidebarContent.tsx:77](../ss-control-center/src/components/layout/SidebarContent.tsx#L77).
3. Walmart sync route exists (`/api/adjustments/walmart/sync`) but is also not wired into the UI.
4. `store2` (Personal) returns SP-API `403 Unauthorized` — banned account confirmed.
5. Even with the type filter fixed, `PostageBilling_*` events do **not** carry `AdjustmentItemList`, so linking an adjustment back to a specific order/SKU requires either a per-order Finances API call or a different correlation strategy.

**No code changes were made.** The temporary diagnostic scripts are listed in §10 for cleanup.

---

## 2. CODE INVENTORY

### 2.1 Files present

| Path | Size | Last modified | Notes |
|---|---|---|---|
| `src/app/adjustments/page.tsx` | 7.2 KB | 2026-05-12 | Client component, no Sync/Upload buttons |
| `src/components/adjustments/AdjustmentsTable.tsx` | 15.6 KB | 2026-05-04 | Desktop + mobile rendering, embedded channel/days filter |
| `src/components/adjustments/SkuIssuesPanel.tsx` | 5.8 KB | 2026-05-04 | SKU-aggregation table |
| `src/app/api/adjustments/route.ts` | 5.2 KB | — | `GET` list + `POST` manual-create |
| `src/app/api/adjustments/[id]/route.ts` | 1.4 KB | — | `GET` one + `PATCH` reviewed/notes |
| `src/app/api/adjustments/scan/route.ts` | 2.6 KB | — | `POST` — calls `getFinancialEvents` per store, runs `parseAdjustments`, inserts |
| `src/app/api/adjustments/stats/route.ts` | 1.7 KB | — | `GET` — KPI aggregations |
| `src/app/api/adjustments/sku-profiles/route.ts` | 0.3 KB | — | `GET` SKU-profiles list |
| `src/app/api/adjustments/walmart/sync/route.ts` | 4.1 KB | — | `POST` — walks recon report dates, persists `WalmartReconTransaction` |
| `src/lib/amazon-sp-api/finances.ts` | 2.5 KB | 2026-04-08 | `getFinancialEvents` + `parseAdjustments` |
| `src/lib/walmart/reports.ts` | 4.3 KB | 2026-04-18 | `WalmartReportsApi` — getAvailableReconReportDates / getFullReconReport |

### 2.2 Files missing (vs. the prompt's expected layout)

| Expected path | Status |
|---|---|
| `src/app/adjustments/layout.tsx` | Missing — not strictly required |
| `src/app/api/adjustments/sync/route.ts` | Missing — replaced by `scan/route.ts` |
| `src/app/api/adjustments/summary/route.ts` | Missing — replaced by `stats/route.ts` |
| `src/app/api/adjustments/sku-analysis/route.ts` | Missing — replaced by `sku-profiles/route.ts` |
| `src/app/api/adjustments/upload/route.ts` | **Missing** — no CSV upload endpoint at all |
| `src/lib/adjustments/` (whole directory) | Missing — no sync.ts, no transaction-parser.ts |

The actual code follows a slightly different naming convention than the prompt assumed; mostly equivalent functionality exists except CSV upload (entirely absent).

### 2.3 Key code excerpts

**The classifier** ([finances.ts:64-93](../ss-control-center/src/lib/amazon-sp-api/finances.ts#L64-L93)):

```ts
export function parseAdjustments(financialEvents: any[]) {
  const adjustments: any[] = [];
  for (const events of financialEvents) {
    const adjEvents = events.AdjustmentEventList || [];
    for (const adj of adjEvents) {
      if (
        [
          "ShippingChargeback",
          "CarrierAdjustment",
          "WeightAdjustment",
        ].includes(adj.AdjustmentType)
      ) {
        for (const item of adj.AdjustmentItemList || []) {
          adjustments.push({
            type: adj.AdjustmentType,
            date: adj.PostedDate,
            orderId: item.OrderId,
            sku: item.SellerSKU,
            amount: parseFloat(item.TotalAmount?.CurrencyAmount || "0"),
            reason: item.Title || adj.AdjustmentType,
          });
        }
      }
    }
  }
  return adjustments;
}
```

**The scan loop** ([scan/route.ts:19-86](../ss-control-center/src/app/api/adjustments/scan/route.ts#L19-L86)):

- Hard-coded to look 14 days back (`fourteenDaysAgo`).
- Iterates every store from `getConfiguredStores()` — currently `store1, store2, store3, store5` (store4 missing creds).
- Calls `parseAdjustments(events)` → empty array as shown in §5.
- Builds `externalId` as `${orderId}-${date}-${type}`; uses bulk `findMany` then `createMany` — clean dedup logic.
- Returns `{scanned, newSaved, stores}`.

**The page** ([adjustments/page.tsx](../ss-control-center/src/app/adjustments/page.tsx)) calls three endpoints on mount:

- `GET /api/adjustments/stats` → 4 KPI cards
- `GET /api/adjustments?channel=&days=30` → main table
- `GET /api/adjustments/sku-profiles` → SKU issues panel

A "Refresh" button re-fires these three; **no scan / sync button is rendered**.

### 2.4 TODO / FIXME / stubs

Grepped `src/app/adjustments`, `src/components/adjustments`, `src/app/api/adjustments`, `src/lib/amazon-sp-api/finances.ts`, `src/lib/walmart/reports.ts` — **no `TODO`, `FIXME`, or `throw new Error("not implemented")` comments found.** The code reads as complete but operates on wrong assumptions about the Amazon API shape.

---

## 3. DATABASE STATE

### 3.1 Models present in `prisma/schema.prisma`

| Model | Line | Purpose |
|---|---|---|
| `ShippingAdjustment` | 269 | One row per adjustment from Amazon/Walmart. `@unique` on `externalId` for dedup. |
| `SkuAdjustmentProfile` | 305 | One row per SKU — aggregated stats |
| `WalmartReconTransaction` | 851 | One row per recon-report line. Compound `@unique` on `(transactionPostedTimestamp, purchaseOrderId, transactionType, amount)` |

The schema is correct; field types are reasonable.

> Note: prompt referenced "ShippingTransaction" but the actual model is `ShippingAdjustment`. Wiki + code agree on the latter.

### 3.2 Records — counts against prod Turso

Live query 2026-05-22 via Prisma client:

```
ShippingAdjustment
  total:    0
  reviewed: 0
  by channel: []
  by adjustmentType: []
  newest createdAt: —
  newest adjustmentDate: —

SkuAdjustmentProfile
  total: 0
  needsSkuDbUpdate=true: 0

WalmartReconTransaction
  total: 0
  by transactionType: []
  by storeIndex: []
  newest reportDate: —
```

All three tables are empty. There have been zero successful syncs.

### 3.3 Sidebar badge "15" — origin

The badge appears on the "Adjustments" nav item ([SidebarContent.tsx:74-79](../ss-control-center/src/components/layout/SidebarContent.tsx#L74-L79)):

```tsx
{
  title: "Adjustments",
  href: "/adjustments",
  icon: Receipt,
  pillCount: s.claims?.active || undefined,   // ← wrong source
  pillVariant: "warn",
},
```

`s.claims.active` comes from `/api/dashboard/summary` → `prisma.atozzClaim.count({ where: { status: { in: ['NEW', 'EVIDENCE_GATHERED', 'RESPONSE_READY', 'SUBMITTED'] } } })`.

DB confirms: `AtozzClaim` active = **15**. That's the source of the badge. The Adjustments link should be bound to `ShippingAdjustment.count` (or filtered to recent + unreviewed); it's not.

This is a one-line wiring bug, separate from the data-flow problem.

---

## 4. ENV VARIABLES

Local `.env` (status only — values not printed):

| Variable | Status |
|---|---|
| `AMAZON_SP_CLIENT_ID_STORE1..3,5` | SET |
| `AMAZON_SP_CLIENT_SECRET_STORE1..3,5` | SET |
| `AMAZON_SP_REFRESH_TOKEN_STORE1..3,5` | SET |
| `AMAZON_SP_*_STORE4` (Sirius) | **MISSING** — expected per CLAUDE.md (no SP-API app yet) |
| `AMAZON_SP_MARKETPLACE_ID` | SET (= `ATVPDKIKX0DER` ✓) |
| `WALMART_CLIENT_ID_STORE1` | SET |
| `WALMART_CLIENT_SECRET_STORE1` | SET |

Vercel production env mirrors local. JACKIE_API_TOKEN, R2_*, etc. are all present.

**Manual checks required (Vladimir):**

- [ ] Confirm the SP-API LWA application for each store has the **"Finance and Accounting"** role checked (Seller Central → Develop apps → app → Edit App → Data access). This cannot be inferred from env vars alone — but live results in §5 imply at least STORE1/3/5 do have the role (data returned), and STORE2 either does not or the account is suspended (403 Unauthorized).

---

## 5. SYNC ATTEMPT RESULTS

### 5.1 Test call against `getFinancialEvents` — production SP-API

Window: `PostedAfter=2026-05-16T15:21:38.842Z` (last 7 days), no `PostedBefore` — mirrors what `/api/adjustments/scan` actually sends.

| Store | HTTP result | Pages | AdjustmentEventList entries | ShipmentEventList entries | Notes |
|---|---|---|---|---|---|
| store1 (Salutem) | 200 OK | 3 | **317** | 88 | Rate limit hit once (waited 5s, succeeded). Full success. |
| store2 (Personal) | **403 Unauthorized** | — | — | — | `Access to requested resource is denied.` — account banned (confirmed earlier today by Vladimir). |
| store3 (AMZCOM) | 200 OK | 1 | **88** | 34 | — |
| store5 (Retailer) | 200 OK | 1 | **72** | 55 | Surprisingly returns data despite US suspension; the SP-API LWA token is still valid for Finances. |

`parseAdjustments(events)` output across all four stores: **0** rows. Same as production.

### 5.2 Why parseAdjustments returns zero

The parser filter ([finances.ts:71-77](../ss-control-center/src/lib/amazon-sp-api/finances.ts#L71-L77)):

```ts
["ShippingChargeback", "CarrierAdjustment", "WeightAdjustment"].includes(adj.AdjustmentType)
```

Actual `AdjustmentType` values observed in production data (store1 + store3 + store5, 7-day window, 477 total events):

| AdjustmentType | Count (store1) | Count (store3) | Count (store5) |
|---|---|---|---|
| `PostageBilling_Postage` | 121 | 34 | 21 |
| `Other` | 75 | 25 | 22 |
| `PostageBilling_Insurance` | 73 | 24 | 21 |
| `PostageBilling_PostageAdjustment` | 30 | 3 | 6 |
| `PostageRefund_PostageAdjustment` | 4 | — | — |
| `PostageRefund_Postage` | 1 | 1 | 1 |
| `PostageRefund_Insurance` | 1 | 1 | 1 |
| `ReserveDebit` / `ReserveCredit` | 1 / 1 | — | — |
| `PostageBilling_FuelSurcharge` | 1 | — | — |
| `PostageBilling_TransactionFee` | 1 | — | — |
| `PostageBilling_ImportDuty` | 1 | — | — |
| `PostageBilling_Tracking` | 1 | — | — |
| `PostageBilling_SignatureConfirmation` | 1 | — | — |
| `ReturnPostageBilling_Tracking` | 1 | — | — |
| `ReturnPostageBilling_Postage` | 1 | — | — |
| `ReturnPostageBilling_FuelSurcharge` | 1 | — | — |
| `ReturnPostageBilling_OversizeSurcharge` | 1 | — | — |
| `ReturnPostageBilling_DeliveryAreaSurcharge` | 1 | — | — |
| `ShippingChargeback` | **0** | **0** | **0** |
| `CarrierAdjustment` | **0** | **0** | **0** |
| `WeightAdjustment` | **0** | **0** | **0** |

**Not a single event of the three types the parser looks for has ever been observed.** The three filter strings appear to be from an old spec or a different Amazon API version.

The semantically correct equivalent in real data is **`PostageBilling_PostageAdjustment`** (the carrier-correction recharge — the thing Vladimir actually wants to track). 30 of these arrived for store1 in the last 7 days.

### 5.3 Example raw transactions

`PostageBilling_PostageAdjustment` (the real "shipping adjustment"):

```json
{
  "AdjustmentType": "PostageBilling_PostageAdjustment",
  "PostedDate": "2026-05-17T21:12:27Z",
  "AdjustmentAmount": {
    "CurrencyCode": "USD",
    "CurrencyAmount": -6.41
  }
}
```

`PostageRefund_PostageAdjustment` (refund of an over-charge):

```json
{
  "AdjustmentType": "PostageRefund_PostageAdjustment",
  "PostedDate": "2026-05-17T21:12:01Z",
  "AdjustmentAmount": {
    "CurrencyCode": "USD",
    "CurrencyAmount": 1.29
  }
}
```

`PostageBilling_Postage` (the routine label charge — not an adjustment):

```json
{
  "AdjustmentType": "PostageBilling_Postage",
  "PostedDate": "2026-05-17T00:15:44Z",
  "AdjustmentAmount": {
    "CurrencyCode": "USD",
    "CurrencyAmount": -7.73
  }
}
```

**Notice what is NOT in any of these events:** no `AdjustmentItemList`, no `OrderId`, no `SellerSKU`. The current parser ([scan/route.ts:46-47](../ss-control-center/src/app/api/adjustments/scan/route.ts#L46-L47)) builds `externalId` as `${orderId}-${date}-${type}` and skips rows whose `orderId` is missing — every real `PostageBilling_PostageAdjustment` would be skipped on that criterion alone, even with the type filter fixed.

The order/SKU linkage for these events lives in `ShipmentEventList[].ShipmentItemList[].ItemFeeList[]` (with `FeeType: "ShippingHB"`), or via a separate per-order Finances call. The current implementation does not correlate either way.

### 5.4 Errors / edge cases

- **store2 — 403 Unauthorized**: account banned (Vladimir confirmed 2026-05-22). The scan loop currently `console.error`'s and continues, which is correct behavior for a multi-store scan.
- **store5 — works despite US suspension**: returns 72 adjustment events. SP-API tokens are independent of marketplace suspension, so the Finances endpoint still answers. Whether to include suspended-account data is a product decision.
- **Rate limit observed once on store1** (first call) — auto-retry with 5s wait succeeded. No persistent issue.
- **Diagnostic-script bug**: my first attempt sent `PostedBefore=now()` which Amazon rejected as future-dated (`"should be no later than 2 minutes from now"`). The production scan endpoint correctly omits `PostedBefore` — no bug there.

---

## 6. UI INVENTORY

### 6.1 Components — spec vs. reality

| Component (from prompt) | In code? | Rendered on page? | Notes |
|---|---|---|---|
| `AdjustmentFilters` (store + date range + quick periods) | Partial | Yes | No store filter at all. Date filter is hard-coded 14/30/60/90 dropdowns inside `AdjustmentsTable`. No quick-period buttons. No MTD. |
| `AdjustmentSummaryCards` (4 cards) | Yes | Yes | `KpiCard`-based: This month, Last 30 days, Amazon, Walmart. Values bind to `stats` payload. |
| `SyncButton` | **No** | **No** | The `/api/adjustments/scan` route exists but no UI button triggers it. Only a "Refresh" button that re-fetches the existing DB rows. |
| `TransactionsTable` | Yes (`AdjustmentsTable`) | Yes | Full desktop + mobile rendering. Expandable rows with declared vs adjusted weight/dims. |
| `SkuAnalysisTable` | Yes (`SkuIssuesPanel`) | Yes | Lists rows with `totalAdjustments`, `totalAmountLost`, `mostCommonType`, `suggestedWeight`, `needsSkuDbUpdate` badge. |
| CSV Upload button | **No** | **No** | No `/api/adjustments/upload` route, no UI button. |
| Tabs: All / Adjustments Only / SKU Analysis | Partial | Yes | `FilterTabs` for `All / Amazon / Walmart` (channel filter, not the spec's tabs). "Shipping adjustments" and "SKU issues" are stacked panels, not tabs. |
| Walmart sync trigger | **No** | **No** | `/api/adjustments/walmart/sync` exists but unreachable from UI. |

### 6.2 Network requests on page load

Inferred from [adjustments/page.tsx:55-97](../ss-control-center/src/app/adjustments/page.tsx#L55-L97) (didn't open production in a browser — read-only audit):

1. `GET /api/adjustments/stats` → returns `{thisMonth: 0, thisMonthCount: 0, last30Days: 0, last30Count: 0, amazonTotal: 0, walmartTotal: 0, problematicSkus: 0}` because all aggregations are over an empty table.
2. `GET /api/adjustments?days=30` → returns `{adjustments: [], total: 0}`.
3. `GET /api/adjustments/sku-profiles` → returns `[]`.

All three return 200 OK with empty payloads. The page renders correctly given that data.

---

## 7. ROOT CAUSE ANALYSIS

### 7.1 Why 0 transactions in DB

**Hypothesis: A.** Parser filter does not match any real `AdjustmentType` values.
**Confidence: HIGH.** Proof: live SP-API call against store1/3/5 returned 477 AdjustmentEvent entries across ~19 distinct types — zero of which match the parser's three target strings. `PostageBilling_PostageAdjustment` is the closest semantic equivalent and exists in volume.

**Hypothesis: B.** Even with the filter fixed, the per-event payload lacks `AdjustmentItemList` for `PostageBilling_*` types, so the parser's inner loop produces zero rows.
**Confidence: HIGH.** Proof: §5.3 shows the actual event shape — only `AdjustmentType`, `PostedDate`, and `AdjustmentAmount`. No nested item list, no order ID, no SKU.

**Hypothesis: C.** The scan endpoint is never invoked.
**Confidence: HIGH.** Proof: no UI button, no cron job ([searched `vercel.json` — no `adjustments` schedule]), no `syncLog` entries for adjustment scans.

All three are simultaneously true. C is the proximate cause of literally-zero data; A+B mean that fixing C alone (e.g. adding a "Sync" button) would still produce zero rows.

### 7.2 Why no Sync button

The button was never added to `page.tsx`. The route `/api/adjustments/scan` was implemented but the UI side stopped at a placeholder Refresh button. There is no comment explaining why — likely the original developer expected to ship the UI in a follow-up that didn't happen.

### 7.3 Why sidebar badge shows 15

Wrong field wired: `pillCount: s.claims?.active` in [SidebarContent.tsx:77](../ss-control-center/src/components/layout/SidebarContent.tsx#L77). `s.claims.active` is the live count of in-progress A-to-Z claims (15 right now), not adjustments. The DB has 0 `ShippingAdjustment` rows, so a corrected wiring would show no badge at all (which is consistent with the page's `0 transactions tracked`).

### 7.4 Why no CSV upload

Never implemented. No route, no button, no parser for CSV format. The spec calls for it; the code never reached that phase.

### 7.5 Why no Walmart data either

`WalmartReconTransaction` table is empty for the same reason as Amazon — the `POST /api/adjustments/walmart/sync` route exists but is never invoked. No UI button, no cron. The route itself looks functionally correct (paginates `getAvailableReconReportDates` → `getFullReconReport` → `persistTransactions`) but has never run.

---

## 8. RECOMMENDED FIX ORDER

This is input for the next conversation with Vladimir — **not** executed.

1. **[HIGH] Replace `parseAdjustments` type filter with the real Amazon types.** Map `PostageBilling_PostageAdjustment` → `WeightAdjustment` (DB enum string), `PostageRefund_PostageAdjustment` → reverse-with-positive-amount, and decide whether to also persist `PostageBilling_Postage` (the baseline label charge — useful for "total shipping spend" KPI, not really an "adjustment"). Without this, no other fix matters.

2. **[HIGH] Decide order/SKU linkage strategy.** Three options:
   - **(2a) Settlement-window match.** For each `PostageBilling_PostageAdjustment`, find the nearest `ShipmentEvent` by `PostedDate` ± 24h with matching amount-ish. Cheap but lossy.
   - **(2b) Per-order Finances call.** For each AmazonOrder in the period, call `/finances/v0/orders/{orderId}/financialEvents` and pull the per-order adjustment block. Expensive (N requests per day) but exact.
   - **(2c) Settlement reports.** Use `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` (the same TSV Amazon emails) which has per-line `posted-date-time, sku, order-id, amount-type, amount-description, amount` and bundles adjustments with order metadata. Cleanest source — recommend.

3. **[HIGH] Fix sidebar badge wiring.** Either bind `s.adjustments?.unreviewed` (needs new field on `/api/dashboard/summary`) or just `s.adjustments?.monthlyTotal > 0 ? "$" + ... : undefined`. One-line edit + summary endpoint addition.

4. **[MEDIUM] Add Sync button to the page.** `POST /api/adjustments/scan` for Amazon, `POST /api/adjustments/walmart/sync` for Walmart. Show toast with `{scanned, newSaved}` result.

5. **[MEDIUM] Cron-schedule the sync.** `vercel.json` cron, daily at e.g. 08:30 UTC (after Amazon's nightly settlement). Reuses the existing endpoints.

6. **[MEDIUM] Add store + date-range filter** to the page header — currently filters are buried inside the table component and only cover channel + 14/30/60/90 dropdowns. No store filter.

7. **[LOW] CSV upload.** Implement `/api/adjustments/upload` (multipart) + a button. Useful when SP-API misses data or for backfilling historical adjustments.

8. **[LOW] Add page-level "scan history" panel.** Show `syncLog` entries for `module='adjustments'` so the operator can see when the last successful sync ran and what it returned. Requires logging from `scan/route.ts`.

9. **[LOW] Decide what to do with store2 (Personal — banned).** Either skip it explicitly in `getConfiguredStores`, or wrap the per-store try/catch with a "this store is suspended — skipping" warning surfaced in the scan response.

---

## 9. UNKNOWNS / QUESTIONS FOR VLADIMIR

1. **Does the SP-API LWA app for each store actually have the "Finance and Accounting" role?** Live data implies STORE1/3/5 do; STORE2's 403 could be the role, account suspension, or both. Manual verification in Seller Central needed.
2. **Is Vladimir comfortable using `PostageBilling_PostageAdjustment` as the source of truth for "carrier adjustment"?** This is what Amazon recharges for actual measured weight/dims — semantically correct, but the historical spec mentions "WeightAdjustment" / "DIMadjustment" / "CarrierAdjustment" as if they were three separate types. They aren't — at least not in this API version.
3. **Should the suspended/banned accounts (`store2 Personal`, `store5 Retailer US-suspended`) be excluded from the scan?** Currently both make API calls; store2 fails immediately, store5 succeeds and returns data.
4. **Settlement-report path vs. financial-events path** — does Vladimir already get the weekly Settlement Reports via email? Those are the canonical adjustment source and would be a simpler integration (TSV download + parse).
5. **CSV upload format** — is there a specific template (Excel from Walmart's web download)?
6. **How does Vladimir want to handle the order-linkage gap?** Without per-order Finances calls or settlement reports, an adjustment can only be roughly tied to a date — not a specific shipment. Acceptable, or blocker?

---

## 10. CLEANUP

Temporary diagnostic scripts created during this audit — **to be deleted before any commit**:

- `ss-control-center/scripts/_diag-adjustments-db.ts`
- `ss-control-center/scripts/_diag-finances-test.ts`
- `ss-control-center/scripts/_diag-sample-adj.ts`

Temporary log files in `/tmp/` (auto-cleaned by OS, no action needed):

- `/tmp/adj-finances-test.log`
- `/tmp/adj-finances-test2.log`
- `/tmp/adj-sample.log`

**No production code was changed** during this audit. `git status` will show only:

- This new report file
- The three temp scripts (to be deleted)
- Pre-existing uncommitted files unrelated to this audit (call-center docs, wiki edits) — left alone.

No git commits made. Vladimir decides when to commit.
