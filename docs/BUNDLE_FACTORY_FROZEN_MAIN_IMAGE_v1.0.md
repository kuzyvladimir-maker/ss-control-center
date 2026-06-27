# Bundle Factory — Frozen Main-Image Spec (v1.0)

> **Owner decision (Vladimir, 2026-06-27).** Authoritative template for the
> TITLE/MAIN image of FROZEN listings. The image generator must NOT invent a
> pretty picture from scratch — it assembles every frozen hero image from the
> SAME commercial template.
>
> Reference renders (approved by Vladimir, made with GPT): Jimmy Dean Croissant
> set + Smucker's Uncrustables set, both in a Salutem Solutions branded foam
> cooler with branded "FROZEN GEL PACK" pouches. Stored as style anchors —
> see "Reference assets" below.

## The core formula

> **Third-party brand product + our branded frozen shipping kit = a Salutem
> Solutions frozen gift set.**

Every frozen hero image MUST contain 4 elements:

1. **Original third-party product** (e.g. Uncrustables, Jimmy Dean, Eggland's
   Best). The third-party packaging stays as-is — **no Salutem logo on it.**
2. **White EPS styrofoam insulated cooler** — Salutem Solutions logo on it.
3. **Branded frozen gel packs** — labelled `FROZEN GEL PACK` / `KEEP FROZEN` /
   `FOR FROZEN SHIPMENTS` + Salutem logo + slogan "OUR BEST SOLUTIONS FOR YOU".
4. **Frozen cue** — light frost / condensation on cooler + packs. **No loose
   ice, no ice cubes, no crushed ice.**

## The trademark rule (critical — for the algorithm AND the QA Officer)

Salutem Solutions is **NOT** the brand of the food product. Salutem Solutions
is the brand of the **gift set / frozen shipping set / seller-packed bundle**.

- Jimmy Dean stays Jimmy Dean. Uncrustables stays Uncrustables. Eggland's Best
  stays Eggland's Best.
- Salutem branding appears ONLY on: the cooler, the gel packs, and possibly the
  outer shipping box — **never on the third-party product.**
- Never make the third-party product look like a Salutem private-label item.
  Never replace the real product brand with Salutem.

## Universal prompt template (base for the image agent)

```text
Create a clean, photorealistic e-commerce main listing image on a pure white background, square 1:1 format.

The image must show a frozen gift set assembled and shipped by SALUTEM SOLUTIONS.

Main subject:
Show the third-party frozen product packaging clearly and prominently. The product is: [PRODUCT NAME]. Use the provided product reference images to accurately match the real retail packaging style, colors, brand placement, and product photo. Do not redesign or rebrand the third-party product packaging.

Seller shipping kit:
Place the product inside a white EPS styrofoam insulated shipping cooler. The cooler should be shown at a realistic 3/4 front angle, with the lid slightly open or leaning behind the cooler, so customers clearly understand the product ships in an insulated cooler.

Branding:
Apply the SALUTEM SOLUTIONS logo only to the cooler and frozen gel packs. Do not apply SALUTEM SOLUTIONS branding to the third-party product packaging.

Gel packs:
Include 2 to 4 white branded frozen gel packs. Some gel packs should be inside the cooler next to the product, and 1 to 3 gel packs should stand in front of or beside the cooler. The gel packs must have a blue header label that clearly reads:
"FROZEN GEL PACK"
and smaller text:
"KEEP FROZEN"
"FOR FROZEN SHIPMENTS"
Add the SALUTEM SOLUTIONS logo and slogan "OUR BEST SOLUTIONS FOR YOU" on the gel packs.

Frozen delivery cues:
Use subtle frost, cold condensation, and a clean frozen-shipping look on the cooler and gel packs. Do not show loose ice, crushed ice, ice cubes, snow piles, or messy water.

Composition:
The third-party product must be the hero of the image. The cooler and gel packs support the message that the product ships frozen. The image should instantly communicate:
1. This is the real third-party frozen product.
2. This is a seller-created frozen gift set / bundle.
3. The item ships in an insulated cooler.
4. Branded frozen gel packs are included to keep the product frozen during shipment.

Style:
Bright white background, clean shadows, premium marketplace product photography, sharp details, realistic proportions, no people, no lifestyle background, no extra props, no unnecessary text overlays.

Avoid:
- Do not place SALUTEM SOLUTIONS branding on the third-party product.
- Do not create private-label versions of the third-party product.
- Do not show loose ice or crushed ice.
- Do not make the cooler bigger than the product to the point that the food item becomes secondary.
- Do not add claims like "guaranteed frozen delivery" unless this exact claim is approved for the listing.
```

## Variables the agent needs per listing

```text
[PRODUCT NAME]          e.g. Jimmy Dean Croissant Sausage, Egg & Cheese Sandwiches
[PRODUCT BRAND]         e.g. Jimmy Dean
[PRODUCT TYPE]          e.g. frozen breakfast sandwich
[PRODUCT REFERENCE IMAGES]  2–5 photos of the real packaging (from donor catalog)
[PACK COUNT]            e.g. 4 / 6 / 8 / 12
[SET TYPE]              e.g. Frozen Gift Set, Frozen Breakfast Bundle
[SELLER BRAND]          Salutem Solutions
[SHIPPING MATERIALS]    White EPS styrofoam cooler + branded frozen gel packs
[REQUIRED GEL PACK TEXT]  FROZEN GEL PACK / KEEP FROZEN / FOR FROZEN SHIPMENTS
```

## Ideal composition

- **Center:** hero product, large visible packaging.
- **Back:** 2–4 more of the same boxes / flavor variants.
- **Below / around:** white foam cooler.
- **Sides:** branded frozen gel packs.
- **In front of cooler:** 1–2 gel packs (so it reads as a frozen shipping kit, not just a box).
- **On cooler:** Salutem Solutions logo.
- **Background:** clean white — no kitchen, warehouse, hands, table, ice, or extra props.

## Gel pack label (approved wording)

`FROZEN GEL PACK` → `KEEP FROZEN` → `FOR FROZEN SHIPMENTS` → logo `SALUTEM
SOLUTIONS` / `OUR BEST SOLUTIONS FOR YOU`.

(Not just "Cold Pack" — "Frozen Gel Pack" makes clear it's frozen gel ice for a
frozen shipment.)

## Hard prohibitions

```text
Never put SALUTEM SOLUTIONS logo on third-party food packaging.
Never make the third-party product look like a Salutem private-label product.
Never replace the real product brand with Salutem.
Never show loose crushed ice inside the cooler.
Never make the gel packs look generic and unbranded.
Never make the product packaging unreadable.
Never make the cooler look like the main product instead of the food item.
Never add unapproved claims such as "guaranteed frozen arrival" / "100% frozen delivery" unless approved.
```

## QA Officer pre-publish checklist (frozen image)

```text
1. Is the third-party product clearly visible?
2. Is the original third-party brand still visible?
3. Is SALUTEM SOLUTIONS branding only on cooler / gel packs?
4. Is the cooler clearly an insulated styrofoam shipping cooler?
5. Are there visible frozen gel packs?
6. Do the gel packs say "FROZEN GEL PACK"?
7. Is there no loose ice or crushed ice?
8. Does the image clearly communicate frozen shipping?
9. Does the image look like a premium marketplace hero image?
10. Would a customer immediately understand: "This product ships frozen in a cooler with frozen gel packs"?
```

## One-line rule

> For every frozen listing, generate a white-background hero image showing the
> real third-party frozen product inside a Salutem Solutions branded styrofoam
> cooler with Salutem Solutions branded "FROZEN GEL PACK" pouches, making it
> clear that the product is a seller-created frozen gift set shipped frozen,
> without rebranding the third-party product.

## Reference assets

Two approved style-anchor renders (Jimmy Dean set, Uncrustables set) must be
stored as files (repo `assets/` or hosted on R2) and passed to the image model
as STYLE references on every frozen generation, alongside the per-product
[PRODUCT REFERENCE IMAGES] from the donor catalog. **TODO:** Vladimir to provide
the two image files (chat attachments can't be saved programmatically).

## Open implementation questions (see discussion)

1. **Amazon MAIN-image policy** — main image must be the product on pure white,
   no props/extra objects, no text/logos overlay. A cooler + gel packs + label
   text + Salutem logo MAY trip Amazon's main-image check → suppression risk.
   Likely this is a perfect SECONDARY image; the main may need a cleaner variant.
   To be verified against current Amazon policy. Walmart is more lenient.
2. **Trademark accuracy** — AI re-rendering third-party packaging can misrender
   the real brand (wrong logo/text). Prefer compositing the REAL donor product
   photo over re-drawing it; QA Officer must verify packaging fidelity.
3. **Image pipeline** — current `image-pipeline.ts` sends a text-only prompt
   with no reference images. Must be extended to pass product refs + these two
   style anchors. Confirm the image worker (Codex/ChatGPT) accepts references.
