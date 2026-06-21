# Finance Core — Funds (Phase 1)

**Status:** shipped 2026-06-20. First phase of the **Finance Core super-module**
(the full financial brain: per-SKU economics → entity P&L → tax/payroll → funds →
forecast → QuickBooks). Plan: `~/.claude/plans/goofy-crafting-flamingo.md`. Business
facts (entities/partner/channels/debts): memory `reference_legal_entities` +
`project_finance_core_module`.

## What it is

Cash-basis financial planning by **funds**, one **global business pool**:

```
Payout (marketplace deposit, net of fees AND shipping labels)  →  pool "money in"
  reserve = payout.net × reserveRate     → RESERVE fund (restock: COGS+packaging — NOT shipping)
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
  pending net, default 1.5%, on the FP page; Reserve = currently **50%** off the top —
  see "Reserve = COGS + packaging" below). **Expansion/Debt
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

## Reserve = COGS + packaging (shipping excluded) — 2026-06-21

Vladimir's insight: marketplace shipping labels (Amazon/Walmart Buy Shipping) are
**deducted from the payout** — verified in the settlement (`shipping_cost` −$4,796 sits
inside the net deposit; customer `shipping_income` roughly covers it). So the payout we
distribute is already net of shipping; reserving COGS+packaging+**shipping** (the old
0.58 basis) double-counted shipping. Reserve now covers **COGS + packaging only**
(`blendReserveRate` drops shipping; `DEFAULT_MANUAL_PCT` flagged too-high).

Reserve % derived from the Uncrustables pricing formula (`uncrustables-pricing-model.md`,
`Price = Landed × (1+markup)/0.85`, Landed = товар+упаковка+shipping):
> **reserve% = (товар+упаковка) / (Landed×(1+markup) − shipping)**, on the S cooler (92% of volume).
- markup 60% → ~51%; markup 70% → ~47%. **Vladimir set 50%** manually (markup floats >60%
  on average), Setting `finance:reserve:manualPct` = 0.5. Refine to real per-order COGS later.

## Distribution UI — live preview (2026-06-21)
- Changing **Reserve %** or any fund's **My %** recomputes distributable + every Amount
  live (no re-Preview). **Auto-set % from needs** sets My% = `Needed$ / distributable`
  (covers each fund's owed exactly; client-side). Total fund % shown; **over 100% blocks
  Commit** (Free can't go negative). New **Balance** column + clickable fund names.
- **Move money between funds**: `/api/finance/funds/transfer` writes BOTH legs to the
  ledger (−source, +target) atomically; UI on the Funds tab.
- Per-expense **Accrued/Paid** are editable (PATCH `/api/finance/expenses`); the **ledger**
  is editable (description/amount via PATCH `edit`, balance-delta on applied) + deletable
  on every row. Fund **Back** button → Funds tab (`/finance?tab=funds`).
- **Get Report fix**: Amazon Reports list `createdSince` capped at 88 days (API rejects
  >90d) and the window narrowed to 35 days — it only needs the latest closed settlement.
- **Perf fix**: accrual no longer ticks on every GET (caused Turso SQLite write-lock
  hangs). Meters advance once/day via `/api/cron/finance-accrual`; GETs are read-only.

## Next (later phases)
F9 forecast (income vs plan, behind-plan alerts → Amazon/Walmart Grow); F4/F3 full
fee+returns capture → entity P&L; F2 fix the empty `/economics`; F10 QuickBooks cash
flow; F11 payroll/tax; F12 PDF reports; F6 debts; F7 partner equity.
