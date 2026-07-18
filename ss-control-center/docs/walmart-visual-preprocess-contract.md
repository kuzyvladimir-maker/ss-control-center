# Walmart visual preprocessing integration contract

Module: `src/lib/walmart/catalog-visual-preprocess.ts`

Schema: `wm_visual_preprocess/v1`

The preprocessor is a deterministic, read-only derivation step. It accepts the
already frozen source bytes and returns one normalized full view plus optional
high-resolution detail views. It performs no OCR, model request, network access,
SKU lookup, or comparison with expected catalog truth.

## Required runner sequence

1. Freeze and hash the buyer-facing or last-applied source bytes exactly as the
   audit already does.
2. Pass those same bytes to `preprocessCatalogVisual`.
3. Require `result.source.sha256` to equal the frozen source hash. A mismatch is
   a technical failure; do not call vision.
4. Persist derived bytes, if desired, under their returned SHA-256. Never replace
   or rewrite the frozen source object.
5. Cache on source SHA-256, preprocessor version, options, all view hashes, prompt
   version, provider, and worker build.
6. Record both the number of logical source images and the number of physical
   derived views sent to the worker. Worker image-count attestation concerns
   physical views; the blind response still contains one observation per logical
   source image.

`full_only` is a normal fail-closed outcome, not an error. Send only the `full`
view and continue with the existing audit behavior.

## Evidence scope

The `full` view is the only permissible evidence for:

- outer package count;
- grid-cell structure;
- multiple distinct products;
- front visibility;
- background compliance;
- overall visual role.

Detail roles (`tile_front`, `bottom_label`, and `top_left_badge`) may contribute
only to literal transcription of:

- brand;
- product/form;
- variant or package-tier badge;
- per-package size/count text;
- explicit disqualifying text.

Never let a crop of one representative tile overwrite or independently vote on
outer quantity. A six-pack crop naturally contains one bottle; interpreting that
crop as the complete listing image would create the exact quantity-confusion bug
the audit is intended to detect.

## Prompt/group contract

The runner must group all physical views under the original opaque logical image
ID. A future prompt envelope should be equivalent to:

```json
{
  "logical_image_id": "i_opaque",
  "views": [
    { "view_id": "full-...", "role": "full" },
    { "view_id": "tile_front-...", "role": "tile_front" },
    { "view_id": "bottom_label-...", "role": "bottom_label" }
  ]
}
```

The model must return one consolidated observation for `i_opaque`, not one
observation per crop. If the prompt/schema cannot enforce the evidence scopes
above, the runner must use `full` only.

## Provenance and replay

Every returned view includes:

- output SHA-256 and byte length;
- source-region coordinates in auto-oriented source pixels;
- exact resize and encoding recipe;
- provenance SHA-256 binding source hash, preprocessor version, transform,
  role, and output hash.

Replay must verify these fields before reusing a cached view. The analysis record
also has an `analysis_sha256` covering the source, algorithm version, options,
background decision, detected regions, and representative selection.

## Safety boundary

This integration does not authorize writes to Walmart, the application database,
R2, or any remote service. It does not change subscription call budgets. Adding
detail views increases physical image input, so the runner must report that cost
before a model call and retain its existing stop-on-first-failure behavior.

