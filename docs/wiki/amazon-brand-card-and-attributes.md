# Amazon listing completeness — rich attributes + cold-chain brand-story card

Living wiki note (session 2026-07-01). Two owner directives for Bundle Factory
Amazon listings, plus the code that implements them. Owner: Vladimir.

## 1. Product type: Food (not Grocery) for food bundles

Amazon's Seller Central classified Uncrustables as product type **Food** with
`item_type_keyword = frozen-kids-meals-and-entrees`. The `FOOD_GROCERY7.csv`
flat-file (Valid Values with BOTH `food` and `grocery` columns) proved the two
product types use **different valid-value strings** — you cannot reuse one on the
other. Full grocery-vs-food diff table lives in
[amazon/food-flat-file-notes.md](../marketplace-rules/amazon/food-flat-file-notes.md).
The values we wired in `valid-values-food.ts` are the **food** column, so Food is
the right type and needs no rework.

Key cold-chain differences: temperature_rating food `Frozen: 0 degree` vs grocery
`frozen: 0 degrees`; keyword food `frozen-kids-meals-and-entrees` vs grocery
`frozen-breakfast-foods`; food has Diet Type + Occasion, grocery has Specialty +
Subject Matter; food allergens Title-Case (~160), grocery lowercase tokens (~40).

## 2. Fill the FULL relevant attribute set (owner: better search visibility)

Vladimir's rule: the more RELEVANT + truthful attributes a listing carries, the
better it surfaces in Amazon search. So the filler
(`buildRichAmazonAttributes`, `attributes/build-amazon-attributes.ts`) fills the
rich set, not the minimum — but only applicable, non-invented values (a wrong
enum rejects the PUT; a false claim raises a flag).

- **Bug fixed:** allergen_information emitted `Shellfish`/`Soybeans`/`Sesame`,
  which are NOT Amazon FOOD valid values → PUT-reject. Corrected to
  `Crustacean`/`Soy`/`Sesame Seeds`.
- **Added:** `condition_type=new_new`, `product_expiration_type=Expiration Date
  Required`, `is_heat_sensitive` (Yes for cold-chain), `contains_liquid_contents`
  (No default; override for drinks) — all exact FOOD valid-value strings.
- Still-optional richer fields needing per-product data: granular nutrition panel,
  `unit_count` (e.g. "60 sandwiches"), Diet Type, gift Occasion.

## 3. Cold-chain brand-story card — unified static gallery image (MANDATORY)

Every FROZEN/REFRIGERATED Amazon listing must carry a single **unified** "Dear
customer / why-us" infographic (insulated foam cooler + gel packs / optimized
delivery / dedicated support / gift sets — and the pricing rationale). It is a
SECONDARY (gallery) image, never the MAIN (secondary slots allow text/graphics;
the MAIN stays the frozen-hero cooler+product shot).

**Architecture — generate ONCE, reuse everywhere:**
- Produce the card once → upload to R2 (bucket via `R2_PUBLIC_URL`, e.g. key
  `prod/brand/salutem-brand-card-v1.png`, 1-yr immutable cache).
- `attributes/brand-assets.ts` — `BRAND_CARD_COLD_CHAIN_URL` constant +
  `appendColdChainBrandCard(attrs, marketplaceId)`: appends the fixed url as the
  LAST `other_product_image_locator_N` slot, gated on `temperature_rating`
  (Frozen/Chilled only), no-op while the url is empty.
- Wired into `buildAmazonAttributes` (`distribution/amazon-publish.ts`) after the
  rich-attr merge.

**Key discovery:** the publisher previously sent ONLY `main_product_image_locator`
— the secondary `other_product_image_locator_1..4` slots were defined in
`fill-map.ts` but NEVER populated. This work activates that gallery path (donor
secondary photos can follow the same route later).

**Generation:** the card is made with **gpt-image-2** via the in-house Codex
worker (`lib/image-gen/codex-worker.ts` → `https://mcp.salutem.solutions/codex-image/generate`,
$0/image, ChatGPT subscription; returns raw PNG bytes). gpt-image-2 renders text
+ the Salutem lotus logo cleanly (confirmed 2026-07-01). Prod creds
(CODEX_IMAGE_WORKER_URL/TOKEN + R2_*) live in Vercel — pull with
`vercel env pull --environment=production`, use, delete.

**Brand voice on the card:** NO emojis/hearts, NO promo adjectives — the legacy
card had a heart icon + "Superior packaging"; the regenerated clean version drops
both ("Superior packaging" → "Insulated foam cooler and gel packs").

## История

- 2026-07-01 — статья создана. Session work: confirmed Food product type;
  richer FOOD attribute fill + allergen enum fix; built the cold-chain
  brand-story card mechanism (brand-assets.ts + amazon-publish wiring, tests
  5/5) and generated + SHIPPED the clean card via gpt-image-2 (best of 3
  variants). Card LIVE at R2 `prod/brand/salutem-brand-card-v1.png` (public
  HTTP 200). Commits: attrs `b637664`, mechanism `50aa0fd`, activation
  `e88308a`, wiki `cab16df`.

## Связи

- [Listing Quality Stack](listing-quality-stack.md), [Bundle Factory](bundle-factory.md)
- [amazon/food-flat-file-notes.md](../marketplace-rules/amazon/food-flat-file-notes.md)
- Frozen-hero MAIN image stays the cooler+product shot (owner firm decision).
