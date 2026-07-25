# Walmart Listing Integrity — pause checkpoint 2026-07-19

> **Status:** local one-SKU core is internally consistent and fail-closed;
> production apply, live canary and mass run remain **NO-GO**. This checkpoint
> was created before pausing to preserve subscription limits. It is an
> operational snapshot, not a replacement for [[walmart-listing-integrity-platform]]
> or [[product-catalog-architecture]].

## Goal preserved

For every active Walmart SKU, the shipped product, exact variant, package facts
and quantity must agree with title, description, bullets, attributes, MAIN and
every gallery image. Every repair must then be proven on a fresh buyer-facing
reread without losing `PUBLISHED`, `ACTIVE` or catalog-search indexability.

## Completed and locally verified

1. **Exact surgical payload builder**
   (`listing-integrity-remediation-payload.ts`):
   - rebuilds one changed-fields-only `MP_MAINTENANCE` payload;
   - independently re-hashes fresh raw Get Spec and live-item bytes;
   - proves the exact SKU, numeric itemId, UPC/GTIN/EAN/ISBN, productType,
     seller account, `PUBLISHED` and `ACTIVE` before a permit can be used;
   - pins current spec `5.0.20260501-19_21_29-api`;
   - rejects clear-by-blank/null, unapproved fields, stale evidence and a
     caller's audit field path being used as Walmart write schema;
   - emits canonical payload/manifest bytes and an exact-byte rebuild verifier.

2. **One-SKU writer core**
   (`listing-integrity-remediation-writer.ts`):
   - reaches durable `REQUESTING` before transport/OAuth;
   - permits at most one maintenance POST and never automatically retries an
     unknown result;
   - rechecks fresh sequence readiness, Product Truth, current permit, plan,
     frozen verifier binding and account immediately before POST;
   - stores a definite accepted `feedId` before GET-only reconciliation;
   - uses collision-safe feed-status artifact names across process resume;
   - requires exact GET call accounting;
   - turns a stranded `REQUESTING` state into manual reconciliation with no
     transport and no repost;
   - requires a synchronous exact-byte verifier hook.

3. **Existing durable permit ledger and Qualification Officer** remain
   fail-closed. Qualification rebuilds the post-write source-aware audit and
   separately checks publication/indexing. Production pins/readiness flags are
   deliberately unset, so none of this code can perform a production write.

4. **Independent combined verification at pause:**
   - focused tests: **49/49 PASS**
     (`payload 11 + writer 13 + ledger 16 + qualification 9`);
   - targeted ESLint: **PASS**, zero warnings;
   - `git diff --check`: **PASS**;
   - external effects: **0 model calls, 0 Walmart calls/writes, 0 DB writes**.

## Honest unresolved blockers

### Canary-critical

1. A concrete content-addressed immutable artifact sink/loader is not yet
   implemented. The writer interface exists, but production must itself custody
   exact request, response and feed-status bytes; caller-supplied bytes cannot
   qualify a repair.
2. The apply evidence verifier still implements the older full-target manifest
   contract. It must consume the new surgical payload verifier plus exact
   ledger `ACCEPTED`, terminal and inventory evidence from custody.
3. Target MAIN/gallery assets are URL+SHA in the plan, but are not yet bound to
   exact Product Truth image lineage, rights evidence, represented unit count,
   exact bytes and signed vision-worker receipts. A repair that changes images
   must remain blocked until this certificate passes.
4. No frozen production dependency factory or native zero-retry multipart
   transport exists. The production writer pin remains `null` by design.
5. A fresh authoritative ITEM v6 population and fresh buyer/Product Truth
   capture still have to be assembled before the read-only pilot and owner
   one-SKU permit.

### Required before controlled waves

6. The current ledger embeds a cumulative event inventory in a 1 MiB head. It
   is safe for a tiny sequential canary but cannot cover the 1,458-SKU catalog:
   the measured fully terminalized capacity is roughly 920 permits. It also
   needs cross-permit receipt refresh and deterministic crash-lock recovery.
   Replace it with a constant-size commitment or segmented append-only design
   and prove >10,000 terminalized permits before any wave.
7. Mixed bundles/variety packs still require a Product Truth component-aware
   visual contract; the current strongest automatic audit is for
   `same_product` listings.

## Exact restart order

1. Implement immutable artifact custody and integrate it with the writer.
2. Replace the legacy apply-evidence path with custody-loaded surgical evidence.
3. Add target-image certification and make it mandatory during plan rebuild.
4. Freeze the dependency factory/native zero-retry transport; keep the
   production pin unset until integrated adversarial tests pass.
5. Capture fresh authoritative sources, run a small read-only pilot, then ask
   for a separate owner permit for **one** live canary.
6. Complete 1–3 canaries through
   `detect → repair → propagation → fresh reread → Qualification PASS`.
7. Before waves, replace/certify the scale-limited ledger.
8. Only after proven canaries connect the backend to
   **Walmart Growth → Listing Integrity**.

## Resume safety

- Do not use `src/lib/walmart/multipack/remediate.ts` as the new runtime.
- Do not populate a production release pin merely to bypass `NO-GO`.
- Do not run a mass audit, model batch or Walmart write from this checkpoint.
- Claude Code remains an operator of the eventual frozen suite, not an editor
  or daily scheduler.

