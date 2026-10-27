# Personal Finance Phase 2 — handoff Claude → Codex (2026-10-27)

Telegram topic 728 «Финансовое планирование». The owner moved the tab to Codex at 10:48
(Anthropic limits). Claude stopped after the current atomic change; nothing is half-written.
Canonical description of what was built: [personal-finance.md](personal-finance.md)
(section "Phase 2").

## Done and in production

- **Turso schema** (additive, applied): `scripts/turso-migrate-personal-registry.mjs`
  — registry columns on `Debt` / `CreditCard`, tables `ObligationEvent`, `PersonalAsset`.
- **Turso data 2026-10-27** (applied in one transaction; a re-run inserts nothing):
  `scripts/seed-personal-registry-2026-10-27.mjs`. 15 cards updated + Victoria's Secret
  1548 added; 6 June-sheet cards set not-counted (`active=0`, badge Needs check); 14
  business-pool debts updated in place; 7 new debts (IRS 2025, Lendistry, MVB/Lendesca,
  SBA EIDL, Midland, BMW X3, BMW moto); 9 events (Amex 01001 mediation + 5 Hilton
  installments, IRS 2025 window, BJ's full statement, BJ's pay-before-close); 6 assets
  (WF ×5, PayPal); personal bill meters restarted; bills BMW ×2 + SBA deactivated
  (moved to Debt rows).
- **Code** — commit `7bc760c26` on `main`: pure libs `src/lib/finance/{registry,payoff,calendar,cards,accrual}.ts`,
  API `src/app/api/personal/{registry,calendar,cards}/route.ts` + `src/app/api/finance/debts/route.ts`,
  pages `/personal`, `/personal/obligations`, `/personal/plan`, `/personal/net-worth`,
  `/personal/cards`, components `src/components/personal/registry-ui.tsx`.
  Checks: `npx tsx scripts/check-personal-finance.ts` — ALL PASS; `tsc --noEmit` clean;
  eslint clean on the touched files.
- Verified before push on a local dev server against prod Turso (read-only):
  `/api/personal/registry` 200 (35 counted obligations, $255,267.60 known + 2 unknown,
  6 warnings), `/api/personal/calendar?window=60` 200 (2 late: Credit One AmEx 3989, BMW X3).
  The pages were NOT opened in a browser (owner-only login) — first owner view is the
  first real render.

## Not done — next steps for Codex

1. Open the four pages as the owner on prod and fix any render issue.
2. Owner/Jackie inputs still missing (all shown as "not set" / Needs check):
   EGK $7,489.16 and factory $3,015 are June balances (Jackie reconciles from bank +
   mail); SBA EIDL balance; BMW X3 balance + payment ($810 is from the June sheet);
   Amex 01001 installment amounts + court costs; APR of every card except WF Reflect;
   whose card Victoria's Secret 1548 is; fate of the 6 not-counted June cards;
   Parafin biweekly anchor date (it's in "Recurring, date not fixed").
3. When Jackie sends EGK / factory payment history: update those Debt rows via
   `PATCH /api/personal/registry {type:"debt", id, balance, balanceAsOf, balanceSource}`
   (or the Obligations page edit) — never a new row.
4. Optional later: Plaid auto-refresh of card balances; Credit Karma; amortization.

## Guardrails that hold

- Business-pool debts stay in the business plan (updated in place, never copied) —
  otherwise both plans count the same payment.
- No number without a date + source; unknown stays unknown (never $0).
- Owner is required on every debt and card.
- Jackie's registry note 18.10: all debts are on pause except the Amex 01001 court —
  the payoff plan is a model only; nothing is paid from the app.
