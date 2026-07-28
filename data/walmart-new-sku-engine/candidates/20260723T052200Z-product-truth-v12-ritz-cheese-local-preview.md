# Walmart new-SKU candidate preview — RITZ Bits Cheese

Status: **LOCAL EVIDENCE PREVIEW — NOT READY FOR PUBLISH**

This preview was produced from the verified portable production snapshot. It is not
a substitute for a fresh connected `doctor`, fresh provider evidence, certification
or owner permission to publish.

## Candidate

- Donor product: `75422f18-e3d2-4c62-ae62-7287aaa75119`
- Exact donor offer: `do:walmart:34312392`
- Walmart item: `34312392`
- Exact product URL: `https://www.walmart.com/ip/34312392`
- Source product: RITZ Bits Cheese Sandwich Crackers Lunch Snacks, 8.8 oz
- Working Bundle Factory recipe: homogeneous 2-pack, 17.6 oz total
- New listing UPC: not assigned; must come from the existing owner UPC pool during
  the later sealed `stage`

## Proven locally by frozen engine v12

- `doctor` passed with `EVIDENCE_VERIFIED_BOOTSTRAP`
- the engine derived identity from sealed donor brand/title/size bytes
- one direct base-unit first-party `Walmart.com` offer was bound
- adjacent flavor/title evidence is rejected by regression tests
- Product Truth schema and all eight migration receipts were present on the local
  rehearsal copy
- `plan` passed and sealed one donor plus one offer
- provider calls: `0`
- production database writes: `0`
- Walmart calls and listing writes: `0`

## Machine-derived identity

- brand: `ritz`
- conservative product signature: `bits cheese crackers lunch sandwich snacks`
- size: `249.4758035 g`
- outer pack count of source item: `1`

This intentionally conservative signature is an identity fence, not final customer
copy. The final Walmart title and quantity fields are generated later by the Walmart
channel adapter for the sealed 2-pack recipe.

## Required evidence still open

- Fresh exact Walmart.com search must independently confirm the same item ID, URL,
  first-party seller, full identity token set, size, base-unit pack, stock and ZIP
  `33765`.
- Fresh exact product detail must replace or confirm legacy content. The legacy
  nutrition/allergen record contains a suspicious peanut allergen signal for the
  cheese variant and cannot be published without exact resolution.
- Legacy price `$3.97` is stale and is not usable for current economics.
- Twenty legacy images exist, but they are hosted by Target; image lineage, exact
  variant match, quantity representation and publication rights are not yet cleared.
- Exact package dimensions, shipping weight, fulfillment assumptions, fees, target
  price and profit floor are not yet certified.
- Current policy, recall, brand/category, shelf-stability and seller-account evidence
  must pass the Walmart certification gate.
- The later exact seller-SKU `404` and exact staged UPC `SPEC` checks must pass.
- Production publish lifecycle safety schema must be active before any live apply.

## Allowed next step

After the two explicit owner gates, run a fresh connected Product Truth
`doctor→plan→execute/status/report` for this one donor, then continue through the
frozen Walmart `doctor→plan→stage→certify→dry-run` chain. No live Walmart POST is
authorized by this preview.
