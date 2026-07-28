# Uncrustables Amazon text/structured rollout — 2026-07-18

## Outcome

- Marketplace: Amazon US (`ATVPDKIKX0DER`), store index `1`.
- Immutable repair plan: `URP-20260718T083203612Z`, canonical seal `8badb989fc9bc5ee9c7ced63029ef9c8cea01d1b494c5766330709dfcf17c477`.
- Exact execution scope: 162 SKU, 324 actions.
- Allowed action kinds: 162 `TEXT_COUNT` and 162 `STRUCTURED_ATTRIBUTES`.
- Forbidden in this rollout: every `OFFER` path and every `MEDIA` path, including MAIN and gallery slots 1–8.
- Forward apply ran from `2026-07-18T11:25:13.907Z` through `2026-07-18T12:10:58.452Z`.
- Result: 318 unique real PATCH submissions plus 6 same-plan resumed/revalidated actions; 324/324 terminal-complete.
- No duplicate `SUBMITTED` action IDs, no `FAILED`, no `SETTLEMENT_UNRESOLVED`, and no OFFER/MEDIA `SUBMISSION_ARMED` or `SUBMITTED` events.
- Independent live postcheck ended at `2026-07-18T12:13:29.175Z`: all 324/324 actions were freshly read from Amazon and matched desired state. The postcheck made no real PATCH calls.

This completion applies only to the sealed 162-SKU text/structured scope. It is not evidence that all 164 listings, pricing, MAIN images, or galleries are final.

## Immutable fallback artifacts

1. Forward selection:
   `data/repairs/execution-selections/uncrustables-text-structured-162-20260718-v1/URES-20260718T111837966Z-1d8786c0422c.json`
   - canonical seal: `1d8786c0422c8a663defa81fa95b2871169091a1b46a6c25160dcda57794bfc0`
   - byte SHA-256: `38b23e7ba328882c2a0617d2b8236b06b9e3632cb5bceac870d3e819d95e641e`
   - profile: `TEXT_STRUCTURED_ONLY_V1`

2. Selection-scoped inverse plan:
   `data/repairs/rollback/final-162-v8-text-structured-v1-preapply-20260718T1118Z/UARP-20260718T111858370Z-8badb989fc9b-6c92bd0150c6.json`
   - canonical seal: `6c92bd0150c6c591a53b92701fd0a0eae076830937e255a9298338dd842f538a`
   - byte SHA-256: `aa3cb8f6ed07799bb1087ca96021a72f13dc61e8c9ae0b2731acb6071bbc7773`
   - coverage: 162 entries, 324 selected actions, 1,137 inverse operations
   - contains zero OFFER/MEDIA actions and zero price/media paths
   - path-level compare-and-swap is required before every inverse mutation

3. Live pre-change snapshot bound to the inverse plan:
   `data/repairs/rollback/final-162-v8-content-v3-preapply-20260718T1036Z/UAPS-20260718T103756854Z-46a80e727880-e935338955d7.json`
   - canonical seal: `e935338955d716ce28ab00d08cf1f7d4c92702ed19a76b89d0872fbad24bb190`
   - byte SHA-256: `d7c8988495fa41c092fb05c7bd9c89873504b336115ea2e7dfe37b74f8901099`
   - exact live scope: 164/164 SKU and ASIN identities

The selection-scoped inverse plan is the fallback for this rollout. Do not use a full-plan rollback to undo only this text/structured rollout: it could revert unrelated content or collide with open OFFER/MEDIA submissions. Rollback remains an explicit, dual-confirmation operation and must pass current path-level compare-and-swap checks; do not bypass those checks.

## Late submissions resolved after the rollout

Both accepted submissions remained open during the text/structured rollout and were quarantined from it. They later converged to their exact desired states and were closed only by stable read-only recovery. No repeat PATCH or rollback was sent. With pending submissions at zero, the persistent marketplace fence was released; there is no active execution lease.

1. `AC-AS4J-B64F:offer`
   - kind: `OFFER`
   - submitted event: `560c9364-bd97-4a28-9266-3516e7259e55`
   - exact patch SHA: `e9e745c87ff1c67657c0506980aaaf2418b78eab3d50d5ea3c9abd76223b423f`
   - exact paths: `/attributes/list_price`, `/attributes/purchasable_offer`
   - final state: `DESIRED`; three stable GETs observed B2C and B2B at `$76.99`, minimum `$66.95`, maximum `$76.99`, no discounted price, and no list price
   - recovery action: append-only `VERIFIED`; no repeat PATCH

2. `AD-AS4H-QXZD:media`
   - kind: `MEDIA`
   - submitted event: `3547615d-2ea0-4167-97da-9a8caab9f562`
   - exact patch SHA: `51fe86a1daf6d04cad8cf7a03a77606bb04b913c219d9d470ad25fce66f78b0a`
   - exact paths: `/attributes/other_product_image_locator_1` through `/attributes/other_product_image_locator_7`
   - final state: `DESIRED`; three stable GETs observed exact target slots 1–5 and absent slots 6–8; MAIN was unchanged
   - recovery action: append-only `VERIFIED`; no repeat PATCH

## Gallery canary opened after the rollout

`AZ-ASMY-VEQ2:media` was submitted once under the sealed
`GALLERY_MEDIA_ONLY_V1` selection after a fresh, selection-scoped rollback
capture. Amazon accepted the PATCH, but the listing remained in the exact
pre-write gallery state throughout the bounded observation window.

- execution selection:
  `data/repairs/execution-selections/uncrustables-gallery-media-remaining-118-20260718-v1/batch-01-canary-az/URES-20260718T125000000Z-9da5ddee4b99.json`
- selection seal: `9da5ddee4b991dcc550a68d5fcbd13c08e60388ae4c3eb268d28f9e9b974d19b`
- fresh snapshot:
  `data/repairs/rollback/gallery-canary-az-v1-preapply-20260718T130237Z/UAPS-20260718T130501039Z-46a80e727880-6918d42bf7eb.json`
- snapshot result: exact 164/164 SKU/ASIN scope, 248/248 image binaries captured, zero image failures
- selection-scoped inverse plan:
  `data/repairs/rollback/gallery-canary-az-v1-preapply-20260718T130237Z/UARP-20260718T130501314Z-8badb989fc9b-62410042c825.json`
- rollback coverage: one SKU, one `MEDIA` action, seven inverse operations; zero MAIN/OFFER/TEXT/STRUCTURED paths
- submission event: `5bb1992e-17aa-4bfd-86c7-5e0d15a376b6`
- actual PATCH SHA: `7b41327eebc2e0c1a180817d1e7d3a34c07eeee3ce7d3f6a58cef0197f0957ac`
- exact paths: `/attributes/other_product_image_locator_1` through `_7`; `main_product_image_locator` was forbidden by the execution profile
- terminal observation at `2026-07-18T13:39:00.950Z`: `SETTLED_BEFORE` after 60 consecutive stable reads of the exact sealed pre-write path digest
- safety disposition: submission remains open because a delayed apply cannot be excluded; no second PATCH, fallback, or rollback was attempted; the persistent marketplace mutation fence remains present

## Remaining blockers before claiming 164/164 ideal

- `TY-AST2-JE9P` remains excluded from live text execution because Amazon `VALIDATION_PREVIEW` rejected the corrected title with catalog-conflict code `8541`. The catalog title says `2 oz Each`, while the sealed recipe combines a 2 oz Raspberry item with a 2.8 oz Morning Protein Mixed Berry item. Offer, gallery, and structured previews were valid, but preserving the locked title would preserve a false all-items weight claim.
- `VN-AS1A-D572` remains excluded because Amazon `VALIDATION_PREVIEW` rejected the reviewed 45-count correction with catalog-conflict code `8541`. Internal evidence agrees on 45 individual sandwiches (VariationMatrix quantity, BundleDraft pack count, MasterBundle pack count, and recipe sum), while the catalog has `unit_count=180` from the legacy `4 ct - Pack of 45` wording. This requires a catalog correction/appeal or ASIN replacement before it can be called truthful.
- MAIN image actions are not present in the final repair plan. Approved style samples are not authenticity/publish permits for 164 SKU-specific hero images.
- The bulk MEDIA/gallery rollout is not complete. AD is the only one of 119 planned gallery changes that has been applied and verified. AZ has one accepted but still-open submission with no visible change; the other 117 have never been submitted.
- The bulk OFFER/price rollout is not complete. AC eventually converged to the target after a multi-hour delayed projection. The earlier `$76.22` was the prior 1%-discount/account state, not a mandatory Amazon equality restriction; no other price actions were submitted in this rollout.
- The sealed gallery plan does satisfy the requested image-count structure: MAIN, the fixed price/customer card, and 4–6 additional product/context images. However, the fixed card explains the higher price but does not literally contain “Thank you for your purchase”; it ends with “Warmly, the Salutem Solutions Team.” A revised owner-approved card or an explicit acceptance of that wording is still required before calling the media set ideal.

## Offline gallery readiness audit

- Full 164-SKU gallery plan: 44 `KEEP` and 120 `REBUILD`.
- Final safe 162-SKU scope: 43 `KEEP` and 119 `MEDIA`; after the verified AD canary, the operational state is 44 compliant, one accepted/open AZ action still showing its old gallery, and 117 actions never submitted, assuming no subsequent Amazon drift.
- Exact set equality was proven between final-v8 `MEDIA` actions and the full gallery rebuild set intersected with the 162-SKU safe scope. TY is excluded and requires a gallery rebuild; VN is excluded but its current gallery is `KEEP`.
- Every desired gallery contains exactly one fixed card in gallery slot 1 plus 4–6 product/context images. Across the 164 rows, every locally mirrored asset exists and matches its recorded SHA-256; all validation records pass.
- The final-v8 media patches touch only `other_product_image_locator_1` through `_7`; no patch contains `main_product_image_locator`.
- MAIN remains an independent workstream. Current evidence supports 130 `KEEP` and 34 `REPAIR` decisions. The hardened production-readiness artifact now partitions those 34 repairs as `0 REUSE_EXACT_GOOD`, `5 BLOCKED_REUSE_QA`, `28 GENERATE_GPT_IMAGE_2`, and one TY identity block. Original-resolution re-audit found `VH-ASHZ-TJEE` depicts 28 units for a 24-unit recipe, `ZE-AS5W-FKH3` depicts 16 for 24, and `PJ-ASDX-E8LW` contains five gel packs rather than four. `RM-ASCV-DVA5` has a genuine retailer badge that conflicts with the current no-retailer-mark contract, and `RL-AS64-Q8QX` uses altered/carton-derived pouch art rather than the reviewed genuine wrapper presentation. Every one of the five prior reuse donors is now explicitly blocked by an exact asset-bound finding.
- The latent reference-routing defect is fixed in the local readiness builder. Product identity model inputs now come only from a unique presentation-specific production-registry `selected_reference`; official carton identity art cannot fall back into a wrapper input, and the owner-approved style fixture is a separate style-only model input. The AJ regression proves that its second component uses wrapper SHA `846005feea2a43108672aa5d4c65f272511d4332c5f7d449ba2ee437633c4e2b` and never carton SHA `9d36138ccb6069872bea6d9605aba73a7054f72b3ce268354bace975c3e51ae2`. All 28 generation candidates remain `generation_allowed=false`, so no Image 2.0 call, asset upload, database write, or Amazon write was authorized.
- Hardened MAIN artifact: `data/audits/uncrustables-main-production-readiness-20260718-v1.json`; body seal `ac370a044c2d574c4cb14c3fa530f5e167de9bbc184f463fd4a36e6d22d6f2b0`, file SHA-256 `0c30132230ace1eaabd9806a92529c6f43ba2b57c5d0816b66cfe8a51971f9ac`. A repeated build reproduced the same bytes.
- The apparent 12-flavor registry gap is actually 10 missing exact flavor records plus presentation-art gaps. A safe carton-only registry expansion would make at most 10 of 28 candidates reference-ready; 18 non-integer-carton candidates still require exact reviewed wrapper evidence and must not be synthesized from carton art.
- Before any remaining gallery batch: perform a fresh live GET, create a batch-scoped snapshot and inverse plan, validate compare-and-swap assumptions, and assert MAIN unchanged. Use immutable MEDIA-only selections and terminal stable-read verification between batches.

## Offline offer-model reconciliation

- All 162 sealed `OFFER` actions were independently recomputed from `number_of_items` through `src/lib/pricing/cost-model.ts`.
- Distribution: 93 × 24-count, 20 × 30-count, 19 × 45-count, 16 × 90-count, and 14 × 120-count.
- Result: 0/162 mismatches for consumer price, business price, minimum allowed price, maximum allowed price, discounted-price absence, or list-price absence.
- `KP-ASYC-RN84` is the only special unit semantic: it remains Amazon product type `PASTRY`, so `unit_count=252 Ounce` represents 90 sandwiches × 2.8 oz while `number_of_items=90`. Its `$252.99` / `$219.57` price model is correctly based on 90 sandwiches, not 252 units.
- This is a mathematical/offline reconciliation only. It does not authorize bulk OFFER submission before additional delayed-projection canaries and a fresh selection-scoped rollback.
- The local OFFER executor is now explicitly two-phase. `SUBMIT_ONLY` permits one physical mutating PATCH (`retries=1`) under a 60-second abort boundary and performs no post-write GET; an ambiguous timeout/error remains `SUBMISSION_ARMED` behind the persistent fence and can never trigger an automatic replay. `SETTLE_ONLY` exposes no write capability, polls pending submissions round-robin for up to the selected horizon, and closes only the exact submitted event after three stable `DESIRED` reads. Stable `BEFORE`, stable `NON_DESIRED`, read errors, and timeouts remain pending. The current AZ MEDIA pending submission blocks every OFFER submission before the first Amazon call.

## Verification record

- TypeScript: `tsc --noEmit` passed.
- Final full Uncrustables suite after strategy hardening: 150/150 passed.
- Final surgical subset: 34/34 passed.
- Post-hardening OFFER/transport suite: 60/60 passed, including one-physical-PATCH, lost-response, AbortSignal, cold seller lookup, 429 backoff, exact pending-selection binding, persistent fence, and GET-only settlement cases.
- Hardened MAIN readiness suite: 5/5 passed; production preflight suite: 5/5 passed; deterministic rebuild reproduced the recorded artifact seal.
- The OFFER quarantine accepts only `SELECTOR_REPLACE_SURROGATE_FOR_MERGE`; MEDIA accepts only `PRIMARY`.
- Quarantine additionally requires exact same-plan action identity, exact recorded patch SHA, exact path list, planned path-boundary containment, and zero overlap with the selected text/structured paths.
- Checkpoint journal for this rollout: 2,240 immutable events, 318 unique submissions (159 text + 159 structured), zero duplicate submissions, zero failures, zero unresolved settlements, and exactly two quarantine events for the two open submissions above.
- Independent audit validated all 2,739 same-plan journal files present at the text/structured postcheck, with zero invalid or tampered hashes. Later read-only recovery closed the earlier AC and AD submissions and temporarily reduced pending to zero. The later AZ gallery canary opened a new accepted submission: there is currently no active execution lease, but the persistent mutation fence remains by design until AZ receives a safe late-settlement disposition.
