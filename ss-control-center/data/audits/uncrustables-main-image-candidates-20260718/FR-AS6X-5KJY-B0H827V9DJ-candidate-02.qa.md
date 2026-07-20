# MAIN image QA — candidate 02 — FR-AS6X-5KJY / B0H827V9DJ

**Verdict:** `REJECTED_TEXT_INTEGRITY`  
**Production eligible:** `false`  
**Candidate SHA-256:** `3a62536982abe4ab15b22159a27312bf3692899606e79c9105b8c4dbdf8520b0`

The composition itself passes:

- exactly 6 Chocolate Flavored Hazelnut Spread cartons;
- visible 4-count format, therefore 24 sandwiches (`6 × 4`);
- exactly 2 gel packs inside and 2 outside;
- correct cooler and primary Salutem logo;
- no other flavor, extra product, floating object, or canvas-edge crop.

The image nevertheless fails the no-invented-text requirement. At original-resolution enlargement, the left internal gel pack visibly reads **`FOR FROZEN SIPMENTS`**, omitting the `H` in `SHIPMENTS`. Apple Vision independently returns that same string with confidence `1.0`. The approved kit reference reads `FOR FROZEN SHIPMENTS`.

Carton microcopy is also inconsistent. Although the main flavor title is correct, OCR finds multiple incompatible lower-claim strings, including `Ne High Fruetase`, `CornSerop`, `NO Kigh Pructoze`, `Conre Seren`, `NOWeh Froctase`, and `Cers Sprop`. Unlike an OCR-only ambiguity, the gel-pack typo is visually confirmed, so fail-closed rejection is required.

Do not publish or approve this exact file for production. Regenerate or source-faithfully recompose the malformed text, then rerun QA on the replacement SHA-256.

References:

- approved kit anchor: `ss-control-center/public/bundle-factory/frozen-refs/ref-uncrustables.png` (`9c45164a…1fd33`)
- exact product front: `ss-control-center/data/audits/uncrustables-approved-reference-qa-20260718/product-hazelnut-target.jpg` (`4d42bd45…54e27`)

Machine-readable evidence is in `FR-AS6X-5KJY-B0H827V9DJ-candidate-02.qa.json`.
