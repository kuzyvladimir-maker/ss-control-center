# G5 scope-only apply evidence — 2026-07-26

## Owner boundary

The owner authorized exactly one production action in chat:

> Да, разрешаю записать 5935 позиций наших каналов продаж в
> ProductTruthListingScope. Других production-действий не разрешаю.

This approval did not authorize canonical cost recomputation, promotion of legacy
truth, provider or paid calls, consumer activation, marketplace mutations,
repricing, delisting, procurement, or purchases.

## Immutable inputs

- authoritative manifest:
  `phase1-authoritative-scope-manifest/v3`;
- manifest SHA-256:
  `94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c`;
- plan ID:
  `g5-authoritative-scope-backfill-20260726t1840z`;
- canonical plan SHA-256:
  `162b2dbd35eba6b239b1e643543ee585deb6fbd7d9045081a4ea10b9ee53cf78`;
- owner approval ID:
  `g5-scope-backfill-owner-approval-20260726t214511z`;
- owner approval SHA-256:
  `9a68a95481edcc759b514c0c631c2ae09a3859c57e1b581988c883e118fa6759`;
- database target fingerprint:
  `57ff2af9adb3e963dbaf944c047130132dcd9cbb2e35ed789d6100b0f7e30003`.

The approval explicitly set:

- `allowScopeImport = true`;
- `allowCanonicalCostRecompute = false`;
- `allowLegacyTruthPromotion = false`.

## Apply result

The exact clean-checkout `backfill-apply` completed with status `APPLIED`.

- planned scope imports: `5935`;
- inserted scope rows: `5935`;
- exact existing scope rows: `0`;
- exact manifest scopes after apply: `5935`;
- missing, conflicting, or unexpected listing keys: `0`;
- active Product Truth writers: `0`;
- foreign-key violations: `0`;
- canonical cost recomputes: `0`;
- legacy truth promotions: `0`;
- provider calls: `0`;
- paid calls: `0`;
- marketplace or procurement mutations: `0`.

Immutable apply artifacts:

- report byte SHA-256:
  `d0974ce9840f68773649437171743478ed678f30705400d10d13cd76660fab9d`;
- report semantic SHA-256:
  `58c791af29d2ef42f297eb41919fd4f3e30a368059c849992740ce3a1eb1585a`;
- artifact-index SHA-256:
  `34d5869e73d53ce74809dfd11e20f187e515388f54b04d322d495083f5c5fc27`;
- post-state SHA-256:
  `f393bbf10e36016b53033e41379fb3da03aff72ebe52dbae1c1777e0daa06184`.

## Post-apply full-denominator readiness

A separate read-only readiness run reconciled all `5935` authoritative listings.
It performed `0` database writes and `0` provider calls.

Readiness at `2026-07-26T21:50:00.000Z`:

- Bundle Factory: `0 ready / 5935 blocked`;
- Listing Improvement: `0 ready / 5935 blocked`;
- Unit Economics: `0 ready / 5935 missing`;
- Procurement: `0 ready / 5935 blocked`;
- consumer cutover: `0/4`;
- blocker on every scope:
  `CURRENT_SCOPED_SKU_COST_MISSING`.

Immutable readiness artifacts:

- readiness report byte SHA-256:
  `0d4edf9cf9d25c6f29562336a5e03caff8eceedbdd7e87f7196627eef991a8d9`;
- readiness payload SHA-256:
  `3baf61c2616c28395afde6e7f9593cbb74d181d77e78c47a1374913bf6ce16d1`;
- readiness artifact-index SHA-256:
  `600bf82699a89931a24ee32577a4ea3abbc790bdb7d5e69885ec0b06c2fcf096`.

## Meaning

G5 established the canonical sales-listing denominator in production. It did not
turn mutable legacy `DonorProduct`, `SkuComponent`, or `SkuCost` rows into Product
Truth. The next safe work is a no-paid, evidence-bound canonical materialization
plan from already held source evidence. Any database apply of that plan needs a new
exact owner gate. Paid gap enrichment and consumer activation remain later,
independent gates.
