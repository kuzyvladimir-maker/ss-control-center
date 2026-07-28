# Walmart MAIN visual audit — batch-4 decision (2026-07-18)

## Decision

**NO-GO for a full catalog scan.** The safety side of the pilot passed, but the
automation rate and production-readiness gates did not.

This was a read-only artifact pilot. It did not change Walmart, the application
database, R2, listing content, or catalog images. The 24 inputs were frozen
historical MAIN artifacts (12 known BAD + their 12 known-corrected pairs), not a
fresh buyer-facing PDP snapshot.

## Execution contract

- Layout: `batch-4` (four images per model call).
- Subscription calls: exactly `6/6`; one transport attempt per call.
- Paid/API fallback: none.
- Worker provider: `codex_cli_subscription`.
- Worker build: `sha256:bd5acb234ff04d46996f1d4c28fa1519a02169d7277fe963393887e210ed0dc8`.
- Every call attested the full input image count and returned a valid strict
  observation schema.
- The persisted checkpoint counter was incremented before every POST.

## Result

| Frozen truth | BAD | REVIEW | PASS |
|---|---:|---:|---:|
| 12 known BAD images | 12 | 0 | 0 |
| 12 known-corrected images | 0 | 6 | 6 |

Therefore:

- false PASS on known BAD: `0/12`;
- false BAD on known-corrected: `0/12` after the comparator fix;
- automatic PASS on known-corrected: `6/12 = 50%`;
- no completed stability test across the planned shuffled and singleton layouts.

## Defects found and corrected without extra model calls

1. Nutrition values such as `6g Protein`, `4g Fiber`, and `27g Whole Grains`
   were being treated as package weights. Nutrient claims are now excluded from
   package-size comparison.
2. A full expected brand marker missing from a logo-only transcription (`G`
   instead of `Gatorade`) caused a false BAD. Logo-only/absent brand evidence can
   now produce only REVIEW, never PASS; explicit forbidden variants and explicit
   different brands still produce BAD.
3. The runner now supports `--expect-consumed=N`. Resume aborts before model use
   unless the exact checkpoint fingerprint and both persisted call counters
   equal `N`.

## Why six corrected images remain REVIEW

- `FaisalX-1130`: correct 22 oz Pepperidge Farm 15 Grain image; `NET WT 22 OZ`
  is tiny at the bottom and was missed by vision.
- `FaisalX-1160`: correct 24 oz Farmhouse Multigrain image; `NET WT 24 OZ` is
  tiny at the bottom and was missed.
- `FaisalX-1208`: correct Sara Lee Artesano buns image visibly says `8 COUNT`,
  but the v2 manifest stores only the alternative `19 oz` fact.
- `FaisalX-2223`: correct six-bottle Gatorade Cool Blue image; vision returned
  the large `G` logo and `COOL BLUE`, but missed the small `GATORADE` and
  `28 FL OZ` text.
- `FaisalX-3545`: correct Hamburger Helper Four Cheese Lasagna `VALUE SIZE`
  image; exact 8.8 oz is not reliably readable on the supplied front image.
- `FaisalX-4779`: correct Golden OREO Family Size image; the small 18.12 oz text
  was missed.

## Required next revision before another paid/subscription pilot

1. Replace the singular `unit_size` with typed package facts, for example
   `net_content` and `inner_item_count`, each explicitly `required` or
   `if_visible`. A visible contradiction must remain BAD; absent optional text
   must not block PASS.
2. Type identity truth into brand/product/variant aliases instead of relying
   only on untyped marker groups.
3. Parse all literal sizes in a text, deduplicate them, use strict same-unit
   equality, and reserve a small tolerance only for cross-unit rounding.
4. Add a deterministic crop/zoom pass for tiny front-label text while retaining
   the full image as the authority for outer count, tiling, orientation, white
   background, and mixed-product detection.
5. Re-evaluate all existing observations locally at zero model cost. Only after
   that should a new small shuffled-layout pilot be authorized.
6. Before any catalog-scale audit, independently freeze buyer-facing Walmart
   MAIN/gallery images, validate a shadow cohort, and keep all remediation as a
   separate explicitly approved operation.

## Evidence

- Final report: `data/audits/walmart-visual-pilot-runs/walmart-main-artifact-pairs-12x2-20260718-v1-635befdf79ac-eb9f8b5ab932-bd5acb234ff0-codex/report-20260718T191149Z.json`
- Checkpoint: `data/audits/walmart-visual-pilot-runs/walmart-main-artifact-pairs-12x2-20260718-v1-635befdf79ac-eb9f8b5ab932-bd5acb234ff0-codex/checkpoint.json`
- Frozen source index: `data/audits/walmart-visual-pilot-snapshots/walmart-main-bbf179123bd9139dbe9e/source-index.json`
- Zero-call comparator replay: `data/audits/walmart-visual-pilot-replays/walmart-main-artifact-pairs-12x2-20260718-v1-20260718T190828Z.json`
