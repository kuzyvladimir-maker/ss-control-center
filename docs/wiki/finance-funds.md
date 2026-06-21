# Finance Core — Funds (Phase 1)

**Status:** shipped 2026-06-20. First phase of the **Finance Core super-module**
(the full financial brain: per-SKU economics → entity P&L → tax/payroll → funds →
forecast → QuickBooks). Plan: `~/.claude/plans/goofy-crafting-flamingo.md`. Business
facts (entities/partner/channels/debts): memory `reference_legal_entities` +
`project_finance_core_module`.

## What it is

Cash-basis financial planning by **funds**, one **global business pool**:

```
Payout (marketplace deposit, net of fees)  →  pool "money in"
  reserve = payout.net × reserveRate     → RESERVE fund (restock: COGS+shipping+packaging)
  distributable = net − reserve
  waterfall by priority: FP1 (life-support) → FP2 (growth) → FREE (leftover)
```

Run manually (`/finance` → Preview → Commit) or weekly via cron.

## Decisions (Vladimir 2026-06-20)
- Funds FIRST (before forecast / P&L / unit-economics fix).
- Cash basis; **money in = marketplace payouts** (Amazon settlement deposit +
  Walmart recon payment, already net of fees).
- Reserve FIRST = COGS + shipping + packaging.
- One **global pool**, funds are **UI-CRUD**, **waterfall by priority**.
- Reserve rate = floating trailing % (COGS+shipping+packaging) over a config window
  (default 4w); **manual % is the default/fallback** (auto needs more COGS coverage,
  esp. Walmart). Set on `/finance`.

## Files
- `src/lib/finance/types.ts` — FundConfig / DistributionResult / FundGroup.
- `src/lib/finance/distribute.ts` — `distributeFunds()` PURE waterfall (unit-tested).
- `src/lib/finance/reserve-rate.ts` — `getReserveRate()` (Setting `finance:reserve:*`)
  + pure `blendReserveRate()`.
- `src/lib/finance/payouts.ts` — `ingestWalmartPayouts()` (from `WalmartReconTransaction`)
  + `ingestAmazonPayouts()` (settlement reports, net = Σ row amounts) + `ingestAllPayouts()`.
- `src/lib/finance/run.ts` — `runDistribution({preview})` orchestrator (writes
  FinancePlanRun + FundAllocation, bumps balances, marks payouts distributed).
- `src/lib/finance/entities.ts` — store→legal-entity map.
- API: `src/app/api/finance/funds|payouts|config|run/route.ts` + cron
  `src/app/api/cron/finance-funds/route.ts` (weekly, vercel.json `30 9 * * 1`).
- UI: `src/app/finance/page.tsx` (pool, reserve %, ingest/manual payout, preview/commit,
  balances) + `src/app/finance/funds/page.tsx` (CRUD). Sidebar "Finance".
- Schema: `Payout`, `Fund`, `FundAllocation`, `FinancePlanRun`. Migration
  `prisma/migrations/20260620170000_finance_funds/` + `scripts/turso-migrate-finance-funds.mjs`
  (applied to Turso; seeds RESERVE + FREE system funds).
- Tests: `scripts/check-finance-core.ts` (waterfall, cap, oversubscribe, FREE leftover).

## Data reality (2026-06-20)
- `WalmartReconTransaction` empty → Walmart payout auto-ingest yields 0 until recon
  is synced. Amazon payouts come from live settlement (the `/finance` Ingest button
  on prod, where SP-API creds live). **Manual payout entry** on `/finance` guarantees
  the engine is usable meanwhile.
- System funds seeded: "Restock reserve" (RESERVE, priority 0) + "Free / unallocated"
  (FREE, 9999). Vladimir adds FP1/FP2 funds in the UI.

## Get Report — statement decomposition (added 2026-06-20)

The Financial Plan page (`/finance`, sidebar "Financial Plan") leads with a
**Get Report** button that pulls the last CLOSED marketplace settlement periods we
haven't pulled yet and **decomposes each payout into a Net-Proceeds statement**
(matches Amazon Seller Central's Statement View): sales, shipping collected,
refunds, referral, FBA, storage, shipping/label cost, ads, promo, fees,
adjustments, tax (wash), reserve (timing) → net.

- Taxonomy + parser: `src/lib/finance/settlement.ts` (`bucketAmazonRow`,
  `bucketWalmartRow`, `parseAmazonSettlement`). API endpoint map: [[marketplace-financial-apis.md]].
- Storage: `PayoutLine` (one row per payout×bucket). Ingest: `src/lib/finance/payouts.ts`.
- Incremental: Amazon tracks pulled `reportDocumentId`s in Setting
  `finance:amazon:pulledReports`; Walmart skips dates already a Payout. Settlement
  periods are immutable, so re-pull is safe (upsert).
- Verified live on Turso 2026-06-20: 28 Amazon periods decomposed, net matches the
  dashboard's Recent Payouts (6/7 $4,107.82, 6/15 $1,494.81). Walmart recon returned
  empty rows → 0 (known gap, see API reference).
- Tests: `scripts/check-finance-settlement.ts` (all pass).

## Owed-debt meter — drives "Needed" (DEPLOYED 2026-06-21)

Vladimir's model for how much each payout should fund per fund: every expense item
(and every installment debt) carries a daily-ticking **owed counter** = its monthly
cost ÷ 30.44 per calendar day. It goes UP every day and DOWN only when you press
**Paid** on that item (full or part). So unfunded debt **carries forward**: at the
next plan, Needed = old unpaid debt + newly accrued days. Distribution
**`Needed(fund) = Σ owed`** of its expenses + its installment debts.

- `RecurringExpense.accrued` + `lastAccruedDate`, and `Debt.accrued` + `lastAccruedDate`
  (cursor). `src/lib/finance/accrual.ts`: `dailyOwedRate` = `monthlyAmount/30.44`
  (smooth, same basis for **all** categories incl. salary), `accrueCategory` (expenses)
  + `accrueInstallments` (installment debts, capped at remaining). **First tick
  bootstraps one week** (`BOOTSTRAP_DAYS=7`) so a freshly set-up fund shows a
  meaningful week-one number instead of $0.
- Ticked on read (`/api/finance/funds/needs`, fund GET, debts GET) **and** by a daily
  cron `/api/cron/finance-accrual` (05:00). Idempotent by `lastAccruedDate`.
- Pay → `pay_expense` (fund route) / debt `pay` action: debit the fund + reduce the
  owed counter, run as a single **`prisma.$transaction`** (atomic; verified on Turso).
- **Taxes** and **Reserve** are NOT accrued — they're a % of the payout (Taxes =
  `taxRatePct` × pending net, default 1.5%, computed on the FP page; Reserve = 58%
  off the top). The **Expansion/Debt (FP2)** fund has no target → Needed 0.
- Fund page: an **"Owed now"** table per expense (monthly · owed · Paid) replaced the
  old presets/bills view; KPIs are cash balance / owed debt / after-clearing.
- `auto-allocate` ("Auto-set % from needs") sets each FP1 fund's % from its monthly
  obligation **incl. installment debts** (kept in sync with Needs by an audit fix).
- Installment debts (рассрочка): `monthlyPayment` + `paymentFrequency`
  (monthly/biweekly/weekly/daily); `installmentMonthly` averages to a monthly figure
  (daily here = calendar ×30.44 on purpose, unlike a daily wage's ×21.67 work days).
- Tests: `scripts/check-finance-accrual.ts` (all pass). Numbers verified on Turso:
  Salaries ~$3,239 / Warehouse ~$1,019 / Software ~$210 / Subs ~$12 / Installments
  ~$404 for the 7-day bootstrap (≈ "$5k/week" for ~$20k/month).
- Audited by a multi-agent adversarial pass (2026-06-21): atomic-payment + auto-allocate
  fixes applied; taxNeed "dead code" and zero-accrued-filter findings dismissed (false
  positives — the Taxes fund exists at runtime; Needed is a hint, not a forced alloc).
- Open refinement: the Timesheet (salary by worked days) still exists as a side helper
  but the owed meter accrues salary smoothly; worked-day precision in the meter is a
  future refinement.

## Next (later phases)
F9 forecast (income vs plan, behind-plan alerts → Amazon/Walmart Grow); F4/F3 full
fee+returns capture → entity P&L; F2 fix the empty `/economics`; F10 QuickBooks cash
flow; F11 payroll/tax; F12 PDF reports; F6 debts; F7 partner equity.
