# A+ Content — Knowledge Base (technical + policy)

Refresh ~every 6 months. Source: deep-research (2026-06-19), verified against Amazon
primary docs (SP-API schema, KDP/Seller Central A+ guidelines, Amazon design blog).
This is the spec the A+ generator + qualification gate encode. Companion doc:
`aplus-ip-giftset-rules.md` (IP / gift-set legality — the harder gate).

## 0. Hard API facts (encode as constraints)

- **API:** A+ Content Management API **2020-11-01**. We have write access (role
  "Product Listing — includes A+ content", confirmed; validation returns 400 not 403).
- **Exactly 15 standard module types** are creatable (list below). **Premium A+ is
  NOT creatable via this API** (UI + eligibility-gated) — we build Basic/Standard A+.
- **Module count:** schema JSON-validates 1–100, but Amazon **REJECTS on submit above
  7 modules (sellers)**. Generator hard cap = **7**; default to **5** (UI-safe Basic).
- **Images:** JPEG or PNG, **RGB/sRGB only (no CMYK)**, **< 2 MB**, **≥ 72 dpi**, no
  animated GIFs, no watermarks / no unreadable small text. **Alt-text ≤ 100 chars** per
  image (and alt-text matters — see SEO). Ideal **970×600**; range 300×300 → 970×3000.
- **Flow:** create document → associate ASIN(s) → submit for approval. Validate first.

## 1. The 15 standard module types

| Module type (enum) | What it shows | Key specs (min image / char limits) |
|---|---|---|
| `STANDARD_HEADER_IMAGE_TEXT` | Full-width banner + headline/sub/body (hero) | img 970×600 · headline 150 · subheadline 150 · body 6000 |
| `STANDARD_SINGLE_IMAGE_HIGHLIGHTS` | One image + headline + bullet highlights | img + headline + bulleted highlights |
| `STANDARD_SINGLE_IMAGE_SPECS_DETAIL` | Image + spec/detail list | img + spec list |
| `STANDARD_SINGLE_SIDE_IMAGE` | Image on one side + text block | img + headline + body |
| `STANDARD_THREE_IMAGE_TEXT` | 3 images each w/ text | 3× img + text |
| `STANDARD_FOUR_IMAGE_TEXT` | 4 images + text (row) | 4× img + text |
| `STANDARD_FOUR_IMAGE_TEXT_QUADRANT` | 4 images + text (2×2 grid) | 4× img + text |
| `STANDARD_MULTIPLE_IMAGE_TEXT` | Image carousel + text | multiple img + text |
| `STANDARD_COMPARISON_TABLE` | Compare YOUR-brand products only | img 150×300 · column title 80 · metric 250 |
| `STANDARD_TEXT` | Text-only block | headline 160 · body 5000 |
| `STANDARD_PRODUCT_DESCRIPTION` | Description text block | body 6000 (no headline) |
| `STANDARD_TECH_SPECS` | Technical spec table | spec rows |
| `STANDARD_COMPANY_LOGO` | Brand logo | img 600×180 |
| `STANDARD_IMAGE_SIDEBAR` | Main image + sidebar image + text | img + sidebar + text |
| `STANDARD_IMAGE_TEXT_OVERLAY` | Image with text overlaid | single img + overlay text |

Component limits seen in schema: ParagraphComponent body maxLength 5000; PlainTextItem
500. Confirm exact comparison-table sub-fields (column title 80 vs a separate metric-name
~100) against the live 2020-11-01 schema at encode time.

## 2. Content policy — PROHIBITED (qualification gate must block these)

- **Pricing / promo / discounts:** "affordable", "cheap", "free", "bonus", "sale",
  "exclusive discount", "lowest price".
- **Shipping:** "free shipping", delivery promises.
- **Guarantee / warranty / satisfaction:** "100% satisfaction guaranteed", off-Amazon
  return/refund references.
- **Purchase CTAs:** "buy now", "add to cart", "get yours now", "shop with us".
- **Contact info / links:** phone, email, web addresses, ANY hyperlink (inside or
  outside Amazon).
- **Competitor references / comparisons:** none. **Comparison tables may ONLY contrast
  your OWN-brand products.** (Note: simply *naming* a third-party brand of an *included*
  product is a separate question — see the IP doc; the blanket "no third-party brand
  names in A+" claim was specifically REFUTED in research. The hard ban is on
  *competitor comparison*, not on factual mention of contents.)
- **Time-sensitive:** "now", "new", "latest", "on sale now".
- **Environmental claims (since Oct 21 2024):** "eco-friendly", "biodegradable",
  "compostable" — **in text OR images**.
- **Unsubstantiated superlatives / rankings:** "#1 rated", "top-rated", "best-selling".
- **Unsupported health/medical claims:** cure/treat/prevent/boost/detox (matches our
  existing brand-voice ban). Food gift baskets do NOT need the supplement FDA disclaimer.

These extend our existing brand-voice rules (no promo adjectives, no emojis, no health
claims) — reuse the same scrubber + add the A+-specific bans above.

## 3. SEO / indexing reality

- **A+ body text is NOT reliably indexed** by Amazon search (claims that it IS were
  refuted). Do NOT rely on A+ copy for ranking.
- **Text baked INTO an image is NOT read by Amazon at all.** → Keywords must live in
  **real text fields** (title, bullets, backend search terms) and in **image alt-text
  (≤100 chars)** — never only inside the picture pixels.
- A+ is a **CONVERSION lever** (~3–10% lift, practitioner estimate), not a ranking lever.
- Practical rule for the generator: put the semantic core in the listing's text fields;
  in A+, write benefit-first copy + fill every image's alt-text with the relevant keywords.

## 4. What converts (practitioner consensus — medium confidence)

- Lead with a strong **hero/header image** (`STANDARD_HEADER_IMAGE_TEXT`, 970×600).
- Use a **comparison table** to keep shoppers in OUR catalog (own-brand only).
- Favor **lifestyle / in-context imagery** alongside clean product shots.
- Order modules as a **benefit-first story**; use compliant benefit phrasing
  ("Designed to…") instead of forbidden CTAs.

## 5. Recommended default storyboard — food / grocery gift set (≤7 modules)

1. `STANDARD_HEADER_IMAGE_TEXT` — hero: the assembled gift basket, brand framing.
2. `STANDARD_SINGLE_IMAGE_HIGHLIGHTS` — what's inside (contents) + factual highlights.
3. `STANDARD_THREE_IMAGE_TEXT` (or FOUR) — close-ups of included items / use occasions.
4. `STANDARD_SINGLE_SIDE_IMAGE` — storage/handling / "how to enjoy" (factual).
5. `STANDARD_COMPARISON_TABLE` — compare our OWN gift-set variants (sizes/packs).
6. `STANDARD_COMPANY_LOGO` — Salutem Solutions / brand close.
(Cap at 7; drop modules rather than exceed.)

## Caveats / open questions
- A+ text-indexing status not definitively settled by a single primary source → treat
  as "do not depend on it."
- Comparison-table exact sub-fields: confirm against live schema before encoding.
- Premium A+ (full-width, video, interactive) needs the Brand-tools UI — out of scope
  for the API generator.
- Image depiction of third-party-brand contents is governed by the IP doc, not this one.
