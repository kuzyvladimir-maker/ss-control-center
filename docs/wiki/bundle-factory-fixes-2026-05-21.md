# 🔧 Bundle Factory — Post-2.5 Fixes (2026-05-21)

> **Started:** 2026-05-21 · **Status:** Shipped (4 bug fixes + UPCPool seeding + 1 new resolver + E2E smoke)
> **Spec:** post-distribution cleanup driven by E2E smoke test findings

---

## TL;DR

After Phase 2.5 shipped, an end-to-end smoke test (`scripts/smoke-bundle-factory-e2e.ts`) exposed four issues that didn't show up under unit tests but blocked happy-path E2E runs. This page collects the fixes plus a couple of supporting changes (UPCPool top-up, browse-node resolver, vision-check skip flag, validator isolation).

## Fixes

### 1. Mock research fixture: 3 → 6 items (`perplexity.ts`)

The `MOCK_RESEARCH_RESPONSE` fixture (used when `PERPLEXITY_API_KEY` is unset in dev) returned only 3 mock products. Phase 2.2 variant types `MIXED_FLAVOR` (3-way + 4-way splits) and `CROSS_BRAND` (≥3 distinct brands) require a deeper pool to exercise their code paths. Bumped to **6 mock products** (Oscar Mayer, Bird's Eye, Eggo, Lean Cuisine, Ben & Jerry's, Stouffer's) so dev happy-path runs all four MIXED variant shapes without hitting Perplexity.

Side effect: now possible to develop the entire Bundle Factory pipeline locally without a real `PERPLEXITY_API_KEY` — useful since the key is paid-per-call.

### 2. UPCPool seeding — 0 → 3934 entries

The pool started empty in dev. `validator-upc-format` (Phase 2.4) and `promote-draft.reserveUpc()` (also Phase 2.4) both depend on `UPCPool.status='AVAILABLE'` having free rows for the requested prefix. With an empty pool every PASSED validation failed at promote time.

Seeding now has two stages:

**Stage A — real ASSIGNED UPCs (934 entries):**
* Source: SP-API `GET_MERCHANT_LISTINGS_ALL_DATA` report across STORE1 + STORE2 + STORE3.
* Fetcher: `scripts/fetch-active-listings.ts` (calls `requestAndWaitForReport` from `@/lib/amazon-sp-api/reports`).
* These rows land as `status='ASSIGNED'` linked back to their live ASIN so the validator can detect "this UPC is already in use, can't reassign".

**Stage B — AVAILABLE top-up (3000 entries):**
* Script: `scripts/seed-upc-pool-available.ts`.
* 3 prefixes × `DEFAULT_PER_PREFIX = 1000` each = 3000 fresh GS1-valid UPCs.
* Prefixes: `742259`, `789232`, `617261` (Vladimir's allocated GS1 ranges).
* Status set to `AVAILABLE`; `reserveUpc()` atomically flips to `ASSIGNED` at promote-time.

Total: **934 ASSIGNED + 3000 AVAILABLE = 3934 rows**.

### 3. `PreconditionError` class — 409 instead of 500 (`errors.ts`)

Before: every precondition failure (e.g. "draft must be at status=GENERATED to image-generate") threw a plain `Error`, which the route handler turned into a generic 500. Made the UI think the server had crashed when really the operator just clicked the wrong button.

After:

```typescript
// src/lib/bundle-factory/errors.ts
export class PreconditionError extends Error { /* → HTTP 409 */ }
export class NotFoundError    extends Error { /* → HTTP 404 */ }
```

Route handlers now map these to **409** (precondition / wrong state) and **404** (missing draft / sku / pool item) respectively. The UI surfaces the message verbatim instead of swallowing it.

### 4. `browse-node-resolver.ts` — auto-assign Gift Basket Exception

New module that decides the Amazon `browse_node` for a bundle. For now it resolves to the multi-brand Gift Basket Exception node (`12011207011`, "Food Assortments & Variety Gifts (primary)") in all current paths:

```typescript
// src/lib/bundle-factory/browse-node-resolver.ts
export const DEFAULT_GIFT_BASKET_NODE = GIFT_BASKET_EXCEPTION_NODES[0]; // "12011207011"

export function resolveAmazonBrowseNode({ distinct_brands }): string {
  // multi-brand → GBE (required by Amazon policy)
  // single-brand → GBE for now until per-category Brand Registry mapping lands
  return DEFAULT_GIFT_BASKET_NODE;
}
```

The resolver is consumed in two places:

* `content-pipeline.ts:198` — passes the resolved node into compliance Rule 5 (browse-node-for-multi-brand) so the gate doesn't false-flag during Phase 2.2 generation.
* `promote-draft.ts` — writes the resolved node onto the `ChannelSKU` row at promote-time so Phase 2.5 distribution can include it in the listing payload.

**TODO** (not part of this fix): per-category Amazon browse-node IDs for single-brand bundles, pulled from Brand Registry. Until then single-brand also uses GBE, which works but isn't optimal for organic discovery.

## Supporting changes

### Smoke test (`scripts/smoke-bundle-factory-e2e.ts`)

End-to-end script that walks one BundleDraft through Phase 2.1 → 2.5 (mock-Perplexity, stub-Claude, real DB, R2 disabled via env). Parameterized: runs both `SINGLE_FLAVOR` and `MIXED_FLAVOR` cases. **Both cases pass 14/14 steps** as of fix landing — covers brief create → research → variation → content → image (vision-check skipped) → validation → promote → publish (dry-run).

This is the canonical happy-path regression check; run it before any Bundle Factory PR merges.

### `BUNDLE_FACTORY_VISION_SKIP` env flag

`audit/vision-check.ts` honours an env var that short-circuits Anthropic Vision calls. Used by the E2E smoke when the image URLs are mock R2 paths that Anthropic Vision can't actually fetch. Set `BUNDLE_FACTORY_VISION_SKIP=1` in dev / CI; **never set in production** — it defeats Phase 2.0 Rule 6.

### Validator isolation (post-fix to Phase 2.4)

Already covered in [phase-2-4-validation.md](phase-2-4-validation.md), but the wrapping happened here as part of the E2E hardening pass. Net behavior: one thrown validator no longer aborts the whole pipeline; it degrades to `severity: 'warning'`. Exception: `validator-compliance-rerun` is intentionally fail-CLOSED (errors abort, by design).

## Files touched

* `src/lib/bundle-factory/perplexity.ts` — fixture expanded
* `src/lib/bundle-factory/errors.ts` — NEW (`PreconditionError`, `NotFoundError`)
* `src/lib/bundle-factory/browse-node-resolver.ts` — NEW + `__tests__/browse-node-resolver.test.ts`
* `src/lib/bundle-factory/content-pipeline.ts` — calls `resolveAmazonBrowseNode`
* `src/lib/bundle-factory/validation/promote-draft.ts` — calls `resolveAmazonBrowseNode`
* `src/lib/bundle-factory/validation/validation-pipeline.ts` — per-validator try/catch
* `src/lib/bundle-factory/audit/vision-check.ts` — `BUNDLE_FACTORY_VISION_SKIP` env honoured
* `src/lib/bundle-factory/api-utils.ts` — error → HTTP code mapping (409, 404)
* `scripts/fetch-active-listings.ts` — NEW (SP-API report → TSV)
* `scripts/seed-upc-pool-available.ts` — NEW (3000-row top-up)
* `scripts/smoke-bundle-factory-e2e.ts` — NEW (E2E happy-path)

## Operator runbook — UPCPool top-up

```bash
cd ss-control-center

# Stage A — only when adding a new store / refreshing real assignments
npx tsx scripts/fetch-active-listings.ts          # → data/imports/Active_Listings_Report_<date>.txt
npx tsx prisma/seed/upc-pool-import.ts            # loads TSV into UPCPool as ASSIGNED

# Stage B — top up AVAILABLE when validator-upc-format starts failing
npx tsx scripts/seed-upc-pool-available.ts        # 1000 per prefix, 3 prefixes
```

Pool depth check (via Prisma Studio or quick query):

```sql
SELECT prefix, status, COUNT(*) FROM "UPCPool" GROUP BY prefix, status;
```

If any `AVAILABLE` count drops below ~50, run Stage B again.

## Vladimir's to-do list after merge

1. **Run the smoke** after pulling: `cd ss-control-center && BUNDLE_FACTORY_VISION_SKIP=1 npx tsx scripts/smoke-bundle-factory-e2e.ts`. Should print `14/14 PASS` for both SINGLE_FLAVOR and MIXED_FLAVOR cases.
2. **Don't put `BUNDLE_FACTORY_VISION_SKIP=1` on Vercel** — it would silently disable Rule 6 in production.
3. **UPCPool top-up** is a once-every-few-months job; the 3000-row buffer should last a long while at current bundle-creation pace.
