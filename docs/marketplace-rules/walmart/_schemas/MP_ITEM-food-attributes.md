# Walmart MP_ITEM — Food attribute spec (research, 2026-06-27)

> Compiled via web research from official Walmart developer docs + the verbatim
> MP_ITEM 4.3 JSON Schema (whitebox-co mirror of Walmart's `Get Spec` output) +
> Walmart Marketplace Learn policy pages. Use as KB reference for the listing
> builder + Qualification Officer. Re-verify 5.0 per-subcategory fields via a
> live `Get Spec` call before hard-coding.

## 🚨 CRITICAL POLICY FINDING — frozen/perishable is PROHIBITED on Walmart MP

Walmart Marketplace **prohibits perishable / temperature-controlled / cold-chain
food** (frozen-requiring-cold-chain, refrigerated meats, dairy, seafood, prepared
meal kits, juices, unpasteurized). Only **shelf-stable** items qualify (hard/cured
meats & hard low-moisture cheeses needing no refrigeration, hard-skin uncut fruit,
safely-packaged chocolate-covered items).

**Impact on Bundle Factory:** our FROZEN gift sets (Uncrustables, Jimmy Dean, etc.)
**cannot be listed on Walmart** via standard MP. Frozen = Amazon-only. Walmart is
for SHELF-STABLE sets only (candy, coffee, tea, shelf-stable snacks). The "Sell on"
step must gate frozen out of Walmart.
Source: https://marketplacelearn.walmart.com/guides/Prohibited-Products-Policy:-Food-products

## Version note (4.3 vs 5.0)

- Verbatim downloadable schema = **MP_ITEM 4.3**: all food = ONE product type
  `Food & Beverage` (50 content attrs) + shared `Orderable` offer block (20 attrs).
  No per-subcategory schema in 4.3.
- **5.0** (current, `feedType=MP_ITEM&version=5.0`) splits into per-subcategory
  Product Types (Gift Baskets, Snacks & Cookies, Candy, Coffee, Tea, Frozen…),
  removed ~60% generic attrs, +structured enums, added `countryOfOriginSubstantialTransformation`
  (mandatory) and split `isChemical`/`isAerosol`/`isPesticide`. Per-type 5.0 fields
  only via live `Get Spec` (no static download).

## Universal required — `Orderable` block

Required: `sku`, `brand`, `productName`, `ShippingWeight`, `productIdentifiers`, `price`.

- `sku` (1–50), `productName` (≤200; policy ≤150, no caps/promo/retailer/URL/emoji),
  `brand` (≤60 — Salutem Vita/Starfit), `productIdentifiers` {productIdType GTIN/UPC/EAN/ISBN, productId},
  `price` (≥0, 2dp), `ShippingWeight` (lbs).
- Recommended: `multipackQuantity` (units in pack — key for sets), `externalProductIdentifier` (map to ASIN),
  `pricePerUnit`, `fulfillmentLagTime`, `MustShipAlone`, `shipsInOriginalPackaging`.
- 5.0 adds (mandatory): `countryOfOriginSubstantialTransformation`; chemical flags split.

## Food content — `Visible → Food & Beverage` block

Schema-required: `shortDescription` (≤4000), `mainImageUrl`.
**De-facto required by Food policy + FDA (suppressed if missing):**
- `ingredients` (ingredient statement, ≤4000)
- `foodAllergenStatements` (array; FDA Big-9)
- `nutrients` (array {nutrientName, nutrientAmount, nutrientPercentageDailyValue}) + `servingSize` + `servingsPerContainer`
- `labelImage` {labelImageURL, labelImageContains: Nutrition Facts/Ingredient List/…} — upload the panel photo from the donor catalog here
- `manufacturer` ("Manufactured/Distributed by" is mandatory label content)
- `prop65WarningText` (conditional; literal text or "None")
- `safeHandlingInstructions` (storage/handling), `shelfLife` {measure days} — NOTE: no expiration-date or netContent field in 4.3 (use `size`/`additionalProductAttributes`)

Merchandising/structured (mostly enums): `count`, `countPerPack`, `containerType`,
`foodForm`, `flavor`, `dietType` (coded enum incl. Kosher/Vegan/Gluten Free/…),
`caffeineDesignation` (Coffee/Tea), `puffedSnackType` (Snacks), `cuisine`, `meal`,
`character` (licensed), `keyFeatures` (bullets, 3–10, ≤80 ch), `productSecondaryImageURL`.
Variants: `isPrimaryVariant`, `variantGroupId`, `variantAttributeNames` (count/countPerPack/flavor/size).
Escape hatch: `additionalProductAttributes` (name/value) for anything not natively modeled.

## Per-subcategory (4.3 = all `Food & Beverage`; 5.0 = pull live)

- **Gift Baskets** (primary): count/countPerPack/multipackQuantity/containerType/character + per-component compliance; disclaimer in keyFeatures+shortDescription. 5.0 likely exposes structured occasion/theme/recipient.
- **Grocery/Pantry**: multipackQuantity/count/size/foodForm + full nutrition; 5.0 adds netContent/netWeight.
- **Snacks**: foodForm/puffedSnackType/flavor/dietType.
- **Candy/Chocolate**: foodForm/flavor/dietType/character; allergens milk/soy/nuts.
- **Coffee/Tea**: caffeineDesignation/flavor/foodForm/countPerPack.

## Image requirements (official)

JPEG/JPG/PNG/BMP (no GIF), RGB, ≤5MB, 8bpp, **1:1 square**, recommended **2200×2200**,
zoom min **1500×1500**, hard min **500×500** (below = auto-unpublished), min **4 images**,
seamless white bg (255/255/255), ~2.5% white border.
**Prohibited on images:** watermarks, **your name/logo**, retailer logos/names, promo/ad
language, **text overlays**, coupons, borders, **accessories not included**, non-English text, stock photos.
URL must end in image extension; ports 80/443/8080/8443; no Dropbox/non-public/query-string URLs.
Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/Product-detail-page:-Image-guidelines-&-requirements

## Key sources

- MP_ITEM 4.3 verbatim schema: https://raw.githubusercontent.com/whitebox-co/walmart-marketplace-api/main/docs/item-schemas/MP_ITEM_SPEC_4.3.json
- Item setup schema key points: https://developer.walmart.com/us-marketplace/docs/item-setup-schema-key-points
- Get Spec: https://developer.walmart.com/us-marketplace/reference/getspec
- Food Products policy (frozen prohibition): https://marketplacelearn.walmart.com/guides/Prohibited-Products-Policy:-Food-products
