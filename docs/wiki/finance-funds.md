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

## Per-expense balance meter — drives "Needed" (DEPLOYED 2026-06-21)

Vladimir's model: **every expense item (and every installment debt) is its own running
balance** — `Accrued` (начислено) − `Paid` (выплачено) = `Owed` (остаток). Accrued is a
counter that ticks UP every day; Paid grows only when you press **Paid** (full or part).
Owed **carries forward** plan-to-plan: next plan's Needed = old unpaid owed + newly
accrued days. Distribution **`Needed(fund) = Σ owed`** of its expenses + installment debts.

- `RecurringExpense.accrued` + `paid` + `lastAccruedDate`; `Debt.accrued` + `paid` +
  `lastAccruedDate`. `src/lib/finance/accrual.ts`: `dailyOwedRate` = `monthlyAmount/30.44`,
  `accrueCategory` grows non-salary `accrued` daily; `accrueInstallments` grows
  installment-debt `accrued` (capped at remaining). **First tick bootstraps one week**
  (`BOOTSTRAP_DAYS=7`). Ticked on read (`needs`, fund GET, debts GET) + daily cron
  `/api/cron/finance-accrual` (05:00); idempotent by `lastAccruedDate`.
- **Owed = accrued − paid** everywhere (needs, fund owed totals, UI). Pay → `pay_expense`
  (fund) / debt `pay`: debit the fund cash + **raise `paid`** (accrued stays as the
  cumulative начислено), as a single **`prisma.$transaction`** (atomic; verified on Turso).
- **Salaries are timesheet-driven, NOT smooth-accrued** (`accrueCategory` skips the
  Salaries category). Each employee = one salary expense; the **Timesheet** moves that
  employee's `accrued` by `perDayRate` for every worked day toggled (atomic with the
  TimeLog row). The Timesheet shows a per-employee balance (Accrued / Paid / Owed) with a
  Paid button (calls the fund's `pay_expense`); the generic Balances table is hidden on
  the Salaries fund. `src/app/api/finance/timesheet/route.ts` + `components/finance/Timesheet.tsx`.
- Fund page: a **"Balances"** table per expense — Monthly (true monthly-equivalent via
  `monthlyAmount`, so a $55/week row shows $238/mo, not $55) · Accrued · Paid · Owed ·
  Pay. KPIs: cash balance / owed (остаток) / after-clearing.
- **Taxes** and **Reserve** are NOT accrued — % of the payout (Taxes = `taxRatePct` ×
  pending net, default 1.5%, on the FP page; Reserve = 58% off the top). **Expansion/Debt
  (FP2)** has no target → Needed 0.
- `auto-allocate` ("Auto-set % from needs") = each FP1 fund's % from its monthly
  obligation **incl. installment debts**.
- Installment debts (рассрочка): `monthlyPayment` + `paymentFrequency`
  (monthly/biweekly/weekly/daily); `installmentMonthly` averages to monthly (daily here =
  calendar ×30.44, unlike a daily wage's ×21.67 work days — intentional).
- Tests: `scripts/check-finance-accrual.ts` (all pass). Audited by a multi-agent
  adversarial pass (2026-06-21): atomic-payment + auto-allocate fixes applied; taxNeed
  "dead code" and zero-accrued-filter findings dismissed (false positives — the Taxes
  fund exists at runtime; Needed is a hint, not a forced alloc).

## Next (later phases)
F9 forecast (income vs plan, behind-plan alerts → Amazon/Walmart Grow); F4/F3 full
fee+returns capture → entity P&L; F2 fix the empty `/economics`; F10 QuickBooks cash
flow; F11 payroll/tax; F12 PDF reports; F6 debts; F7 partner equity.
