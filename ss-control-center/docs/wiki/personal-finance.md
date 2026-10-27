# Personal Finance (Phase 1)

> Treasury integration (2026-10-27): [Treasury module](../../../docs/wiki/treasury-module.md).
> The FREE share is deliberately **not set** by the owner's 11:23 ET decision;
> no automatic transfer is enabled. The deployed bridge supports atomic draws,
> and the personal waterfall keeps reserve zero. The business percentage-reserve
> calculation is temporary and unapproved; its replacement period is undecided.

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

## Phase 2 — obligations registry, net worth, payoff plan (2026-10-27)

Owner's brief (Telegram topic 728, 2026-10-27) + Jackie's reconciliation addendum the
same day. Goal: one readable, reproducible picture of everything owed, with an owner,
a status badge, and **a date + source on every amount** — no invented numbers.

### Data model (additive — `scripts/turso-migrate-personal-registry.mjs`, applied)

- `Debt` + `CreditCard` gained: `balanceAsOf`, `balanceSource`, `balanceNote`,
  `standing` (badge), `standingSince`, `standingNote`, `alert` (red warning),
  `nextDueDate`, `registryKey`. Debt also: `creditor`, `entity` (legal debtor),
  `accountRef`, `amountKnown` (false = balance unknown, never shown as $0),
  `maturityDate`. Card also: `minPaymentDue` (real statement minimum), `closed`.
- `ObligationEvent` — dated points a day-of-month rule can't express: court
  installments, mediation, the IRS payment-plan window (`date..endDate`), a one-off
  payment that replaces a card's minimum on that day (BJ's full statement).
- `PersonalAsset` — the asset side of net worth (bank accounts; vehicles once valued).
- Badges (`STANDINGS`, most urgent first): Court · Past due · Collections · Dispute ·
  Window · Needs check · Paying · Current.

### Rules

- **Both pools in one view.** Business-plan debts (Parafin, Amex ×2, Uline, IRS 2024/25,
  Lendistry, EGK, factory) are the owner's obligations too; they are **updated in place**
  and shown in the personal registry with "Business plan", never copied — a copy would
  make both plans count the same Parafin installment.
- **Unknown stays unknown.** Unknown limit / APR / minimum / balance shows "not set";
  totals count unknown balances separately and never sum them. The Phase-1 seed's
  invented "2% / $35" minimum rule was dropped from every card.
- **Not counted ≠ deleted.** Cards from the June sheet that no current source confirms
  are `active=false`, badge Needs check, listed at the bottom, excluded from totals.
- **Every edit is dated.** A changed balance/value without its own date + source is
  stamped `today · Manual entry` by the API.
- **Owner is required** on debts and cards (API rejects an empty owner).
- Unknown-balance installment debts (BMW loans) accrue their payment uncapped
  (`accrual.ts`), and paying them never auto-settles the debt.

### Pure libs (tested in `scripts/check-personal-finance.ts`)

- `registry.ts` — `cardToLiability` / `debtToLiability` (one `Liability` shape),
  `sortLiabilities`, `registryTotals` (by owner / badge / pool), `netWorth`
  (assets − known counted liabilities, per owner), `collectAlerts`.
- `payoff.ts` — `simulatePayoff(debts, budget, strategy, startYm)`: monthly interest
  (APR/12; unknown APR = not modeled and reported), all minimums, the rest to the
  first debt in order; avalanche = highest APR first (unknown last), snowball =
  smallest balance first. Same inputs → same plan.
- `calendar.ts` — adds one-offs, open windows, `startFrom` (skip a paid month),
  unknown amounts, and `supersedes` (a payment replacing a minimum).

### UI (owner-only, `/personal/*`)

- `/personal` — warnings, Net worth · Total owed · Late now · Due next 60 days, then a
  60-day calendar: late items on top in red, windows highlighted, court dates, and
  "recurring, date not fixed" (Parafin biweekly — no anchor date known).
- `/personal/obligations` — the registry by badge, filters by owner/badge, EGK's
  8 invoices grouped, each row expands to notes, linked dates (mark done) and edit.
- `/personal/plan` — avalanche/snowball toggle, monthly budget, include/exclude.
  Excluded by default: disputes, court, needs-check, unknown balances.
- `/personal/net-worth` — assets (editable, dated), liabilities by pool, per-owner net.

### Data as of 2026-10-27 (`scripts/seed-personal-registry-2026-10-27.mjs`, idempotent)

Sources: the owner's brief (Plaid 27.10 cards, debts list), Jackie's server files
(`data/bills/bills.json`, `wiki/business/business-debts.md`, `memory/tax_debts_2024_2025.md`,
`memory/irs_tax_debt_2024_status.md`, Plaid snapshot `credit-score-vladimir/data.json`).
Result on prod: 35 counted obligations, **$255,267.60 known + 2 unknown** (BMW X3, BMW
moto), 6 warnings, 2 late (Credit One AmEx 3989, BMW X3). APR is known only for WF Reflect
(28.74%) and Lendistry (11.69%) — the payoff plan says so. Personal bill meters were
restarted on 2026-10-27 (they had ticked since June with no payments → ~$43.8k phantom
"Needed"); three bills (BMW ×2, SBA) became Debt rows.

### Open (needs the owner / Jackie)

EGK and factory balances are June figures (Jackie reconciles from bank + mail); SBA EIDL
balance; BMW X3 balance and payment; Amex 01001 installment amounts and court costs;
APRs for every card; whose card Victoria's Secret 1548 is; the 6 not-counted June cards;
Parafin's biweekly anchor date.

## Later

Credit Karma MCP (live score + utilization); loan amortization (`termMonths`); full
distribution-from-business bridge; auto-import of balances from Plaid / transactions.
