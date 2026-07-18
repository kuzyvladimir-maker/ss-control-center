# Walmart visual catalog audit — readiness contract v1

## Scope boundary

This contract defines **GO for a read-only catalog audit**, not permission to
change a Walmart listing. Remediation remains a separate workflow with its own
evidence, rollback snapshot, canary, approval, and post-write verification.

The audit must emit one of four explicit outcomes for every requested SKU/image:

- `PASS`: positive evidence supports the authoritative SKU truth;
- `BAD`: positive contradictory evidence proves a defect;
- `REVIEW`: pixels are insufficient or observations conflict;
- `TECHNICAL_ERROR`: snapshot, transport, schema, or attestation failed.

Truth ambiguity is resolved before vision as `TRUTH_REVIEW`; it must not spend a
vision call and must never be silently converted to PASS.

## Gate A — authoritative truth

1. Every SKU truth record has immutable source references and hashes.
2. Offer kind is explicit: same-product multipack or mixed-component bundle.
3. Outer sellable count and each component quantity have distinct fields.
4. Identity is typed as brand aliases, product markers, variant markers, and
   role-scoped forbidden markers.
5. Package facts are typed (`net_content`, `inner_item_count`) and marked
   `required` or `if_visible`.
6. Contradictions between recipe, structured catalog, and title stop before
   vision as `TRUTH_REVIEW`.
7. The run reports exact coverage: automatically auditable, truth-review,
   unsupported, unavailable, and technical-error counts.

## Gate B — frozen paired MAIN golden set

Required layouts: ordered batch-4, seeded shuffled batch-4, and singleton.

- Every known BAD image is `BAD` in every layout.
- No known BAD image is ever `PASS` or `REVIEW`.
- No known-corrected image is ever `BAD`.
- At least 80% of known-corrected images are automatic `PASS` in every layout.
- Verdicts are 100% stable across the three layouts.
- First-attempt observation-schema validity is 100%.
- Worker provider/build and full input-image count are attested on 100% of calls.
- No paid fallback, missing image, retry beyond the declared budget, or silent
  partial batch is allowed.

## Gate C — buyer-facing MAIN shadow cohort

1. Resolve seller SKU to exactly one buyer item ID; zero `items[0]` fallback.
2. Fetch PDP root-product title, MAIN, and gallery independently of seller logs.
3. Freeze original bytes, content type, dimensions, URL, timestamp, and SHA-256.
4. Use a manually labelled stratified cohort of at least 50 current listings,
   covering pack counts, categories, image-generation waves, and known defect
   families.
5. All manually confirmed BAD images are `BAD`; no confirmed correct image is
   `BAD`; automatic decisions have zero false PASS.
6. `REVIEW + TRUTH_REVIEW + TECHNICAL_ERROR` is at most 25% of the cohort.

## Gate D — gallery

Gallery is evaluated separately from MAIN. White background, front orientation,
and outer-grid count are not mandatory for lifestyle, nutrition, ingredients,
or back-panel images.

- Every gallery asset must belong to an expected component or be an allowed
  bundle-level image.
- A foreign product/variant is `BAD` even when MAIN is correct.
- Exact duplicate bytes and perceptual near-duplicates are reported.
- Missing expected component coverage is reported for mixed bundles.
- A frozen gallery golden set must include correct lifestyle/back/nutrition
  examples and injected wrong-product examples, with the same zero-false-PASS
  and zero-false-BAD safety criteria as MAIN.

## Gate E — operational reproducibility

- Observation cache key binds provider, prompt/schema version, worker build,
  ordered image hashes, and preprocessing version.
- Evaluation report separately binds manifest hash, comparator version/hash,
  and observation hashes, allowing zero-call replay after comparator changes.
- Checkpoint call count is persisted before POST; resume can require an exact
  expected count and fingerprint.
- Every run has an explicit maximum call budget and stops on the first golden
  safety failure.
- Full-catalog execution remains read-only and produces immutable reports only.
- No BAD result is eligible for remediation until a human/evidence confirmation
  stage creates a separate repair selection.

## GO definition

The read-only full catalog audit is GO only when Gates A–E all pass in a sealed
report. A GO report authorizes collection and classification only; it never
authorizes listing edits, image publication, deletion, retirement, or rebuild.
