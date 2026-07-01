# Amazon FOOD flat-file — reconciliation notes

**Source:** Amazon FOOD category inventory-file template, "Data Definitions" tab
(field name · label · definition · accepted values · example · required?).
Provided by Vladimir 2026-07-01 (`FOOD4.csv`). This reconciles that template
against the Bundle Factory attribute schema + filler.

## Two naming systems — we publish via the Listings API, not the flat-file

The flat-file uses **legacy field names** (`brand_name`, `bullet_point1..10`,
`item_type`, `temperature_rating`, `external_product_id`, `standard_price`…).
The Bundle Factory publishes through the **Listings Items 2021-08-01 API** with
**modern JSON attribute names** (`brand`, `bullet_point`, `item_type_keyword`,
`temperature_rating`, `externally_assigned_product_identifier`,
`purchasable_offer`…). So the flat-file is a **cross-check for completeness,
requiredness, and valid values** — NOT a 1:1 field map.

Our schemas (`src/lib/bundle-factory/attributes/schemas/*.json`) are the SLIMMED
Listings-API definitions: `{ key, label, required }` only. They give the field
LIST and requiredness but **do NOT carry the accepted-value (enum) lists** — that
is exactly what the flat-file's **Valid Values** tab provides.

## Required for our GROCERY publish (Listings API `required`)

`brand`, `item_name`, `bullet_point`, `product_description`, `country_of_origin`,
`item_type_keyword`, `supplier_declared_dg_hz_regulation`. All are set today
(amazon-publish.ts + the rich-attribute filler). The flat-file marks many more
as "Required", but those are the legacy/generic template's markings — conditional
in practice (e.g. battery fields only for battery products) and NOT required by
the GROCERY Listings type.

## Gaps found (fields that EXIST on GROCERY but the filler didn't set)

| Attribute | Status |
|---|---|
| `temperature_rating` | Fill-map bug fixed: it wrongly referenced the non-existent legacy `storage_temperature`. Real field is `temperature_rating`. **Needs the exact enum** (frozen/chilled/ambient) before wiring — flat-file example shows `Ambient: Room Temperature`, `Chilled: 33 to 38 degrees`. |
| `condition_type` | Not set. Standard Listings value for new is `new_new` — **confirm via Valid Values** before adding (bad enum → PUT rejects). |
| `contains_liquid_contents` | Can be set `No` for solid food (mapped `fixed`). |
| `product_expiration_type` | Optional; `Expiration Date Required` when the donor prints a date. |
| `each_unit_count` / `unit_count` | Optional; derive from donor size (e.g. 60 sandwiches). Needs size parsing. |

Fields on the flat-file that DON'T exist on the GROCERY Listings type and are
therefore NOT needed on our publish path: `batteries_required`,
`are_batteries_included`, `item_form`, `unit_count_type`, `form_factor`,
`storage_temperature`, `standard_price` (we use `purchasable_offer`).

## Nutrition — optional, Claude may leave blank (owner decision 2026-06-27)

The flat-file exposes ~60 granular per-serving nutrient fields
(`protein_per_serving_string`, `sodium_per_serving_string`, all vitamins/minerals,
`serving_size`, …). These are OPTIONAL. Vladimir accepted that allergens +
nutrition can be Claude-filled or blank, so we do NOT force the granular panel;
we carry `ingredients`, `allergen_information` (FDA Big-9), and `nutritional_info`.

## STILL NEEDED from Vladimir — the **Valid Values** tab (CSV)

To wire the dropdown/enum fields with EXACT accepted strings (a wrong enum makes
the PUT reject), send the Valid Values tab. Priority fields:
`temperature_rating`, `condition_type`, `unit_count_type`, `cuisine`, `item_form`,
`product_expiration_type`, `diet_type`. Once received → wire the exact enums into
the filler + fill-map.
