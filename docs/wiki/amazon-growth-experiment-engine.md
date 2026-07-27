# Amazon Growth — Experiment & Learning Engine (design)

Status: **design / pre-implementation** (approved direction 2026-06-17). Build from this.
Related: `docs/wiki/amazon-growth-roadmap.md`, memory `project_amazon_growth`.

## Goal

An autonomous, **conservative** growth engine for our own-brand listings that:
proposes changes → rolls them out **with a control group** → measures **real,
market-adjusted lift** → keeps winners, reverts losers → **learns generalizable
rules** → applies them to similar listings → and **recovers lost winners**
(listings that used to sell and were changed/deleted).

This sits on top of what already exists (do NOT rebuild): per-ASIN Health Score +
Opportunity Score, the funnel (sessions/conversion/buy-box/units/revenue/returns),
the AI advisor (diagnosis + executable actions), the Change Log (before/after +
rollback), and the Optimizer / bulk-advisor apply paths.

## Locked decisions (Vladimir, 2026-06-17)

1. **Scope = our brands only: Salutem Vita + Starfit**, INCLUDING gift-set listings
   that contain third-party products (the listing is ours → eligible; brand rules
   still apply — third-party names factual only + curator disclaimer). Reseller
   listings of third-party brands are out of scope.
2. **Conservative** — control group mandatory, significance required, speed not a
   priority. Better slow than false conclusions.
3. **Recovery data** — historical sales pullable via API (verified ~2yr back, see
   below); Vladimir also has purchased multi-year exports as backfill/cross-check.

## The honest problem (why naive A/B fails here)

- Low traffic (5–15 sessions/day/listing); daily conversion swings 3%→45%. A clean
  sequential A/B on one low-traffic listing drowns in noise.
- Confounders: seasonality, competitors, buy-box loss. "Sales went up" ≠ "our change
  worked" without a control.
- Native Amazon "Manage Your Experiments" is Brand-Registry + higher-traffic only and
  **not reliably automatable via API** (UI feature) — verify, but don't depend on it.

**Therefore the statistical backbone is difference-in-differences with a matched
control group, and cohort pooling for power** — NOT naive before/after (which is what
the current Change Log outcome does, and it overstates/understates effects).

## Verified facts (probes, 2026-06-17)

- `GET_SALES_AND_TRAFFIC_REPORT` returns **historical** data ≥ ~22 months back
  (probe: ~12mo ago → 862 ASIN rows; ~22mo ago → 481 rows; both DONE). So we can pull
  historical per-ASIN sales ourselves.
- Caveat: the report's `salesAndTrafficByAsin[]` is **aggregated over the requested
  window** (not daily×ASIN). Daily×ASIN history = request one **1-day** report per day
  (one report covers all ASINs for that day) → cheap going forward (1/day) + backfill.
- **Business reports contain NO listing content** (title/bullets/images). Recovery of
  *content* comes from: Catalog Items API (ASIN still in catalog, even if our offer is
  inactive), our forward snapshots, or Vladimir's old flat-file/inventory exports;
  otherwise the listing is **rebuilt** (LLM, informed by what worked), not restored.

## Architecture (6 blocks)

- **A. Daily funnel history** — 1 Sales&Traffic report/day (CHILD) → per-ASIN daily
  rows. Trends, MoM/YoY, and the raw material for pre/post + control comparison.
- **B. Listing snapshots** — version title/bullets/images/attributes/price + the funnel
  at that time. The memory enabling diff-in-diff baselines AND recovery.
- **C. Experiment engine** — state machine per test:
  `PROPOSED → ASSIGNED(treatment+matched control) → APPLIED → BURN-IN → MEASURING → DECIDED(keep|revert|iterate)`.
  Burn-in waits for Amazon re-index AND verifies the change is live before the clock
  starts. Measurement = diff-in-diff vs control, significance + min-traffic gate.
- **D. Learning Store** — aggregate outcomes by `(change-type × category × leak-type)`
  → effect size + confidence + n (e.g. "drop promo adjectives → +6% conversion on
  grocery, n=40, p<0.05"). The advisor reads this to prioritize proven levers.
- **E. Recovery** — identify lost winners from historical sales (A + backfill) → fetch
  prior content (Catalog API / snapshot / export) → restore in one click, else rebuild.
- **F. Orchestrator + guardrails** — brand voice; margin floor (gated on COGS, parallel);
  eligibility classifier (brand-owned only); blast-radius caps (max concurrent
  experiments, never change >X% of a cohort, always hold a control); everything
  reversible; epsilon-greedy budget for exploration to avoid local maxima.

## Failure modes → mitigations

| Risk | Mitigation |
|---|---|
| Noise > signal (low traffic) | min-traffic gate; control group; diff-in-diff; cohort pooling |
| Seasonality/competitor/buy-box confounding | matched control + diff-in-diff; buy-box% as covariate |
| Multiple testing / p-hacking | pre-registered hypotheses; multiple-comparison correction; hold-out before generalizing |
| Amazon re-index lag | burn-in before measuring |
| Change rejected/altered | verify-live before starting the clock |
| Reseller / brand-gated | eligibility classifier up front |
| Catalog churn (ASIN deleted/merged) | reconcile vs Catalog each cycle |
| Learning over-generalizes (grocery→pet food) | segment learnings by category/cohort; validate before broad rollout |
| Cost/quota | Sonnet for proposals; 1 report/day; batching |

## Success scenarios

- Cohort learning: a lever proven control-adjusted on a cohort becomes a rule → confident
  catalog-wide rollout → measurable aggregate lift.
- Recovery: detect a stripped/changed once-top listing → restore winning version → sales recover.
- Compounding: richer Learning Store → sharper advisor proposals → rising win rate.

## Phasing — status (2026-06-18)

- **Phase 0 — BUILT.** AmazonAsinDaily (daily funnel; reports.runSalesTrafficWindow,
  daily-history.ts) + AmazonListingSnapshot (snapshots.ts, own-brand, hash-deduped) +
  lost-winners.ts (+ Catalog API brand resolution) + /history API + crons
  (amazon-daily-history, amazon-snapshots) + Recovery tab.
- **Phase 1 — BUILT.** diff-in-diff.ts (control-adjusted lift) + AmazonChangeLog DiD
  columns + measureChangesDiD (in daily cron) + Lift(DiD) column. Recovery restore:
  catalog.ts + rebuild-kit + restoreSnapshot (validated, logged, reversible).
- **Phase 2 — BUILT (running).** cron amazon-auto-improve (hourly): finds own-brand
  listings with a DETERMINISTICALLY-fixable problem (suppression / 99016 dedupe) and
  enqueues them for the safe remediation worker. Conservative, own-brand only,
  deterministic only, validated, reversible, DiD-measured. Other ERROR issues
  (18971/8541 = manual) are intentionally left alone. The propose→apply→measure loop
  now self-runs. (Full cohort experiment state machine for CONTENT variants — title/
  image A/B — deferred; current loop covers the safe structural levers.)
- **Phase 3 — BUILT.** learning-store.ts aggregates DiD outcomes by (changeType ×
  category) → proven levers; summarizeForAdvisor injects them into the advisor prompt
  (single + bulk). /learnings GET. Populates as measured changes accrue.
- **Phase 4 — NOT BUILT (by design).** Native Amazon "Manage Your Experiments" is a
  Brand-Registry UI feature, not reliably automatable via SP-API. Use it manually for
  the few highest-traffic brand ASINs; our own controlled diff-in-diff covers the rest.

## What runs automatically (crons)
- amazon-daily-history (09:20) — ingest latest day + trailing backfill + measureChangesDiD.
- amazon-snapshots (09:50) — version own-brand content.
- amazon-auto-improve (hourly :15) — enqueue safe fixes for own-brand fixable issues.
- amazon-remediation (every 2 min, pre-existing) — drains the queue, applies fixes.

## Notes / honest limits
- Lift numbers need data accrual: measureLift returns "insufficient" until ≥5 pre+post
  days and ≥30 sessions exist; the daily cron + Backfill 90d build that up.
- Auto-improve only does structural safe fixes; content rewrites & price stay manual/
  operator-triggered (brand-rule + COGS-margin gated). Conversion-content A/B = future.
