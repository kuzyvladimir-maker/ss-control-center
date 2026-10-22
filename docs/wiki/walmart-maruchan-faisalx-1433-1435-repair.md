# Walmart Maruchan `FaisalX-1433`–`1435` — exact repair contract

Related execution progress: [Walmart Listing Integrity Codex progress — 2026-08-01](walmart-listing-integrity-codex-progress-2026-08-01.md).

> **Current status 2026-08-01 15:22 EDT:** `1433_COMPLETE_1434_COMPLETE_1435_WAITING_FOR_GLOBAL_ADMISSION`.
> The product is ordinary **Maruchan Instant Lunch Chicken Flavor**, not Roast
> Chicken. Prices were updated and independently read back. Item text and
> attributes from the superseded Roast Chicken plan are forbidden. The
> mistakenly submitted Roast Chicken image feed for `FaisalX-1433` completed,
> and its compensating Chicken image feed succeeded and read back. All three
> correct Chicken image feeds succeeded and read back. A fresh 2026-08-01
> buyer-surface reread proves ordinary-Chicken MAIN and secondary images for all
> three SKU; the previously stale/missing secondary gallery condition has
> converged. Walmart's shared catalog still exposes stale Roast text. A new,
> ordinary-Chicken-only text canary was previously submitted with
> `productName` and returned `ERR_EXT_DATA_0101119/QARTH`. The surgical v49
> successor proved that QARTH was caused by including catalog identity fields,
> not by a general write or permission failure: a description/key-features-only
> operation for `FaisalX-1433` reached terminal success and fresh Qualification
> passed all 13 facets. The corresponding one-write operation for
> `FaisalX-1434` is accepted and still propagating. `FaisalX-1435` has not been
> submitted in this successor lane.

## Owner objective

For exactly `FaisalX-1433`, `FaisalX-1434` and `FaisalX-1435`, the final buyer
surface must describe one coherent product across title, description, bullets,
images, quantity, weight and price. The price must follow the current Walmart
owner pricing model. This authority does not permit retrying an accepted feed,
replaying a failed payload, bypassing the frozen writer, or changing product
identity to match a conflicting image.

## Correct identity decision

The identity is ordinary **Chicken Flavor**. The evidence is:

| Evidence | Result |
|---|---|
| Seller item title for `FaisalX-1433` | Chicken |
| Walmart catalog for UPC `745296305452` | Chicken |
| External UPC/product cross-check, including Amazon `B00MIK4GCS` and Walmart item `10450893` | Chicken Flavor |
| Existing conflicting gallery/MAIN assets | Roast Chicken on some historical images |

Three independent identity sources agree on Chicken; the conflicting Roast
asset is the defect. Images are not allowed to relabel the product.

This is also the measured project rule: resolve-donor anchored on the listing
title produced `2.0%` bad matches, while recipe-donor anchoring produced
`43.4%` on the measured “220” and “16 June” cohorts. Therefore:

1. Start from the authoritative listing identity and product identifier.
2. Use donor content only when the exact variant matches that identity.
3. Treat a conflicting image as an image-integrity defect.
4. Never rewrite title, UPC or physical product identity to match a donor or
   image.

If warehouse evidence later proves that the physical cartons are Roast Chicken,
the supplied UPC/product identity is wrong. That requires catalog support or a
correctly identified replacement listing; a maintenance feed must not conceal
the mismatch.

## Exact listing scope

| SKU | Walmart item | UPC | Quantity | Correct variant |
|---|---:|---:|---:|---|
| `FaisalX-1433` | `1209518230` | `745296305452` | 24 cups | Chicken Flavor |
| `FaisalX-1434` | `517674888` | `791466157147` | 60 cups | Chicken Flavor |
| `FaisalX-1435` | `1523397932` | `619419778860` | 120 cups | Chicken Flavor |

Each cup is 2.25 oz. The three options represent 2, 5 and 10 manufacturer
cartons of 12 cups.

## Target Chicken buyer text

The target titles are listing-identity-bound, not image-derived:

| SKU | Target title |
|---|---|
| `FaisalX-1433` | `Maruchan Instant Lunch Chicken Flavor Ramen Noodle Soup, 2.25 oz Cups, 24 Count` |
| `FaisalX-1434` | `Maruchan Instant Lunch Chicken Flavor Ramen Noodle Soup, 2.25 oz Cups, 60 Count` |
| `FaisalX-1435` | `Maruchan Instant Lunch Chicken Flavor Ramen Noodle Soup, 2.25 oz Cups, 120 Count` |

Description template, substituting the exact count, carton quantity and total
net content:

> Stock the pantry with Maruchan Instant Lunch Chicken Flavor Ramen Noodle
> Soup in convenient 2.25 oz cups. This listing includes **{COUNT}** Chicken
> Flavor cups packed as **{CARTONS}** manufacturer cartons of 12 cups, for
> **{TOTAL_OZ} oz** total net content. Every cup contains the same ordinary
> Chicken Flavor variety; this is not Roast Chicken Flavor and it is not a
> mixed-flavor assortment. The single-serving cup format is convenient for
> home, office, dorm, break room, travel and emergency pantry storage. To
> prepare, fold back the lid halfway, add boiling water to the fill line, close
> the lid and let the noodles stand for three minutes. Remove the lid, stir and
> enjoy. Do not microwave the cup. Store unopened cups in a cool, dry place.
> The product contains wheat, soy and milk ingredients. Review the package for
> the complete ingredient, allergen, nutrition and preparation information
> before use.

Target key features:

1. `Includes {COUNT} Chicken Flavor cups, 2.25 oz each, {TOTAL_OZ} oz total`
2. `{CARTONS} manufacturer cartons with 12 cups in each carton`
3. `Same ordinary Chicken Flavor in every cup; no mixed flavors`
4. `Add boiling water and let stand for 3 minutes; do not microwave`
5. `Shelf-stable cups; contains wheat, soy and milk`

These values are prepared for a future Chicken-bound text operation. They must
not be injected into the superseded Roast compiler. The exact Chicken-only
`1433` canary is now terminal and must not be replayed; `1434` and `1435`
must not receive the same text/attribute feed while the catalog-ownership
condition remains unchanged.

## Price and COGS

Catalog COGS currently used by pricing:

| SKU | Goods | Dry packaging | Total COGS |
|---|---:|---:|---:|
| `FaisalX-1433` | $15.36 | $1.50 | $16.86 |
| `FaisalX-1434` | $38.40 | $1.50 | $39.90 |
| `FaisalX-1435` | $76.80 | $1.50 | $78.30 |

The current price-evidence basis is $0.64 per Chicken Flavor cup. The earlier
Product Truth materialization incorrectly said Roast Chicken because it
inherited the image/donor mistake. That identity defect has now been corrected
append-only through the Product Truth workflow. The historical Roast rows were
not edited or deleted; the three new current recipes point to one
`exact_confirmed` ordinary-Chicken canonical variant, while the accepted cost
rows and price evidence remain unchanged.

The Walmart owner formula is:

```text
T = (G + K + L) / (1 - 0.15 - 0.30)
P = T - S
```

The live prices were written once and independently read back:

| SKU | Live seller price | Result |
|---|---:|---|
| `FaisalX-1433` | $52.83 | `SUCCEEDED_AND_READ_BACK` |
| `FaisalX-1434` | $111.39 | `SUCCEEDED_AND_READ_BACK` |
| `FaisalX-1435` | $197.49 | `SUCCEEDED_AND_READ_BACK` |

Immutable artifacts:

- `data/audits/walmart-listing-full-surface/20260730T025200Z-price-FaisalX-1433-v36/`
- `data/audits/walmart-listing-full-surface/20260730T025200Z-price-FaisalX-1434-v36/`
- `data/audits/walmart-listing-full-surface/20260730T025200Z-price-FaisalX-1435-v36/`

These price operations must not be sent again.

## Product Truth correction outcome

The owner-correction operator was implemented and certified in isolated commit
`fdccafc1e5057cc768cd29c12eb8cd606e94f68c` (predecessor
`c12efee143ade424b1a20d081fdaf7d80fcf951f`). It is exact-request and
plan-hash bound, append-only, and has no cost, provider, retailer, marketplace,
price, inventory, delisting, consumer-activation or procurement write surface.
Targeted tests, TypeScript, ESLint, diff check and the full Product Truth
certification `578/578` passed.

The production correction used:

- plan `ptroc-01602321db0cb8ec116c6fd4`, SHA
  `e6c0cd21cec69aa04887e377fafc86f6d396cfcc051bf1e86ab347376521d9df`;
- fresh preflight `READY_TO_APPLY`, SHA
  `b96ff8d00c12baf0e9ead8dc17751b3abfdf8751416a4411a703b514c228e678`;
- apply `APPLIED`, report SHA
  `e87b37e2d0cd0afec4dbd936f6254fe9f9726ec49afc521f6f3f1d18f988c719`;
- postflight `ALREADY_APPLIED`, report SHA
  `587da19c47f3dd6a157a8d4854c6fb1da0b84efe86f3f5499c00bdc3063c5018`.

Exactly six rows were inserted: three listing recipes and three recipe
components. `costRowsChanged=0`, and no marketplace/provider call was made.
An independent canonical-current production read at
`2026-07-30T09:39:35.066Z` selected:

| SKU | Current recipe | Quantity | Flavor | Current COGS |
|---|---|---:|---|---:|
| `FaisalX-1433` | `ptr:b6ef3877…bcf15` | 24 | Chicken | $16.86 |
| `FaisalX-1434` | `ptr:3b7657e1…01ae5` | 60 | Chicken | $39.90 |
| `FaisalX-1435` | `ptr:48fd0c26…f3e5` | 120 | Chicken | $78.30 |

All three current components target canonical variant
`cpv1:4e13042c9a549c9385e87d13b64ba9b8a3d40842cc7e2756906540a0209d27cd`,
normalized as `maruchan / instant lunch / chicken / 2.25 oz cup`. The sealed
production readback SHA is
`31ec21a3fcb18d5f973247dcaada7fa47a265595189bd12f19a37ca0dea1e5a4`.

### Exact-content enrichment attempt — 2026-08-01

The current Product Truth read contract still has no usable exact full-content
observation for this canonical variant. Its historical
`owner_accepted_public_walmart_plus_saved_zip` observation is explicitly
`retailer_search_partial`: title only, with no description, bullets, attributes
or gallery. The legacy `DonorProduct` row contains richer text, but mutable
legacy fields are not canonical content truth and cannot be copied around the
read contract.

The frozen Product Truth operator was therefore run once under standing
authority for exact donor `50a63e7d-5bec-460e-93c3-25559fcdd010`, Walmart item
`10450893`, canonical variant `cpv1:4e13042c…d27cd`, and listing binding
`walmart:1:FaisalX-1433` component `0`:

- request SHA `4791a647…7d0b` and plan SHA `a984ef61…19f4`;
- balance evidence SHA `d29b6034…1654`: `99,306.5` units observed against the
  `15,000` reserve floor, one call / `2.5` units, retry `0`;
- automatic standing authorization SHA `20b5edff…4417`, with
  `ownerActionRequired=false`;
- execution report SHA `bfcec22a…38a`, artifact-index SHA `015b5289…bc2`.

The execution made exactly one Oxylabs query / `1` unit. It did not make an
Unwrangle detail call because the only provider row was rejected before detail:
the candidate title added the tokens `ramen noodles`, which the current matcher
classified as unexplained relative to canonical product line `Instant Lunch`.
The terminal result is `AMBIGUOUS`,
`TARGETED_WALMART_EXACT_OFFER_MISSING`, with `next_command=null`.
`candidate=null`, `contentEvidence=null`, canonical variant writes `0`, retry
`0`, and all publish/delist/reprice/purchase/replay claims are false. Combined
provider spend, including the balance probe, was `3.5` units. This run is
terminal and must not be retried or replayed. A future successor must correct
the matcher/admission contract and receive its own permitted lifecycle; legacy
content must not be written directly as a workaround.

## Item maintenance outcomes

### Superseded text payload

The old `item-text-FaisalX-1433` payload attempted to rename the product to
Roast Chicken. Walmart correctly rejected it:

- feed ID `18C6F15DDB485501A2AFFB74E06D5DC8@AX8BBwA`;
- error `ERR_EXT_DATA_0101119`;
- field `QARTH`;
- meaning: the submitted details did not match the Walmart catalog product for
  the supplied Product ID.

This was an identity error in the payload, not an API permission, signature,
writer or release-version failure. The old item-text and item-attributes
payloads are forbidden and must not be replayed.

### Correct Chicken text canary

A frozen v37 successor was built from fresh exact item probes and a
byte-addressed Chicken identity manifest. The successor structurally permits
only `item-text-*` and `item-attributes-*`; it cannot stage price, image,
variant, shipping-association or UPC-change operations. It also fails closed if
any text or attribute payload contains `Roast Chicken`.

Release evidence:

- commit `25fd6900a5c91ea907bcec51415f81690ea4cbf9`;
- release ID
  `656a3e9aac926f787ea6f406cd2100b678c92d4e06347184337e7ce06fb9fbbd`;
- release-manifest SHA
  `2271ab7d5082cbfbfcb2c5f0cbb6670c635aae703087a2715a4e694e4c6fd7d4`;
- Chicken identity-manifest SHA
  `68ee75eb0f5a6dec8dd82407b7ac6c0f43a4a2340445bac531ff625bc9c09e02`;
- fresh baseline SHA
  `8c85141c19a3327dbe1dcbe16727babd29c58c7a837fb5d2929a3e6212b1fd9e`.

The exact `FaisalX-1433` text payload contained only SKU/UPC binding, the
ordinary-Chicken title, description and five key features. It contained no
Roast identity, price, image, weight, shipping or variant mutation. Walmart
accepted the one POST as feed
`18C706C56A07515D9787E81F2353E3D8@AX8BBwA`, then completed it with:

- `itemsReceived=1`;
- `itemsSucceeded=0`;
- `itemsFailed=1`;
- `ERR_EXT_DATA_0101119`;
- field `QARTH`;
- “Product ID already exists in the Walmart catalog, but the product details
  provided do not match the existing item.”

The terminal outcome is `READBACK_FAILED`, outcome SHA
`40a407e901ef887bcfe3333ec75ea491ef119e8d35ea29ef5c926d19b46d5bdf`.
Immutable bundle:

`data/audits/walmart-listing-full-surface/20260730T092300Z-chicken-text-FaisalX-1433-v37/`

This second result changes the diagnosis. The first Roast payload was indeed
wrong, but the correct Chicken payload is also unable to replace the shared
catalog contribution. Walmart's seller documentation confirms that title,
description, key features, images and attributes live in a unified catalog;
brand-owner and authorized-reseller contributions have priority, and sellers
without those privileges cannot update some fields even through Seller Center.
The valid paths are content-ownership/authorized-reseller status with supporting
brand documentation, or a catalog correction reviewed by Walmart. Seller Center
manual editing is not an API bypass for the same ownership rule.

### Mistaken Roast image canary

Before the identity correction, one Roast Chicken image operation for
`FaisalX-1433` was accepted:

- operation `item-images-FaisalX-1433`;
- feed ID `18C6F1DFA0C558199A667859246F4533@AX8BBgA`;
- immutable bundle
  `data/audits/walmart-listing-full-surface/20260730T030200Z-image-FaisalX-1433-v36/`.

It reached `RESUME_SUCCEEDED_AND_READ_BACK` with outcome SHA
`ce509eb7ab7d8bb95384789f53e63db3c7cd696ce35f726204096fb14f45c738`.
The terminal state removed the out-of-order race.

### Correct Chicken image assets

The verified buyer-surface main images visibly show ordinary Chicken Flavor and
the exact 24/60/120 counts. The exact 12-cup carton secondary image also shows
Chicken Flavor. The byte-bound asset manifest is:

`data/audits/walmart-listing-full-surface/20260730T030944Z-maruchan-chicken-assets/manifest.json`

Three separate, one-SKU, schema-validated plans were staged:

- `20260730T031100Z-chicken-image-FaisalX-1433-v36/` — feed
  `18C6F6D0E08157FA8934D35991FBE3A0@AX8BBwA` completed
  `SUCCEEDED_AND_READ_BACK`, outcome SHA `c5568424…da817`;
- `20260730T031100Z-chicken-image-FaisalX-1434-v36/` — feed
  `18C6FB4C38E659D49E18EE32FC7B69B6@AX8BBgA` completed
  `SUCCEEDED_AND_READ_BACK`, outcome SHA `c2142793…7f268`;
- `20260730T031100Z-chicken-image-FaisalX-1435-v36/` — feed
  `18C700368B515287AB5E894022FF9380@AX8BBwA` completed
  `SUCCEEDED_AND_READ_BACK`, outcome SHA `7b076038…27c9e`.

Each correct payload was submitted exactly once, sequentially, with at most one
in-flight item feed. No retry or replay occurred.

### Fresh buyer-surface rereads

The historical `2026-07-30T09:05:28Z` reread showed:

| SKU | Title | Gallery | Key features | Quantity |
|---|---|---|---|---:|
| `FaisalX-1433` | Chicken | Chicken 24-count MAIN; stale Roast carton secondary | stale “Roasted chicken flavor” bullet | 2 cartons / 24 cups |
| `FaisalX-1434` | Chicken | Chicken 60-count MAIN; stale Roast carton secondary | stale “Roasted chicken flavor” bullet | 5 cartons / 60 cups |
| `FaisalX-1435` | stale Roast Chicken | Chicken 120-count MAIN; secondary not yet exposed | stale “Roasted chicken flavor” bullet | 10 cartons / 120 cups |

That secondary-gallery result is now superseded. Fresh public captures on
`2026-08-01` show:

| SKU | Title | Gallery | Description / key features | Quantity |
|---|---|---|---|---:|
| `FaisalX-1433` | Chicken | Chicken 24-count MAIN + Chicken 12-cup carton | stale Roast | 2 cartons / 24 cups |
| `FaisalX-1434` | Chicken | Chicken 60-count MAIN + Chicken 12-cup carton | stale Roast | 5 cartons / 60 cups |
| `FaisalX-1435` | stale Roast Chicken | Chicken 120-count MAIN + Chicken 12-cup carton | stale Roast | 10 cartons / 120 cups |

All current image bytes visibly show ordinary Chicken Flavor and the correct
total unit count. The common secondary image SHA is `a30f0b8c…ec89`; MAIN SHAs
are `76e51440…48da`, `836aca90…f55` and `9e6c211f…eee8`. Thus the image surface
is now coherent; the remaining buyer defect is shared text/catalog metadata.

The fresh read-only Seller API baseline is
`data/audits/walmart-listing-full-surface/20260801T130856Z-maruchan-readonly-baseline/`,
manifest body SHA `04706372…8a8e`. It independently confirms prices
`$52.83 / $111.39 / $197.49`, published/active status and variants `2/5/10`.
`1435` reported inventory `0` / `OUT_OF_STOCK`; this is an inventory fact, not
a content defect, and no inventory quantity was invented or changed. Fresh
buyer inspection indexes are `4b05b4f2…1b74`, `6ee15c53…d195` and
`5ae30d89…6e69`. Public offer prices belong to whichever seller owns the
displayed offer; the authoritative Ramive prices are the Seller API values.

### Owner hypothesis recheck — 2026-08-01T14:03Z

The hypothesis “ordinary Chicken identity and text are already correct; only
Roast images remain” was rechecked against the same-day authenticated Seller
API capture, exact-UPC catalog resolution, buyer PDP content and downloaded
image bytes. It is only partially true:

- identity, exact recipes and quantities are ordinary Chicken;
- all current MAIN and exposed secondary image bytes are already ordinary
  Chicken, not Roast Chicken;
- `1433`/`1434` titles are Chicken, while `1435` still has a Roast Chicken title;
- every description and bullet set still contains Roast Chicken language;
- attributes remain mixed: `1433` and `1435` expose Roast flavor; `1434`
  exposes Chicken flavor but Roast preparation/flavor notes.

Therefore there is no remaining image correction to submit. The actual
remaining diff is shared title/text/attributes. No image, price, SEO or content
feed was sent during this recheck. The prior exact Chicken-only `1433` text
canary is terminal `QARTH` and is not replayable; the frozen full-surface
successor also remains unavailable until its catalog-clearance gate and release
requirements are satisfied.

## Text, attributes and weight

The current public surface is not fully coherent:

- `1433` and `1434` titles say Chicken, while shared bullets say
  “Roasted chicken flavor”;
- `1435` still has a Roast Chicken title even though the verified main image is
  Chicken Flavor.

The frozen v36 repair compiler hardcodes the superseded Roast Chicken text and
attribute payloads and is forbidden for further work. Frozen v37 proves that a
correct Chicken-only text payload still hits the unified-catalog lock. Therefore
the same text or attribute change must not be sent for `1434` or `1435` until
the account has content ownership/authorized-reseller privileges or Walmart
corrects the shared catalog.

Net content:

| SKU | Net content |
|---|---:|
| `FaisalX-1433` | 54 oz / 3.375 lb |
| `FaisalX-1434` | 135 oz / 8.4375 lb |
| `FaisalX-1435` | 270 oz / 16.875 lb |

Historical conservative shipping packouts were 6.0 lb, 14.5 lb and 28.0 lb.
They are above the exact manufacturer-carton lower bounds, but are declared
packouts rather than warehouse measurements. Because the old attribute
payloads contain the wrong Roast flavor, they are not executable. Because the
correct Chicken text canary also proved the shared catalog lock, no attribute
or weight feed is authorized until content ownership changes or Walmart clears
the catalog contribution.

## Required execution order

1. Completed: the accepted Roast image feed became terminal through exact
   `resume`; it was never retried or replayed.
2. Completed: the staged Chicken image compensation for `1433` was sent once
   and reached `SUCCEEDED_AND_READ_BACK` through exact `resume`.
3. Completed: the Chicken image feeds for `1434` and `1435` each reached
   `SUCCEEDED_AND_READ_BACK`; all three correct image payloads were sent exactly
   once with no overlap or replay.
4. Completed: fresh 2026-08-01 live verification proved correct Chicken MAIN
   and secondary images and correct 2/5/10 variant quantities. The historical
   stale/missing secondary slots have converged; stale Roast text remains.
5. Completed: frozen v37 proved a Chicken-only text operation cannot mutate the
   shared catalog contribution; the single canary is terminal and was not
   replayed.
6. Blocked externally: obtain Maruchan content privileges/authorized-reseller
   status with brand documentation, or have Walmart correct the shared catalog.
   Do not send `1434`/`1435` text or any attribute/weight payload before that
   condition changes.
7. Completed: the Product Truth recipe identity was corrected append-only to
   exact Chicken for all three SKU. Production postflight is
   `ALREADY_APPLIED`; independent current-recipe and COGS reread passed.
8. Completed fail-closed: the one exact-content Product Truth enrichment run
   ended `AMBIGUOUS` before detail because `ramen noodles` was treated as an
   unexplained title addition. It wrote no content evidence and has
   `next_command=null`; no replay is allowed.
9. Update the execution board and run `node scripts/wiki-brain.mjs`.

## Exact-carton MAIN review — 2026-08-01T14:40Z

The owner's proposed presentation was evaluated as a deterministic alternative
MAIN: two, five and ten real 12-cup ordinary-Chicken cartons for the 24-, 60-
and 120-cup listings. This is a clearer retail-pack explanation than a large
grid of individual cups and does not add promotional text to the MAIN.

Three 2200 × 2200 candidates were built only from the exact 12-cup Chicken
carton bytes (`a30f0b8c…ec89`). No package artwork was regenerated by AI. The
candidate counts and visual QA are `2 × 12 = 24`, `5 × 12 = 60` and
`10 × 12 = 120`; all three have pure-white corners and are below 2 MB. The
sealed candidate manifest is:

`data/audits/walmart-listing-full-surface/20260801T144006Z-maruchan-chicken-main-images-v1/manifest.json`

Manifest SHA-256: `7c2c6ba140d8eb4c673dbb1ca295dd3ff60a738c70569c68d214ab5ba9f0ce13`.

These candidates were deliberately **not** sent. Fresh buyer bytes prove that
the live MAIN already shows ordinary Chicken Flavor and exactly 24, 60 and 120
individual cups, so there is no current flavor/count deception to correct on
the image surface. Replacing those live images is an optional clarity upgrade,
not the remaining integrity repair. It also needs a fresh operator-bound rights
and image-review certificate.

The remaining defect is still catalog-owned text and attributes: Roast language
in all three descriptions/feature surfaces, mixed Roast attributes, and the
Roast title on `FaisalX-1435`. Frozen v39 is healthy for its certified one-SKU
flows, but its ready MAIN compilation builder is product-specific (including a
different hard-coded single-unit UPC) and cannot be repurposed for Maruchan.
The unreleased Maruchan full-surface candidate remains forbidden until the
documented Walmart shared-catalog clearance gate is satisfied and a new
checksum-bound production release exists. Old QARTH payloads remain terminal
and non-replayable.

The same-day Seller API readback again provides the authoritative prices
`$52.83 / $111.39 / $197.49`. This review made Walmart writes `0`, price writes
`0`, inventory writes `0`, and feed submissions `0`.

## Owner-selected carton MAIN and Support handoff — 2026-08-01T14:51Z

The owner explicitly selected the staged `2 × 12`, `5 × 12` and `10 × 12`
carton MAIN candidates and directed the remaining Chicken content correction to
continue. This direction is consumed under the existing G8a authority and does
not require another confirmation phrase.

Fresh gate review confirmed that this instruction does not change the terminal
QARTH/no-replay boundary. The correct next operation is Walmart Catalog Support
arbitration, followed by fresh seller/global-catalog probes and a new frozen
one-SKU release. No existing developer candidate or product-specific v39
builder may be repurposed.

A complete, data-only Support package was prepared at:

`data/audits/walmart-listing-full-surface/20260801T145116Z-maruchan-catalog-support-case-v1/`

It contains:

- `case-draft.md` — exact external request and terminal QARTH history;
- `target-content.json` — exact titles, counts, carton math, net content,
  owner-approved conservative shipping packouts, unchanged prices and the
  selected MAIN SHA for each SKU;
- `attachment-manifest.json` — all evidence paths and immutable hashes.

Support package manifest SHA is
`13ed522ded0c12f40b938d1ad7cff6b4ab1f3a4dc232bc0fba8a1f08c62c7b42`.
The current session exposed no managed browser at all, so Seller Center could
not be opened and the case was not submitted. This is a browser-availability
blocker only: Support cases submitted `0`, Walmart writes `0`, price writes `0`,
inventory writes `0`, and old-payload replay `0`. Once an authenticated managed
browser is connected, the next step is to submit this exact package without
rebuilding or re-asking the owner.

## Pause checkpoint — 2026-08-01 14:41 EDT

Later evidence supersedes the Support-only conclusion above. The v37 QARTH
payload included `productName`; it did not isolate description and key features.
Frozen release v49 added a surgical text lane that binds SKU/UPC but omits
`productName`, brand, attributes, images, price and inventory.

- Release root:
  `release-artifacts/walmart-listing-repair-engine-2026-08-01-v49/`
- Release ID:
  `ba1f2aa79788d739c349cdbe0fc5cd3355cd466ed9abb0be4fe34bd1a6731c97`
- Manifest SHA-256:
  `8979ab02c104620ff51eeb50f790521d59f64ebf40de768494a0fcc30b88b141`
- Certification: `199/199` tests, ESLint and release diff-check passed.

`FaisalX-1433` is complete. Its surgical text feed
`18C7B9B47A6F57DC8A51646DCB4F45F1@AX8BBwA` reached terminal `SUCCEEDED`.
Fresh v49 Qualification passes all 13 facets and has `next_command=null`:

`/Users/vladimirkuznetsov/.ss-command-center/walmart-listing-repair-owner-v1/qualification-v49-1433-20260801T1741Z.json`

`FaisalX-1434` was submitted exactly once. Durable ledger and Walmart's HTTP 2xx
response prove acceptance of feed
`18C7BF3254785F99B4AD7A9EFD72B632@AX8BBgA`; marketplace write count is exactly
`1`. The final pre-restart GET-only receipt still reports
`APPLIED_PROPAGATING / FEED_NOT_TERMINAL` and requires only
`RESUME_EXACT_FEED_GET_ONLY`:

`/Users/vladimirkuznetsov/.ss-command-center/walmart-listing-repair-owner-v1/resume-1434-20260801T1741Z-5.json`

Resume bindings are package SHA
`b96215fae7cd69f43a3588c4f9e1397c1405cd56b9e07e3b39720e81c9b5cea1`
and authorization
`ffa4f0b290fd74df23bea7a36fc51baf6766ced811e9591ad9c9b515af77dad7`.
Do not rerun `execute`; after restart, run only the exact v49 `resume`, then
fresh Qualification after terminal success.

`FaisalX-1435` has not been submitted. Its Chicken text operation follows only
after `1434` is terminal and qualified. Its stale Roast title is a separate
title-only v49 operation after the text lane completes. Prices
`$52.83 / $111.39 / $197.49` and the correct Chicken images remain verified and
must not be resent. Inventory was not changed.

## Resume outcome — 2026-08-01 15:22 EDT

The detached exact-feed monitor completed `FaisalX-1434` without another POST.
Feed `18C7BF3254785F99B4AD7A9EFD72B632@AX8BBgA` is terminal `SUCCEEDED`;
marketplace write count remains exactly `1`. Fresh v49 Qualification at
`2026-08-01T19:11:10.121Z` returned `PASS`, all 14 facets pass, and
`next_command=null`:

`/Users/vladimirkuznetsov/.ss-command-center-owner/walmart/listing-integrity-FaisalX-1434-v49-monitor-qualification-0001-1785611459144-8223.json`

The reporting-only gallery initially stopped because its legacy quantity parser
required an `outer_units` attribute claim even though the surgical text plan
correctly omitted attributes. The generalized parser was validated by `23/23`
targeted tests and rebuilt the exact factual artifact with `23/23` checks PASS:

`ss-control-center/data/audits/walmart-listing-integrity-post-canary/FaisalX-1434-final-gallery-recovered-v1/live-canary-verification.json`

Verification file SHA-256 is
`90924704a92ba260a832b5465fd960786536b3d3c2bc7af2b1470a11e4c8344d`;
body SHA-256 is
`19669f553f13144188cdcb8dbb9a619742c4746e4abff43df7e675be5c715661`.
This recovery made Walmart reads `0` and writes `0`.

V50 global admission now recognizes `FaisalX-1434` as PASS. A separate accepted
cycle for `FaisalX-1144` is still `PENDING_PROPAGATION`, so the active admission
claim intentionally forbids every new POST, including `FaisalX-1435`, until
that independent cycle reaches PASS or a verified terminal disposition. The
local reconciliation watcher is running; it performs no Walmart/network calls.
