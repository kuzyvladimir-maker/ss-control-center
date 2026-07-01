# Walmart MP_ITEM 5.0 — Food Attributes (API name reference + fill strategy)

**Source of truth:** Walmart Seller Center → *Add Items → Bulk Item Setup → Download Spec*,
feed type **MP_ITEM**, version **5.0** (file `omni-marketplace-en-external-5.0.20260501`,
provided by Vladimir 2026-07-01). Downloaded with category **Food** + 15 condiment/canned
subcategories — that's enough to expose the **universal food attribute API names** (they're
the same across food product types); category-specific closed lists for Beverages/Bakery/
Snacks would need those subcategories selected on re-download.

Implemented in `src/lib/walmart/multipack/attributes.ts` (`buildFoodAttributes`).

## Why this matters
The MP_MAINTENANCE remediation feed previously sent only image + title + bullets +
description. Walmart's listing-quality score and search indexing also weight the structured
**attributes**. More correctly-filled attributes → better ranking + browse-filter inclusion.
(Vladimir, 2026-07-01: "чем больше атрибутов — тем лучше".)

## ⭐ The quantity trio — the DATA-level fix for "ordered 1, got N"
Walmart's spec defines three separate attributes. For our bundles (N ordinary,
individually-saleable retail units shipped together = the spec's "6-pack labeled for
individual sale" case):

| Display name | API name | Our value | Definition |
|---|---|---|---|
| Multipack Quantity | `multipackQuantity` | **N** | # of individually-saleable items |
| Count Per Pack | `countPerPack` | **1** | # identical items inside each package |
| Total Count | `count` | **N** | = multipackQuantity × countPerPack |

Filling these makes Walmart *systemically* know the listing is N units (browse filters,
search) — the second lever alongside the tiled N-unit main image.

## API attribute names (Visible block) — from the spec's machine row
CONTENT (already sent): `productName`, `shortDescription`, `keyFeatures`,
`mainImageUrl`, `productSecondaryImageURL`.

**SAFE (free-text / numeric — never bounce on an enum), filled from donor:**
`manufacturer`, `ingredients`, `foodAllergenStatements` (allergen statement),
`flavor`, `flavor_notes` (tasting notes), `netContentStatement`, `cuisine`,
`productLine`, `texture`, `occasion`, `vegetable_type`, `fruitType`,
`dietaryMethod`, `manufacturerPartNumber`, `size`.

**CLOSED-LIST (enum — donor values are Walmart-sourced so usually valid; strip on
rejection via `includeClosed:false`):** `containerType`, `container_material`,
`foodForm`, `food_condition`, `spiceLevel`, `sizeDescriptor`,
`food_preparation_method`, `ib_retail_packaging`, `productNetContentUnit`
(+ numeric `productNetContentMeasure`).

**Other useful spec names (not yet filled):** `nutritionFactsLabel` (URL of the
nutrition-panel image — we often have it in the donor gallery), `ingredientListImage`,
`nutrientName`/`nutrientAmount`/`nutrientPercentageDailyValue` (nested nutrients),
`assembledProductWeight`, `pieceCount` (ONLY for baskets of *different* items — NOT our
identical multipacks → leave unset), `brand` (**deliberately NOT sent** — catalog-identity
field, triggers the QARTH `ERR_EXT_DATA_0101119` conflict).

## Fill strategy
1. Quantity trio from the resolved `packCount` (no donor needed).
2. Everything else from **donor `specifications` + `ingredients`** (BlueCart scrapes these
   from Walmart's OWN product page, so the values are already Walmart-valid).
3. `buildFoodAttributes(db, sku, packCount, {includeClosed})` returns `{attrs, filled,
   closedUsed}`. On a feed that rejects an enum, re-run with `includeClosed:false` to keep
   the SAFE layer.
4. Attributes are merged into the same `Visible[productType]` object as the content.

## Verifying acceptance
Poll the feed with `checkFeed` — its `detail` lists the `field` of every
`ingestionError`, so a rejected attribute names itself. Drop/blacklist those, keep the rest.
