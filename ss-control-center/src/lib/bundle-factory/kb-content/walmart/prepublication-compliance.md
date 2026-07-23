# Walmart US — pre-publication compliance contract

**Policy version:** `walmart-us-prepublication/2026-07-23.4`
**Contract schemas:** `product-truth-listing-manifest/1.1.0`,
`walmart-mp-item-public/1.0.0`, `walmart-prepublication-evidence/1.2.0`
**Current recommended SFF new-item spec:** `MP_ITEM 5.0.20260501-19_21_29-api`
**Verified against current official Walmart documentation:** 2026-07-23

This document is the runtime prompt companion to the typed contracts in
`src/lib/bundle-factory/walmart-listing-contract.ts`. It does not authorize a
publication. Validation precedes the separate owner approval fingerprint.

The unversioned `title-policy.md`, `food-gift-baskets-deep-dive.md`,
`category-grocery.md` and `multipack-policy.md` files are archived planning
snapshots and are deliberately excluded from the runtime KB. They contain
historical account assumptions and static attribute examples that cannot
override this contract, Seller Center evidence or the current live Get Spec.

## Non-negotiable separation

1. `attributes.product_truth_manifest` proves exact physical identity, recipe,
   immutable exact content observations, separate exact/local/fresh price
   evidence and image lineage.
2. `attributes.walmart` contains only the public MP_ITEM adapter contract and
   product-type attributes. Internal evidence must not leak into the feed.
3. `attributes.walmart_prepublication` contains account/SKU evidence: catalog
   search, account health, category entitlement, seller-fulfillment compliance,
   policy/recall review, pricing competitiveness, brand rights, condition,
   expiration control and the live item-spec receipt.
4. Static keyword screening is only a signal detector. A clean result does not
   prove category approval, legal compliance, rights, recall status or schema
   validity.
5. `approved_at` is not a validation prerequisite. Final distribution approval
   is separately sealed after every validator passes and becomes invalid if any
   publishable field or evidence changes.

## Required gates for each pilot SKU

### Catalog identity and setup method

- Search Walmart's catalog by the exact UPC before generating a full item. For
  the US API, request the current case-sensitive `responseFormat=SPEC`; do not
  infer the setup path from a keyword/default-format response.
- A spec-format `MP_ITEM_MATCH` result means an existing live catalog match and
  is a hard pilot block for that UPC. A spec-format `MP_ITEM` result or the
  documented empty-object response may continue through `FULL_ITEM`, but every
  other response shape fails closed. Never copy returned content over the exact
  Product Truth recipe.
- Preserve any exact Walmart item identifier in evidence and route it to the
  separate future `MATCH_EXISTING` / `MP_ITEM_MATCH` adapter phase.
- Never create a duplicate product page merely because a new seller SKU is
  desired.

### Pilot sellable-unit boundary

- The initial engine supports only a homogeneous multipack: one exact canonical
  component repeated `N` times. A seller-combined mixed/custom bundle is outside this
  adapter and must fail closed; Walmart's current item-setup guidance does not support
  partner-combined bundles as ordinary items.
- The staged owner-pool UPC/GTIN identifies the **entire sellable multipack**, not the
  component unit. The component manufacturer's UPC remains Product Truth evidence and
  must never be substituted into `Orderable.productIdentifiers` for the pack.
- `multipackQuantity × countPerPack` must equal the public total count and the sealed
  recipe quantity. A distinct staged SKU and product identifier are required for each
  distinct sellable pack configuration.

### Product identifier and duplicate-listing policy

- A checksum-valid or historically accepted pool UPC is not by itself proof that a
  new item complies with Walmart's current Product ID policy. Walmart says it
  cross-references product IDs with GS1 and may remove listings or suspend an account
  for an unrecognized identifier, identifier reuse, or a company/brand mismatch.
- The legacy `UPCPool.gs1_validated` value imported from the SpeedyBarcode CSV means
  only that `check_digit_valid=true` was present in that file. It must never be
  represented as a fresh GS1 registry lookup.
- Every full-item pilot needs current, immutable evidence for the exact staged UPC:
  identifier validity, acquisition/registrant provenance, authority of the selling
  entity to assign it to this sellable unit, and alignment between the registry
  record and the public item brand. Historical use on another listing/account is
  useful operational evidence but cannot replace this check.
- Before certification, authenticate only the exact staged seller SKU and require a
  `404`, then search the exact staged UPC with `responseFormat=SPEC`. A full
  all-status seller-catalog snapshot is not an input or prerequisite. The same
  sellable variant cannot receive another identifier merely to create a separate
  page. Different pack configurations require different product IDs.

### Product Truth

- Every recipe component must resolve to an immutable canonical variant and an
  immutable `EXACT` content observation. Price proxy/sibling/cross-size evidence
  cannot provide title facts, ingredients, nutrition or images.
- Pilot price evidence must be `EXACT_IDENTITY`, first-party, in stock,
  ZIP/store-scoped and no older than seven days.
- MAIN must trace to the exact content observations, represent the exact outer
  quantity and cover every recipe component. Every image needs rights evidence.
- Every public secondary URL must have its own top-level lineage/rights row.
  The initial pilot uses query-free HTTPS JPEG/PNG URLs, square images at
  Walmart's requested 2200×2200 pixels and Walmart's current 5 MB maximum.
  (1500×1500 is only the documented minimum for zoom.) The narrower
  JPEG/PNG subset is deliberate even though Walmart also documents BMP support.
- Certification downloads and decodes **every** MAIN/secondary/nutrition public
  image, rejects redirects, missing/mismatched byte lengths, undecodable bytes,
  private-address targets, wrong MIME/format, files above 5 MB, non-square images
  and dimensions below 2200×2200. The exact image set is checked again immediately
  before the live feed POST; a warning or manual fallback cannot pass the pilot.

### Prohibited/restricted products and account entitlement

- Walmart's prohibited-products policy is broader than any local keyword list.
  Each SKU needs a fresh `CLEARED` policy review and a fresh recall check.
- Walmart explicitly says that its category/territory list is not exhaustive and
  that policies can change without notice. A clean local scan is therefore only a
  conservative early warning. It can never issue `CLEARED` by itself.
- Walmart lists ingestible products among categories requiring pre-approval.
  Food pilots therefore require explicit `INGESTIBLE_PRODUCTS = APPROVED`
  evidence for the selected positive `store_index`; `NOT_REQUIRED` is not a
  substitute.
- Pet, baby, supplements and other specially regulated categories require their
  additional applicable entitlement and are excluded from the first shelf-
  stable pilot unless explicitly approved.
- Account health and the exact restricted-category status must be captured from
  Seller Center's Health & compliance page for the bound store/account. The
  first pilot requires `HEALTHY_AND_ACCEPTING_NEW_ITEMS`; a general statement
  that the account is healthy is not a substitute for fresh evidence bytes.

### Seller-fulfilled inventory and shipping

- The first pilot is seller-fulfilled from inventory already owned by the seller.
  Purchasing from another retailer and having that retailer ship directly to the
  customer is prohibited.
- The bound fulfillment center and lag must exactly match the offer handoff.
  Without a current Walmart lag-time exemption, the pilot blocks lag above two
  operational days.
- Competitor-branded packaging, identifiers of an unrelated third party and
  third-party promotional/marketing inserts are blocked. Any future WFS or neutral
  MCF route requires a separately versioned adapter and evidence contract.

### Pricing competitiveness and commercial viability

- Before paid evidence or UPC reservation, compare the proposed customer total with a
  fresh exact-variant first-party comparable no older than seven days. Normalize both
  sides linearly to the same component pack count; a sibling flavor, size or product
  cannot be used as the pricing comparable.
- The proposed item price, referral fee, goods, packaging and positive seller shipping
  label must reconcile exactly. Customer shipping charge is zero for this pilot, so
  the seller shipping label must be included in the item price rather than hidden
  outside the economics.
- The target contribution margin is `3000 bps` after exact component goods cost,
  packaging, the positive seller shipping label and the `1500 bps` referral fee.
- The exact comparable remains mandatory and the normalized price ratio is recorded
  as either `AT_OR_BELOW_EXACT_COMPARABLE` or
  `ABOVE_EXACT_COMPARABLE_WARNING`. It is an informational risk signal, not an
  internal candidate rejection threshold.
- An above-comparable warning must be visibly acknowledged in the sealed pricing
  review. Walmart may still remove the Buy Box or unpublish an offer under its
  current Pricing Rules; the business margin rule never represents Walmart
  clearance.

The exact candidate review must cover all of these independent surfaces, not only
title keywords:

1. **Account publish eligibility:** current Health & compliance tasks, account
   standing, listing limits and exact restricted-category selling privilege.
2. **Territory and legality:** admissibility into the US, sanctions/restricted-party
   and forced-labor sourcing, federal/state/local legality, age or quantity
   restrictions, permits and state shipping restrictions.
3. **Category policy:** every applicable prohibited-products category and every
   required pre-approval scope. The overview currently names ingestibles, topical
   products, restricted medical devices, fragrances, luxury brands, software,
   selected seasonal/custom content and covered jewelry/precious goods, plus select
   OTC, supplement, medical-device, personal-care, pet and baby product types.
4. **Food-specific rules:** US-retail packaging; statement of identity, net quantity,
   Nutrition Facts, ingredients/allergens and manufacturer/distributor information;
   shelf life, original/tamper-evident packaging and transport safety. The initial
   pilot excludes perishable or temperature-controlled food, unpasteurized food,
   baby food/formula, adulterated/unsafe/recalled/expired food, non-US retail packs,
   protected/exotic animal ingredients, cell-cultured food, prohibited plants or
   substances including CBD/THC/kratom, and WIC/SNAP/EBT claims.
5. **Claims:** truth/substantiation and consistency across label, images and
   attributes, including origin/Made-in-USA, organic/nutrition/medical claims,
   environmental claims and any jurisdiction-specific restriction.
6. **Recall and safety:** current regulator/manufacturer recalls, market withdrawals,
   warning letters, safety alerts and press releases. Absence from one search is not
   a universal clearance; the reviewer records the exact sources and checked time.
7. **Condition and rights:** `New` only for this pilot, owned inventory, brand/IP
   authority and no retailer-arbitrage fulfillment.
8. **Product-detail content:** title, one-paragraph description, key features,
   public attributes and images comply with the current content rules.
9. **Product identifier and duplicates:** exact UPC registry/brand/seller authority,
   authenticated absence of the exact staged seller SKU and exact staged UPC
   `responseFormat=SPEC` result. A full seller-catalog snapshot is not an input.
10. **Shipping and fulfillment:** owned inventory, bound fulfillment center and lag,
    no retail-arbitrage delivery, competitor packaging or promotional inserts.
11. **Pricing competitiveness:** fresh exact-variant comparable, normalized pack
    counts, reconciled customer total and seller shipping cost inside item price.

`POLICY_REVIEW` is a canonical strict JSON artifact, not a screenshot placeholder or
free-form note. It must bind the exact stage/candidate, store/business-seller scope,
SKU, UPC, policy version and review timestamp; enumerate current official sources,
findings and applicable approval scopes; and identify the real reviewer. `CLEARED`
is accepted only when prohibited and unresolved findings are empty and every required
approval is present and cross-bound to the certification. Unknown fields, stale or
mismatched bindings, arbitrary bytes and self-declared clearance without this
structure fail closed. The later Ed25519 owner permit binds the final certification
and therefore the exact reviewed evidence bytes, but it does not turn automation into
legal advice or make Walmart's evolving policy universe exhaustive.

### Condition, brand and shelf life

- The initial pilot permits only `New` condition.
- A new full product page requires `BRAND_OWNER` or `AUTHORIZED_RESELLER`
  evidence. `LEGITIMATE_RESALE` is accepted only when matching an existing
  Walmart catalog item.
- Dated ingestibles require source-backed shelf life plus a per-lot pre-ship
  check. SSCC's pilot control requires at least 30 days remaining at shipment.
  This is an internal seller-fulfilled safety floor, not a claim that Walmart's
  public WFS 60/30-day receiving/removal rule applies universally to SFF.

### Live product-type schema

- Retrieve Get Spec for the exact product type. Do not trust a local product-
  type allowlist as authoritative.
- Full-item pilots must use `5.0.20260501-19_21_29-api` until this policy snapshot
  is deliberately updated from Walmart's official version table.
- Store the schema hash, fetch time, complete required-attribute list, missing
  list and hash of `attributes.walmart.public_attributes`.
- Validation fails if the spec is older than 14 days, hashes drift, product
  types disagree, a required value is missing, or schema validation is not
  `PASSED`.

### Current product-detail content policy

- Title: English, brief and accurate, no more than 150 characters; no all caps,
  promotional text, retailer names, URLs, irrelevant availability text, repeated
  keywords or unsupported year claims.
- Description: one plain-text paragraph of at least 150 words unless the exact live
  product-type requirement is stricter; no external URLs, retailer/competitor
  exclusivity, promotions, emojis, bullets, unsupported authenticity claims or facts
  that differ from the delivered item.
- Key features: three to ten entries, each no more than 80 characters, ordered by
  importance and free of HTML, manual bullet symbols, promotions, retailer names,
  URLs, irrelevant text and repetitive keywords.
- Every public fact, claim, image and attribute must match the exact delivered
  quantity, size, variant, ingredients/materials and limitations and must have the
  necessary rights. Any generated content is reviewed before publication.

### Adapter and transport boundary

- The initial pilot builds the MP_ITEM 5.0 `Orderable` + product-type
  `Visible` structure only from the sealed public contract; internal Product
  Truth and prepublication evidence must never enter the feed.
- Immediately before every live feed POST, fetch the exact current Get Spec and
  validate the complete payload against its draft-07 schema, including
  Walmart's `minEntries`/`maxEntries` image-array extensions. A local dry run
  may omit this read-only API call; a live submission may not.
- This engine uploads the feed as `multipart/form-data` with the JSON in the
  binary `file` part, matching Walmart's current full-item example. Walmart's
  broader API may also accept direct JSON for some feed contracts; that does
  not authorize changing this sealed adapter without a versioned review.
- The Walmart client owns the marketplace/version headers
  (`WM_GLOBAL_VERSION=3.1`, `WM_MARKET=us`). Fulfillment quantity, center and
  lag remain an explicit offer/inventory handoff and must not be invented in
  MP_ITEM content.

## Official sources

- Prohibited products and pre-approval categories (updated 2026-06-05):
  https://marketplacelearn.walmart.com/guides/Policies%20%26%20standards/Prohibited%20products%20%26%20brands/Prohibited-products-policy%3A-overview?locale=en-US
- Food products (updated 2025-12-11):
  https://marketplacelearn.walmart.com/guides/Prohibited-Products-Policy%3A-Food-products
- Product claims (updated 2026-06-05):
  https://marketplacelearn.walmart.com/guides/prohibited-products-policy-product-claims
- Recalled products (updated 2025-12-11):
  https://marketplacelearn.walmart.com/guides/Prohibited-products-policy%3A-recalled-products
- Restricted/illegal products and state restrictions (updated 2025-12-11):
  https://marketplacelearn.walmart.com/guides/Prohibited-products-policy%3A-restricted-and-illegal-products
- Product details policy (updated 2026-05-21):
  https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content%2C%20imagery%2C%20and%20media/Product-Detail-Page%3A-overview
- Product identifier / GTIN / UPC policy (updated 2025-06-05):
  https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20setup/Choose-a-product-identifier
- Duplicate listings policy (updated 2025-12-10):
  https://marketplacelearn.walmart.com/guides/Policies%20%26%20standards/Product%20listings/duplicate-listings-policy?locale=en-US
- Recommended Item Spec versions:
  https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting
- Get Spec API:
  https://developer.walmart.com/us-marketplace/reference/getspec
- US Item Search setup-path contract (`responseFormat=SPEC`):
  https://developer.walmart.com/us-marketplace/docs/item-search-for-the-walmart-catalog
- Current routing sequence (seller catalog → Walmart catalog → match or full setup):
  https://developer.walmart.com/us-marketplace/docs/create-items-on-walmartcom
- Full seller-fulfilled `MP_ITEM` setup and feed lifecycle:
  https://developer.walmart.com/us-marketplace/docs/create-a-new-item-full-item-setup
- Image requirements (updated 2026-05-12):
  https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content%2C%20imagery%2C%20and%20media/Product-detail-page%3A-Image-guidelines-%26-requirements?locale=en-US
- Resold/New condition policy (updated 2026-02-12):
  https://marketplacelearn.walmart.com/guides/prohibited-products-policy-resold-products
- Brand privileges:
  https://marketplacelearn.walmart.com/guides/brand-manager-manage-brand-privileges
- Account Health & compliance (updated 2026-05-27):
  https://marketplacelearn.walmart.com/guides/Getting%20started/Account%20settings/account-health-compliance-overview
- Selling privileges and restricted-category approval (updated 2026-03-20):
  https://marketplacelearn.walmart.com/guides/Getting%20started/Getting%20ready%20to%20sell/selling-privileges
- Shipping & fulfillment policy (updated 2026-07-02):
  https://marketplacelearn.walmart.com/guides/Seller%20Fulfillment%20Services/Shipping%20methods/Shipping-and-fulfillment-policy
- Pricing Rules (updated 2025-12-12):
  https://marketplacelearn.walmart.com/guides/Catalog%20management/Price%20management/Pricing-rules
