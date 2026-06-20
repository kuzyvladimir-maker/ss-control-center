# Marketplace financial APIs — Amazon Payments & Walmart (reference)

Reference for the Financial Plan module: which Amazon/Walmart API gives which
financial data, mapped to the Seller-Central screens. Linked: [[finance-funds.md]].

## Amazon — Seller Central "Payments" tabs → API source

The Payments Dashboard tabs and where each one's data comes from via SP-API:

| Seller Central tab | What it shows | API source we use |
|---|---|---|
| **Statement View** (Net Proceeds: Sales→Product/Shipping/Other, Refunds, Expenses→Shipping charges/Amazon fees/Other, Reserve) | One settlement period decomposed | **Settlement Report** `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` — this is exactly what our `parseAmazonSettlement()` reproduces |
| **All Statements** | List of closed settlement periods | Same settlement reports (one report = one closed statement) |
| **Transaction View** / Disbursements | Per-transaction + reserve/deferred detail | `/finances/v0/financialEvents` (real-time events) + the newer Transaction Report |
| **Advertising Invoice History** | Sponsored Products / ad spend | **Separate Amazon Ads API** (different OAuth scope) — NOT in settlement unless the account pays ads by disbursement deduction. We do NOT integrate Ads yet. |
| **Reports Repository** | On-demand report requests | `/reports/2021-06-30/reports` request+poll |
| Lending | — | n/a |

**Key facts**
- V2 settlement reports are **auto-generated** by Amazon each cycle (~1-2 weeks).
  We only LIST (`listSettlementReports`, filter processingStatus=DONE) + download
  (`getReportDocumentUrl` → `downloadReport`, auto-gunzips). We never "request" them.
- **Net payout** = the settlement-summary row's `total-amount` column (the actual
  bank deposit) = SUM of all signed detail-row amounts INCLUDING the two reserve
  rows (`current-reserve-amount` negative hold, `previous-reserve-amount-balance`
  positive release). Gross earnings = that SUM excluding the reserve rows.
- **Bucketing** = function of `(amount-type, amount-description, transaction-type)`
  together (the same description flips sign between Order and Refund). Full taxonomy
  in `src/lib/finance/settlement.ts` (`bucketAmazonRow`). Buckets: sales,
  shipping_income, tax_collected (wash), refunds, referral_fee, fba_fee, storage_fee,
  shipping_cost (Buy-Shipping label), ads, promo, fee_other, adjustment, reserve, other.
- Settlement periods are **immutable** once DONE → safe to re-pull; we track pulled
  `reportDocumentId`s in Setting `finance:amazon:pulledReports` for incremental pulls.
- Dates come in mixed locale formats (ISO / DD.MM.YYYY / MM/DD/YYYY) — normalized to ISO.

## Walmart — financial data

| Need | API |
|---|---|
| Settlement / payout transactions | **Reconciliation report**: `GET /v3/report/reconreport/availableReconFiles` (dates) + `/v3/report/reconreport/reconFile?reportDate=…` (paginated rows). Lib: `WalmartReportsApi.getAvailableReconReportDates` + `getFullReconReport`. |
| Returns | `/v3/returns` (`WalmartReturnsApi`) — fetched but not persisted yet |
| Ads | Walmart Connect / separate — not integrated |

- Recon report has **no payout-total field** → net = SUM(row amounts). Bucketing by
  `transactionType` (Sales|Refunds|Adjustments|Fees) + feeType/description
  (`bucketWalmartRow`).
- ⚠️ **Known gap (2026-06-20):** the recon API returns available dates but the
  `reconFile` rows came back EMPTY for this account in testing → 0 Walmart payouts
  ingested. Root cause TBD (account recon may be empty, or a different
  settlement/payments endpoint is needed). Amazon decomposition works fully. Walmart
  meanwhile relies on manual payout entry until recon data flows.

## Code map
- `src/lib/finance/settlement.ts` — bucket taxonomy + `parseAmazonSettlement` + `bucketWalmartRow`.
- `src/lib/finance/payouts.ts` — `ingestAmazonPayouts` / `ingestWalmartPayouts` (the "Get Report" pipeline) → `Payout` + `PayoutLine`.
- `src/lib/amazon-sp-api/settlement-reports.ts` / `reports.ts` — list/download.
- `src/lib/walmart/reports.ts` — recon fetch.
- Tests: `scripts/check-finance-settlement.ts` (categorization + parser).
