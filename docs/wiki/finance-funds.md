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

## Next (later phases)
F9 forecast (income vs plan, behind-plan alerts → Amazon/Walmart Grow); F4/F3 full
fee+returns capture → entity P&L; F2 fix the empty `/economics`; F10 QuickBooks cash
flow; F11 payroll/tax; F12 PDF reports; F6 debts; F7 partner equity.
