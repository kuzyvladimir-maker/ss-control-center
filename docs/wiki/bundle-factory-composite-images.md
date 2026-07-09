# Bundle Factory — Real-Photo Composite Main Images + QA Officer

**Status:** Active (shipped 2026-07-08)
**Owner mandate:** Vladimir, 2026-07-08 — IP/trademark safety.

## Why this exists

The earlier main-image path used an AI model (Codex `image_gen`) to *render*
Uncrustables packaging inside a Salutem cooler. That is a trademark risk: the
model can invent look-alike flavors or garble the printed text, and we are not
licensed to depict a fabricated Uncrustables product. The owner's rule:

> «нам нельзя продавать выдуманный Uncrustables… картинки должны генериться
> 100% теми вкусами, которые есть, ну и на 95% они должны быть похожи на
> оригинал.»

So for own-brand Uncrustables/Smucker's cold multipacks we no longer *generate*
packaging — we **composite the REAL donor retail-box photos** (untouched pixels)
into a clean grid on pure white. The flavor is 100% faithful because it *is* the
real product photo. There is also a **QA officer** that checks every composite
against an ideal picture before it publishes.

This is the same deterministic-compositing tech as the Walmart multipack fix
(`walmart/multipack/composite.ts`), reused for Amazon frozen bundles.

## The ideal picture (what the QA officer enforces)

- Pure-white 1:1 background, no cooler, no props, no overlaid text/badges.
  (The frozen-cooler story moves to a SECONDARY image — Amazon's main image must
  be product-on-white, which the AI cooler-hero violated anyway.)
- Real Uncrustables retail boxes the pack is built from:
  - **SINGLE flavor** → exactly N identical real boxes, count-accurate
    (N = pieces ÷ box pack size; must divide evenly, else not composite-eligible).
  - **MIX** → a variety grid of the real boxes of EVERY flavor (a mix is repacked
    loose, so per-flavor piece counts need not divide a box; boxes shown ≈ qty ÷
    pack, min 1; the exact count lives in the title + info card).
- No fabricated flavor, no printed quantity number, no retailer watermark.

## Files

| File | Role |
|------|------|
| `src/lib/walmart/multipack/composite.ts` | `composeUnitGrid(units[])` — NEW. Near-square grid of N possibly-distinct real product photos, each fit *inside* its cell (never cropped — fixes the mix cut-off). `composeTiledMainImage`, `extractProduct`, `fetchImageBuffer`, `highResImageUrl` reused. |
| `src/lib/bundle-factory/composite-image.ts` | The generator. `buildCompositeMainImage()` resolves each flavor's donor photo, computes whole-box counts, composites, uploads to R2. `buildCompositeWithQA()` runs the QA officer and retries with cleaner photos on reject. `compositeEligible()` gates the path. |
| `src/lib/bundle-factory/audit/composite-qa.ts` | **The QA officer.** Claude vision ($0 via the box worker) checks: real Uncrustables boxes? white bg? all expected flavors present? fabricated/garbled text? retailer/foreign logo? Box-count mismatch is a warning only (we trust our own deterministic math). |
| `src/lib/bundle-factory/image-pipeline.ts` | `runImageGeneration` now takes the composite path for own-brand cold drafts; AI path stays for real gift sets. Status-regression guard so re-imaging a PUBLISHED draft never drops it back to IMAGE_GENERATED. |
| `src/lib/bundle-factory/distribution/distribution-pipeline.ts` | Added `republish?: boolean` — re-PUT an already-LIVE row to REPLACE its main image (PUT is create-or-replace). |
| `scripts/_img_replace.ts` | The driver. Per draft: rebuild composite (QA-gated) → REPLACE mode (live SKU: update `main_image_url`, re-PUT with `republish`) or FINISH mode (unpublished: promote → validate → publish). Resilient like `_finisher.ts`. Env: `BF_JOBS`, `BF_LIMIT`, `BF_ONLY_DRAFT`, `BF_DRY`. |
| `scripts/_verify_any.ts` | Post-check: `SKU=… npx tsx scripts/_verify_any.ts` fetches the LIVE Amazon image via SP-API and reports its dimensions (2200 = composite ✓, 2048 = old AI still ingesting). |

## The cleanliness-ranked photo picker (key detail)

A flavor's *primary* donor photo sometimes carries a marketing banner baked into
the pixels (Walmart "seo" images often have a blue "NEW: Fridge 'Em or Freeze
'Em" callout) — the QA officer rejects that. So per flavor we gather ALL
candidate photos (the primary donor's own images + every **same-flavor sibling**
donor's images) and rank them cleanest-first:

```
target.scene7.com        → 0  (clean studio product-on-white)
walmartimages.com/asr/   → 1  (clean catalog asset)
m.media-amazon.com       → 1
(other)                  → 2
walmartimages.com/seo/   → 3  (marketing banners live here)
salsify / video frame    → 4
```

`sameFlavor(a,b)` matches on a shared fruit word AND agreement on sub-line
qualifiers (protein / reduced-sugar / whole-wheat) so a borrowed sibling photo
is truly the same flavor (≥95% faithful), never a look-alike sub-variant.

On a QA reject, `buildCompositeWithQA` advances every flavor to its next-cleanest
candidate and rebuilds (up to 3 attempts). A composite that still fails QA is
left BLOCKED / manual — **never published**.

## Verified

2026-07-08: pilot single (24ct protein → 3 real boxes) and a wave-2 mix (Bright-
Eyed Berry + Raspberry Spread) both replaced live on Amazon store1 and confirmed
via SP-API `getListing` as 2200×2200 real-photo composites. Brand field =
`Uncrustables`.

## Notes / follow-ups

- Title↔box wording: the protein-line PB & Strawberry Jam box is branded
  "Bright-Eyed Berry" on-pack; our title says "…Strawberry Jam Protein". Same
  product, real photo — not a fabrication — but a future title pass could align
  the on-pack marketing name.
- Non-composite-eligible drafts (a SINGLE whose count doesn't divide its box, or
  a real multi-brand gift set) fall through to the AI path unchanged.
