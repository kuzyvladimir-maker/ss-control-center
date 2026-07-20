# MAIN image QA — FR-AS6X-5KJY / B0H827V9DJ

**Verdict:** `BLOCKED_PENDING_OWNER_AND_TEXT_PROOF`  
**Production eligible:** `false`  
**Candidate SHA-256:** `2ef27c4bf88356b094e76d9e3ad632710854f2c850fcd1c358502bfb41783015`

The candidate is visually strong and the deterministic composition checks pass:

- exactly 6 brown Chocolate Flavored Hazelnut Spread 4-count retail cartons;
- 24 sandwiches total (`6 × 4`);
- exactly 2 gel packs inside and 2 outside;
- correct white cooler, lid, Salutem emblem and wordmark;
- no other flavor, invented product, obvious floating object, or canvas-edge crop.

It is still blocked under fail-closed rules. Small package copy cannot be proven character-exact at 1254 × 1254. Apple Vision OCR succeeded and correctly found the flavor name and the main Salutem/gel-pack text, but it also returned high-confidence deviations such as `FOR FROZEN SHIPNENTS`, `NO High Fructabe`, `Coro Syrop`, and `Cern Syrop`. The same OCR engine misread known-good reference text at comparable scale, so this is not a definitive counterfeit finding; it is unresolved evidence and therefore cannot be counted as a pass.

No owner approval exists for this exact image hash. Do not publish it. The safe next step is either explicit owner approval after full-resolution inspection or source-faithful recomposition of the carton faces followed by repeat QA.

References:

- approved kit anchor: `ss-control-center/public/bundle-factory/frozen-refs/ref-uncrustables.png` (`9c45164a…1fd33`)
- exact product front: `ss-control-center/data/audits/uncrustables-approved-reference-qa-20260718/product-hazelnut-target.jpg` (`4d42bd45…54e27`)

Machine-readable evidence is in `FR-AS6X-5KJY-B0H827V9DJ-candidate-01.qa.json`.
