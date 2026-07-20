# Walmart gallery audit contract (v1)

This module is a read-only supplement to the main-image audit. Its input truth
must already have passed the strict `walmart-visual-audit/v3` manifest
validator. It performs no fetch, model call, file write, marketplace mutation,
or remote mutation.

## Decision boundary

- Gallery slots never inherit the main-image outer-count, repeated-grid,
  front-orientation, or white-background requirements.
- Literal blind evidence of a foreign brand, product, variant, or a
  role-scoped forbidden marker is `BAD`.
- Complete allowed identity evidence is `PASS`. Partial back, nutrition,
  ingredient, infographic, or lifestyle identity is `REVIEW`.
- OCR can support blind identity but cannot be its sole source. Multiword OCR
  aliases must be contiguous within one literal OCR row; words from unrelated
  rows are never combined into a match.
- A package fact can become `BAD` only from the structured blind observation.
  An OCR-only mismatch, or disagreement between blind vision and OCR, is
  `REVIEW`.
- On back, nutrition, and ingredients panels, a mass/volume contradiction
  requires an explicit `NET WT`, `NET WEIGHT`, or `NET CONTENTS` label. A
  serving-size literal cannot become a package-size defect.
- Missing media is `MISSING`; fetch/decode/model failures are `TECH_ERROR`.
  Neither is represented as a visual-quality verdict.
- The v1 default is a same-product listing. A mixed-component bundle is
  `UNSUPPORTED` unless explicit component identities are supplied. With
  explicit identities, a slot may match one component; an image with several
  unenumerated products remains `REVIEW`.

The implementation is in `src/lib/walmart/catalog-gallery-audit.ts`.

## Duplicate boundary

Exact duplicates use SHA-256 of the immutable source bytes. Perceptual
near-duplicates use an auto-oriented, grayscale 9-by-8 difference hash and a
reported Hamming distance (default threshold: 5 of 64 bits). Exact and near
duplicates are separate report fields. Missing assets and technical/decode
failures are separate report fields as well.

Raster decoding is capped at 40 million input pixels. Oversized or malformed
images are reported as technical decode failures, not quality findings.

The detector is deterministic and local-only. A near-duplicate finding is a
triage signal; it does not identify which gallery slot is semantically better
and never changes marketplace state.
