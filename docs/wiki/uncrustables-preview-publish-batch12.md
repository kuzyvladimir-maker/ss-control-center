# Uncrustables preview→publish batch 1+2 (2026-07-23)

Owner order 2026-07-22/23: iterate preview listings to perfection, then publish
to Amazon store1 (Salutem Solutions, `A3A7A0RDFUSGBS`), then fold the proven
pipeline into Bundle Factory.

## What shipped

9 new mixed-flavor Uncrustables listings created end-to-end through the REAL
Bundle Factory path and PUT to Amazon (all ACCEPTED):

| SKU | ASIN | Recipe | Price |
|-----|------|--------|-------|
| ZV-AS8R-ZQVP | B0HB3VQPRK | 24ct PB + Strawberry + Grape (2×4 each) | $76.99 |
| MT-ASQN-YY3H | B0HB3VNF2Q | 24ct Grape 3×4 + Raspberry 3×4 | $76.99 |
| XK-ASBS-8T49 | B0HB3VKPH1 | 28ct Honey 10 + Chocolate 10 + Strawberry 2×4 | $82.99 |
| DT-AS2G-Y9CG | B0HB46JPTG | 28ct Bright-Eyed Berry 8 + Up & Apple 8 + WW Grape 3×4 | $82.99 |
| TC-AS0C-J5A3 | B0HB5G4RXG | 30ct Honey 10 + Hazelnut 3×4 + Grape 2×4 | $85.99 |
| GC-ASMX-MJXZ | B0HB3TFSTJ | 30ct Chocolate 10 + Hazelnut 2×4 + Raspberry 3×4 | $85.99 |
| MT-ASEZ-ZCBE | B0HB3VQBCG | 48ct Beamin' 8 + Burstin' 8 + Strawberry 4×4 + Grape 4×4 | $135.99 |
| UR-ASI5-ZFR5 | B0HB3WXWZQ | 54ct Honey 10 + Berry Burst 4×4 + Blackberry Boom 4×4 + WW Strawberry 3×4 | $144.99 |
| PP-AS42-RJ34 | B0HB5JVVCB | 60ct Honey 3×10 + Chocolate 3×10 | $153.99 |

Status 2026-07-23 evening: 9/10 BUYABLE (PP and TC cleared their 100521 review
same day). #10 — XL 90ct $252.99 (Honey 3×10 + Chocolate 2×10 + Burstin' 3×8 +
Beamin' 2×8), SKU CD-ASU4-85VB, ASIN B0HB7GV5DB — published through the same
conveyor and sits in the standard 100521 new-listing review.

## The conveyor (scripts, in order)

1. `scripts/_publish_batch12_stage1.ts` — GenerationJob → BundleDraft
   (draft_components with OFFICIAL smuckersuncrustables.com ingredients +
   allergen declarations; PB flavors = Contains Peanuts+Wheat / may contain
   Hazelnut+Milk; Hazelnut spread flavor = Contains Hazelnut+Milk+Wheat / may
   contain Peanuts) → GeneratedContent → real `runComplianceGate` (8 rules,
   vision incl.) → `promoteDraftToChannelSkus` (SKU mint, UPCPool claim,
   canonical band) → operator ship-specs (live cohort convention: S 12×12×10
   160oz / M 13×13×15 256oz / XL 24×13×16 544oz) → operator-declared inventory
   (buy-to-order: Veeqo does not track these retail components, so the
   Veeqo-derived inventory validator is inapplicable — same posture as the 161).
2. `scripts/build-uncrustables-main-owner-approvals-v3.ts` — production-main
   proofs: exact R2 MAIN bytes sha256, 2048px check, generation manifests,
   carton-by-carton visual observation vs the MERGED registry, sealed owner
   approval. Output `…/data/uncrustables-main-owner-approvals-v3.json` (+sha
   sidecar), self-verified through `evaluateUncrustablesMainAuthenticity`.
3. `uncrustables-main-production-preflight.ts` now binds to the MERGED registry
   (v1 + owner's 11-flavor extension) + the v3 manifest — extension flavors are
   publishable; v1/v2 artifacts untouched.
4. `scripts/_publish_batch12_submit.ts` — per-SKU: fresh inventory stamp →
   `preflightProductionUncrustablesMain` (fetches exact R2 bytes → sealed
   permit) → `submitToAmazon` (full blast-door chain + VALIDATION_PREVIEW →
   real PUT).
5. `scripts/_verify_batch12_live.ts` — post-submit getListing check
   (ASIN/status/issues/offer), persists ASINs.
6. `scripts/_gen_channelmax_batch12.ts` — ChannelMAX File Uploader sheet
   (min = ROI floor, max = item price, model 59021 Manual min/max) per the
   launch SOP.

## Amazon requirement changes discovered (GROCERY, vs the 161-era)

- `list_price` is now REQUIRED (90220). Set EQUAL to our_price — an identical
  reference price cannot render a fake strikethrough, so the coupon-only launch
  policy survives. (`amazon-publish.ts`)
- `melting_temperature` REQUIRED for heat-sensitive listings: 32°F, matching
  the live cohort (verified on GU-ASQ1-S7M6). (`amazon-publish.ts`)
- `business_price` and `recommended_browse_nodes` now come back as ignored
  WARNINGs on GROCERY.

## Proven image prompt contract (the reason previews pass carton-checks)

REFERENCE MAPPING (ref N = exact carton, exact badge) + ROW LAYOUT CONTRACT
(one flavor per row, spelled-out count, never fill empty width with cartons) +
UNIFORM CARTON SIZE + EXACT FRONT TEXT + SCENE/BRANDING anchor (green lotus,
2+2 gel packs). Any weakening reintroduced padded rows, double-width cartons,
invented logos or duplicated words — all caught by the carton-by-carton crop
protocol before the owner ever saw them.

## Next

- Monitor 100521 review on the XL (CD-ASU4-85VB); owner uploads
  `channelmax-batch12-9.txt` (Desktop copy, all 10 rows with ASINs) via the
  ChannelMAX File Uploader.
- Launch coupons per `docs/wiki/pricing-launch-sop.md` (owner action in Seller
  Central).
- Trial run of 12 more ASINs (owner-approved 2026-07-23): recipes planned and
  validated by the new BF module
  `src/lib/bundle-factory/uncrustables-box-planner.ts` (flavor catalog,
  rational count bands S≤30 / M 48–54 / L 60–66 / XL 90–135 with dead-zone
  rejection, renderable-scene limits ≤4 flavors / ≤11 cartons / ≤4 rows / ≤4
  cartons per row, and generated listing copy). Render driver:
  `scripts/_trial_render.ts` (WAVE=1|2|3), then the same conveyor.
- Fold the conveyor into the Bundle Factory studio module — the box-planner is
  its first extracted piece; coordinate studio-file changes with Codex via
  CHAT-SYNC.
