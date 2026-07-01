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

## Valid Values (received 2026-07-01, `FOOD7.csv`) → captured in code

The FOOD Valid Values tab is now encoded as typed constants in
`src/lib/bundle-factory/attributes/valid-values-food.ts`. Key food enums:

- **`temperature_rating`**: `Ambient: Room Temperature` · `Frozen: 0 degree` ·
  `Chilled: 33 to 38 degrees`. **WIRED** — the filler now sets it from the
  bundle category (frozen→`Frozen: 0 degree`).
- **`condition_type`** (flat-file): `New`, `new, open_box`, `new, oem`, Used-*,
  Collectible-*, `Club`, `Refurbished`. ⚠️ Listings API uses the token
  `new_new` for new — not wired yet (verify encoding before sending).
- **`unit_count_type`**: `Count`, `Fl Oz`, `Ounce`, `Pound`, `Gram`, `Foot`, `Sq Ft`.
- **`product_expiration_type`**: `Does Not Expire`, `Expiration Date Required`,
  `Expiration On Package`, `Production Date Required`, `Shelf Life`.
- **`item_type_keyword`** (frozen BTG): `frozen-kids-meals-and-entrees` (vs the
  gift keyword `food-gifts` we use now — switching places it in the frozen-meals
  node; owner decision pending).
- **`dangerous_goods`**: `GHS`/`Unknown`/`Other`/`Not Applicable`/`Transportation`/
  `Waste`/`Storage` (Listings token for none = `not_applicable`).
- **`diet_type`**: Vegan/Vegetarian/Halal/Gluten Free/Kosher/Paleo.
- **`external_product_id_type`**: EAN/GCID/GTIN/UPC/ASIN/ISBN.
- **`gtin_exemption_reason`**: Manufacture on Demand/Plan Item/Refurbished/
  CustomProductBundle/ReplacementPart/Pre-Order.
- **`allergen_information`**: large list incl. Big-9 + "… Free" / "… may contain"
  variants (we only DECLARE positive Big-9 via extractAllergens).
- **`occasion`**: Birthday/Christmas/Anniversary/… (gifting).
- Units: weight LB/KG/GR/OZ/…; length/dims Angstrom…IN/FT/CM.

## MAIN image — the cooler + gel packs ARE the product (Vladimir, firm decision)

Do NOT flag the frozen-hero (Salutem styrofoam cooler + branded gel packs +
product inside) as violating the MAIN-image "no props/logos" rule, and do NOT
suggest moving it to a secondary slot. Vladimir has stated repeatedly: **we sell
the product AS the frozen cooler kit** (cooler + gel packs are dispatched with
the order), so they are the product, not props. The Amazon prohibition is on
ADDED OVERLAY badges / inset images / promotional text — which we do NOT use
("никакие бейджики мы не используем"). The frozen-hero stays the MAIN image.

## grocery vs food — the two product types use DIFFERENT valid values

Source: `FOOD_GROCERY7.csv` (2026-07-01) — a Valid Values tab carrying BOTH the
`grocery` and `food` product-type columns side by side. **Core lesson: a valid
value from one product type is NOT accepted by the other** (different casing,
different tokens, sometimes different field names). Pick the product type first,
then use THAT column's values.

Differences that matter for our (frozen) food bundles:

| Field | FOOD (what we've wired) | GROCERY | Impact |
|---|---|---|---|
| `temperature_rating` | `Frozen: 0 degree` (Title, singular) | `frozen: 0 degrees` (lower, plural) | 🔴 wrong string = PUT reject |
| `item_type_keyword` (frozen) | `frozen-kids-meals-and-entrees`, `frozen-french-toast`, `frozen-waffles` | `frozen-breakfast-foods`, `frozen-meals-and-entrees` | 🔴 different vocabularies |
| dietary field | **Diet Type**: Vegan/Vegetarian/Halal/Gluten Free/Kosher/Paleo | **Specialty**: gmo-free/grass-fed/halal/kosher/organic/vegan/… (different NAME + lowercase tokens) | 🟡 different field + values |
| gifting field | **Occasion**: Birthday/Christmas/Anniversary/… | **Subject Matter**: Winter/Autumn/Summer/Fathers Day/… | 🟡 different field |
| `allergen_information` | ~160 Title-Case values (Milk, Wheat, Tree Nuts, "… Free", "… may contain") | ~40 lowercase snake_case tokens (milk, wheat, tree_nuts, egg_free…) | 🟡 different case/tokens |
| `variation_theme` | Colour; SizeName; Size & Colour | Flavor; numberofitems; Size; Color; Weight; Flavor-Size; StyleName;… | 🟡 build variations |
| `relationship_type` | Variation; package_contains | Accessory; Variation | 🟡 |
| nutrition units | `pill(s)`, `teaspoon(s)`, `Bars`, `Portion(s)` | `pills`, `teaspoons`, `food_bars`, `portions` | 🟢 not forced |
| Melting Temp Unit | Kelvin; F; C | Fahrenheit; Celsius | 🟢 n/a to food |
| `product_id_type` | EAN/GCID/GTIN/UPC/ASIN/ISBN | adds `pzn` (German pharma) | 🟢 |
| GHS Class / battery / CPSIA | Title Case | lowercase / snake_case tokens | 🟢 n/a |
| Country of Origin | "The Democratic Republic of the Congo", "Russian Federation", "Myanmar" | "Democratic Republic of the Congo", "Russia", "Burma (Myanmar)" | 🟢 naming variants |
| Unit Count Type / order-only | same 7 values, order differs | same 7 values, order differs | 🟢 cosmetic |

Only on GROCERY: `Product Tax Code` = `A_GEN_NOTAX`. Only on FOOD: `Contains
Liquid Contents?`, `Is the liquid product double sealed?`. `Product Expiration
Type` and `Dangerous Goods Regulations` are shared (no per-category column).

**Decision this drives:** publish Uncrustables under product type **Food** — that
is what Amazon's Seller Central UI itself assigned, AND the values already wired
in `valid-values-food.ts` (`Frozen: 0 degree`, `frozen-kids-meals-and-entrees`,
Diet Type, Occasion, Title-Case allergens) are the FOOD column. Choosing GROCERY
would require re-wiring temperature to `frozen: 0 degrees`, the keyword to
`frozen-breakfast-foods`, allergens to lowercase, Diet Type→Specialty, and
Occasion→Subject Matter. (Owner decision still open; recommend Food.)
