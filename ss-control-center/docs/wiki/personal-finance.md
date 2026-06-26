# Personal Finance (Phase 1)

Vladimir's **private** money pool, built on the same envelope engine as the business
[Financial Plan](finance-funds.md) but kept entirely separate. Where the business pool
is fed by marketplace payouts and reserves COGS for restock, the personal pool is fed
by **personal income** (owner's draw from the business + manual) and its centre of
gravity is **credit cards + bills**. Owner-only (RBAC `personal` module, adminOnly).

> Decisions (Vladimir, 2026-06-21): shared engine + `scope` flag (not a fork); income
> mostly an owner's draw from the business (so a bridge exists); Phase 1 = cards + bills
> + loans + income + calendar; **no reserve** on the personal side (taxes are reserved
> in the business pool — one owner across all entities → one tax); FP1 = obligatory
> envelopes, exactly like the business model.

## Architecture — one engine, two pools

Every shared finance table grew a `scope` column (`business` | `personal`, default
`business`). The pure waterfall (`distribute.ts`), the accrual meter, the receipt
scanner, and the funds CRUD are **reused unchanged**; the business endpoints just gained
a `scope` filter (default `business`, so existing callers are unaffected). The personal
UI calls the same endpoints with `?scope=personal`.

- `runDistribution({ scope })` — personal runs use **reserveRate 0** and only consume
  personal funds/payouts.
- `funds` / `funds/needs` / `funds/auto-allocate` / `payouts` / `expenses` / `debts` /
  `receipts` / `funds/history` — all take `?scope=` (default business).
- Credit-card **minimum payments** roll up into the personal **"Credit Cards"** FP1 fund's
  monthly need, so `needs` + `auto-allocate` allocate enough each cycle to cover them.

### New models

- **`CreditCard`** — revolving line: `creditLimit`, `currentBalance`, `statementBalance`,
  `apr`, `minPaymentFixed` + `minPaymentPct` (the minimum rule), `statementDay` + `dueDay`
  (the calendar), `autopay`, `owner` (Vladimir | Anna), `fundId` (which fund pays it).
- **`CardEntry`** — per-card ledger (charge / payment / interest / fee), supports undo.
- Shared models gained `scope`; `RecurringExpense` + `Debt` gained `owner` / `dueDay`
  (and `Debt` gained `apr` / `termMonths` / `kind` for Phase-2 amortization).

### Pure libs (unit-tested — `scripts/check-personal-finance.ts`)

- `cards.ts` — `minPayment` = max(fixed, balance×pct) capped at balance; `utilization` =
  balance ÷ limit; `monthlyInterest` = balance × APR/12; `cardTotals` (overall utilization).
- `calendar.ts` — `buildCalendar(items, todayISO, windowDays)` → upcoming due dates with a
  month-end clamp (a 31st-due bill fires on the last day of a shorter month). No `Date.now`.
- `personal.ts` — owners, FP1 categories, `CREDIT_CARDS_FUND`, priorities.

## Waterfall (personal)

```
Income (owner draw + manual)
  → FP1 obligatory envelopes (Housing, Transport, Family, Health, Loans, Household, Credit Cards)
  → FP2 goals (Savings)
  → Free
```
"Needed" per fund = bills' owed (accrued − paid) + installment debts' accrued +
(for the Credit Cards fund) the sum of card minimum payments.

## Owner-draw bridge

`POST /api/personal/income { action:"draw", fromFundId, amount }` debits a **business**
fund and records the same amount as **personal** income in one step — the only link
between the two pools.

## Gating (owner-only)

- `personal` module in `src/lib/rbac/modules.ts` is `adminOnly` → page `/personal` and
  `/api/personal/*` are admin-only.
- `proxy.ts` also blocks `?scope=personal` on the shared finance endpoints for non-owners
  — closes the leak where a finance-role staffer could read personal data via `/api/finance`.

## UI

- `/personal` — dashboard: green Distribute CTA + Auto-set %, KPI tiles (clickable),
  payment calendar (headline), envelopes (FP1/FP2/Free with balance vs need bars),
  cards summary, income entry (manual + owner draw).
- `/personal/cards` — cards by owner: balance / limit / utilization / min / due, with
  pay (Min/Statement/Full), edit, charge.

## Seed (from Vladimir's 2026 sheet)

`scripts/seed-personal-finance.mjs` (idempotent, `--force` to reseed): 9 funds, 13 bills
(≈ $10,045/mo), 20 cards (Vladimir + Anna, card debt ≈ $50,695). Card limits/APRs are
unknown from the sheet — fill them in the UI to light up utilization + interest. Business
cards (AMEX Business Gold AMZ/SS) are deliberately excluded — they live in the business plan.

## Migration

`scripts/turso-migrate-personal-finance.mjs` (idempotent): adds `scope` everywhere + the
personal fields + the two new tables. Additive, so the deployed business code keeps working.

## Phase 2 (next)

Net-worth dashboard (assets − liabilities); Credit Karma MCP (live score + utilization);
payoff plan (avalanche / snowball) + loan amortization (the `Debt` apr/termMonths fields);
full distribution-from-business bridge; auto-import of transactions/receipts.
