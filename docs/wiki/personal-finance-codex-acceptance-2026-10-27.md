# Personal Finance Phase 2 — Codex acceptance, 2026-10-27

Owner task: Telegram topic 728. Continue the existing `/personal` module after
Claude's handoff, verify production data first, finish and deploy the screens.
Architecture: [Personal Finance](../../ss-control-center/docs/wiki/personal-finance.md).

## Verified handoff

The handoff commit already contained all five screens, the additive migration,
and the applied seed. Codex queried Turso read-only before editing. No reseeding,
migrations or financial writes were performed during acceptance.

- 21 card rows: 15 counted, 6 retained for review; one counted card has zero balance.
- 21 open debts, updated business debts remain in their original pool.
- 35 nonzero/unknown obligations: recorded balances $255,267.60 plus two unknown
  BMW balances. No duplicated registry keys.
- 9 dated events, 6 asset accounts; active personal bills have reset accrual
  cursors dated October 27.
- Recorded assets $7,743.88; known net worth −$247,523.72. This excludes unknown
  debts and unvalued assets and includes stale/approximate balances flagged in the UI.

## Acceptance corrections

- All personal API methods now verify the current admin role at the handler,
  including ledger and income routes. Missing access cookies fail closed for
  personal pages and shared `scope=personal` endpoints.
- Payoff minimums retain `null`; missing minimums and APRs carry explicit model
  limitations. An empty selection is not reported as a 50-year payoff. Each
  selected balance carries its source and date.
- Card utilization uses the same known-limit cards in numerator and denominator:
  82% for the snapshot, rather than 119% computed using debts with unknown limits.
  Three missing limits, thirteen missing APRs on nonzero cards and one missing
  minimum are separately reported.
- Calendar entries preserve owner and amount evidence. A completed full-statement
  payment does not restore its minimum; a cancelled one does. Unresolved events
  older than 60 days and events marked missed remain in the overdue list. Exact
  card dates work without a recurring day. Scheduled totals explicitly exclude
  undated payments; the calendar uses the owner's New York date.
- Invalid financial values and dates in the registry return 400 before a write;
  blank/invalid asset or card balances can no longer silently become zero.
- Dashboard fetch failures produce an error; failed asset deletion is surfaced.

## Checks

- `node --import tsx scripts/check-personal-finance.ts`: pure calculations and
  calendar regression cases, including source/owner and payment completion.
- `node --import tsx scripts/check-personal-access.ts`: 47 unauthorized/invalid
  requests rejected, current owner read allowed, missing/stale access cookie and
  deleted-user cases covered. Fake DB only, no live financial writes.
- Existing finance core and accrual checks; TypeScript; ESLint over personal UI,
  API, changed libraries and tests.
- Production deployment and browser acceptance are recorded below after completion.

## Data still requiring reconciliation

EGK and factory remain active, with June balances awaiting Jackie's bank/mail
reconciliation. SBA, BMW balances/payment, court installment amounts/costs,
missing APRs and Parafin's biweekly anchor remain explicitly incomplete.
WF 9868 has a +$47.31 morning Plaid snapshot and a later overdrawn warning;
both evidence items are retained. IRS 2024's transcript discrepancy remains visible.
