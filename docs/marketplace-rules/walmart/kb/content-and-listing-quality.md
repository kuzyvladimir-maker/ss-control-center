# Walmart Marketplace — Content & Listing Quality (KB)

> Distilled, engineer-focused knowledge base compiled from Walmart Marketplace Learn
> guides (marketplacelearn.walmart.com). Factual reference for building/scoring
> Walmart listing tooling. All numbers are quoted from the source pages; where Walmart
> declines to publish a value (e.g. component weights), that is noted explicitly.
>
> **Compiled:** 2026-07-01. Walmart updates these guides without notice — re-verify
> hard numbers (pixel dims, char limits, variant caps) before relying on them in code.

## Fetch failures / gaps (read first)

- `academy/Catalog optimization/Listing-quality-&-rewards-dashboard` → returned
  **"No Data found"** (page retired). "High-offer listing quality" and any
  **reward tiers / fee-discount thresholds** could NOT be sourced. The Pro Seller
  reward linkage is mentioned only in passing by the Bulk Attribute Editor guide.
- **No published component weights.** Walmart states the Listing Quality components
  are **not equally weighted**, the algorithm **differs per product category**, and
  weighting **shifts over time** with purchase patterns. Any tool that hard-codes a
  weight is guessing. See §1.
- **No published numeric score bands** (what score = "good" vs "needs improvement").
  The dashboards surface issue *counts* per attribute, not weighted contributions.
- Some detail pages exist only under the `/ca/` (Canada) tree; where a US page was
  missing, the CA equivalent was used and is marked `[CA]`. US and CA content
  standards are near-identical but category style guides differ.

---

## 1. Listing Quality Score — what drives it

Source: https://marketplacelearn.walmart.com/guides/Listing%20optimization/Items%20and%20inventory/Listing-quality-and-rewards-dashboard
Source [CA]: https://marketplacelearn.walmart.com/ca/guides/Item%20setup/Variant%20management/listing-quality-dashboard?locale=en-CA

Two scores exist:
- **Item-level** Listing Quality score (one per listing).
- **Catalog-level** score = **average of the item-level scores**.

The US dashboard breaks the score into **five component categories**:

| Component | What it measures |
|---|---|
| **Content Quality** | Efficacy of item **name, description, key features, and images**. This is the lever sellers control directly (see §3–§6). |
| **Price Competitiveness** | Price vs. similar products on **external marketplaces**. |
| **Shipping** | Promised delivery speed across ZIP codes. **Excludes** items **> 50 lbs** or priced **≤ $10**. |
| **Published & In Stock** | How often the item is available to customers; based on the **last 7 days**. |
| **Ratings & Reviews** | Number of customer reviews and the average rating. |

The CA dashboard groups these under three headline buckets — **Content & Discoverability**,
**Offer** (price + shipping + stock), **Ratings & Reviews** — plus a **Post-Purchase
Quality** signal.

**Engineering-relevant rules:**
- **Post-Purchase Quality** (late deliveries, cancellations, returns) is tracked but
  **does NOT feed the Listing Quality score itself.**
- Components showing **`N/A` are excluded** from the overall calculation (e.g.
  Ratings & Reviews for a brand-new item).
- Weights are **not equal, not published, category-dependent, and time-varying**:
  > "The three categories in the breakdown section are not equally evaluated and the
  > algorithm can be different for all categories of products."
  > "Component impact on the listing quality score may differ per item."
- **Content Quality is the only fully seller-controllable input** and is the target
  of the Bulk Attribute Editor (§7). Optimize content first — it's deterministic;
  price/shipping/reviews are market- or ops-driven.

---

## 2. Content Standards — the frame

Source [CA]: https://marketplacelearn.walmart.com/ca/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/content-standard:-Overview
Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/Product-Detail-Page:-overview

- A product detail page (PDP) has four content pillars: **images, copy, attributes,
  rich media.**
- Walmart publishes **category style guides**, organized by **Product Type Group
  (PTG)** — 20+ categories (Animals → Vehicles). Each product type inherits its
  PTG's required attributes and copy rules. Always resolve the correct product type
  first (§8) because it selects which style guide + attribute set applies.
- **Accuracy is mandatory** across all content: all claims, images, and descriptions
  must match the delivered product (size, color, quantity, materials/ingredients,
  features, benefits, limitations).
- **AI-generated content is explicitly allowed but must be truthful, accurate, and
  not misleading** — held to the same accuracy bar as human-written content.

---

## 3. Product Title

Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/Product-Detail-Page:-overview

- **Hard limit: ≤ 150 characters.** (The keyword guide separately flags titles
  **> 200 chars** as "excessively long" — treat 150 as the enforced cap.)
- **Structure:** brief, clear, descriptive, front-loaded with relevant **attribute
  values** (size, count, weight). No single canonical formula is published; the
  recommended shape is **Brand + defining features/attributes + product name**,
  built from real attribute values.
- **Proper capitalization** required (title case).
- **Prohibited in titles:**
  - ALL CAPS
  - special characters
  - promotional language
  - **retailer / competitor names** (unless brand-licensed)
  - URLs
  - non-English text (allowed **only** if part of the item or brand name)
  - years (except where a category recommends them)
  - **keyword repetition** (same word repeated)
  - irrelevant info

---

## 4. Product Description

Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/Product-Detail-Page:-overview

- **Minimum length: ≥ 150 words** (category-specific variations exist; 150 is the floor).
- **Content:** feature + benefit focus; include product name, brand, and searchable
  keywords woven naturally.
- **Prohibited in descriptions:**
  - competitor-exclusivity claims
  - retailer names (unless licensed)
  - promotional language
  - authenticity claims (**exception:** food, or with explicit Walmart approval)
  - irrelevant info / off-topic content
  - external URLs
  - **emojis**
  - special characters
  - **bullet points** (descriptions are prose; bullets go in Key Features)
  - non-English text
  - keyword repetition

---

## 5. Key Features (bullets)

Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/Product-Detail-Page:-overview

- **Count: 3–10** of the most important benefits/features.
- **Per-feature limit: ≤ 80 characters** (spaces included). Anything over 80 is
  rejected/flagged.
- **Format:** short phrases, no keyword repetition.
- **Prohibited:** same set as descriptions — competitor-exclusivity, retailer names,
  promotional claims, URLs, emojis, special characters, HTML/numbered-list
  formatting, non-English text, keyword repetition.

---

## 6. Images

Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/Product-detail-page:-Image-guidelines-&-requirements

**Dimensions / format (hard specs):**

| Field | Value |
|---|---|
| Primary/recommended resolution | **2200 × 2200 px** |
| Minimum for zoom | **1500 × 1500 px** |
| Swatch image | **100 × 100 px** |
| Aspect ratio | **1:1 (square)** |
| Formats | **JPEG, JPG, PNG, BMP** (GIF **not** permitted; no animated GIFs) |
| Color mode | **RGB** |
| Bit depth | **8 bits/pixel** |
| Max file size | **≤ 5 MB** |
| Main-image background | **Seamless white, RGB 255/255/255** |

**Count:** recommend a **minimum of 4 images** per listing.

**Main image prohibitions** (also disallowed on Salutem's own brand voice — see project CLAUDE.md):
- watermarks, seller name, or logo
- accessories/props not included with the product
- claims or promotional language / text overlays / coupons / borders
- Walmart or competitor logos
- non-English text
- item-condition descriptions
- out-of-stock indicators
- stock photos are **not allowed** — must be the actual product

**Image-URL ingestion rules (relevant for programmatic feed pushes):**
- URL must **end in an image file extension** (`.jpg`, `.png`, etc.).
- Allowed ports: **8080, 80, 443, 8443**.
- **Rejected:** HTML pages, query strings, unencoded special characters, Dropbox
  URLs, non-public URLs.

> Cross-ref existing KB: `docs/marketplace-rules/walmart/images.md` and the project
> rule that the frozen cooler+gel-pack IS the product for food bundles (main-image
> "no props" rule does not flag it).

---

## 7. Content Quality remediation — Bulk Attribute Editor

Source: https://marketplacelearn.walmart.com/guides/Listing%20optimization/Items%20and%20inventory/Bulk-attribute-editor

- Bulk-edits **name, description, key features, and images** across many items.
- Filters items by **"Attributes with issues"** (missing description, too-few key
  features, low image count, etc.) — these are the flags that depress the **Content
  Quality** sub-score.
- Feeds directly into the **Content Quality score**, a key Listing Quality component,
  and improving it raises eligibility for **Pro Seller** status.
- Additional filters: Customer Favorites, WFS items, Listing Quality score, GMV,
  page views.
- **Latency: newly published offers can take up to ~1 week to reflect** in the
  dashboard — build this delay into any automated re-scoring loop.
- Some attributes are **gated to brand owners / authorized resellers**; a
  non-authorized seller's edits to those fields may be rejected or overridden.

---

## 8. Attributes & product-type categorization

Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/Product-detail-page:-Item-attribution-&-categorization

- Attributes = descriptive features (color, material, size, etc.). **Required for
  every item.** Missing attributes → "customers will likely have a hard time finding
  your items."
- **Requirement levels: required / recommended / optional.** Required must be filled;
  recommended/optional should be filled wherever data exists — **completeness drives
  discoverability, filters, and browse facets.**
- **Discoverability impact:** "High-quality attributes can also lead to better product
  discoverability and visibility, not only on Walmart.com but on other search engines
  as well." Attributes populate on-site **filters/facets** — an unfilled attribute
  drops the item out of the corresponding filter results.
- **Product-type hierarchy (3 tiers):**
  1. **Product Category** — broad grouping (e.g. Animals)
  2. **Product Type Group (PTG)** — similar properties (e.g. Animal Grooming)
  3. **Product Type** — specific type with a defined attribute set (e.g. Animal Shampoos)
- **Choosing the correct product type is critical** — "it can impact everything from
  shelving to sales." It also selects the applicable required-attribute set and style
  guide (§2).
- **Best practice:** reuse the same attribute values across title, description, and
  key features for consistency and keyword coverage.

> Cross-ref: this project's Walmart attribute config lives in
> `docs/marketplace-rules/walmart/attribute-keys.md`,
> `mp-item-food-attributes.md`, `category-numeric-ids.md`. Food PT covers ~all food
> bundles; PET_FOOD needs its own flat-file (see MEMORY: amazon-vs-walmart-attributes).

---

## 9. Keyword optimization / SEO

Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content,%20imagery,%20and%20media/Product-detail-page:-Keyword-optimization

- **Keyword placement:** title, description, key features.
- **Density rule:** pick **1–2 primary keywords**, use each **once** in title,
  description, and key features. **Do NOT repeat the same word** in a single title or
  description — repetition is explicitly penalized and flagged as a content issue.
- **Uniqueness:** prefer words **unique to Walmart.com** and not shared across other
  retailers; use terms matching how customers actually search.
- **Avoid:** unrelated keywords, word-stuffing, irrelevant terms (hurt Listing
  Quality), and titles **> 200 chars**.
- Keywords improve **organic search rank / SEO traffic**, but content must stay
  accurate and useful — relevance beats volume.

---

## 10. Variant groups

Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Variant%20management/Create-a-variant-group:-Full-Setup-Template
Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Variant%20management/Manage-a-variant-group

- A **variant group** ties related items (e.g. same shirt in multiple colors/sizes)
  under one PDP with a variant selector.
- **Variant attributes are dropdown-selected per product type. You CANNOT create
  custom variant attribute names.** If the needed attribute isn't offered, don't
  force a variant group.

**Item caps (hard limits):**

| Configuration | Max items |
|---|---|
| Variant group with **one** attribute | **≤ 50** |
| Variant group with **three or fewer** attributes | **≤ 500** |
| Multi-variant overall ceiling | up to **1,000** |

**Primary variant:**
- Mark the **top-selling item or the one with the most inventory** as primary.
- **Exactly one** item per group may be primary — more than one → submission fails.
- If the primary goes out of stock, the group stays valid but shows as unavailable.

**Swatch images:**
- Provide a **swatch URL per variation** (per color, **not** per size).
- Missing swatch → variants render as **text tiles** instead of visual swatches.
- Swatch spec: **100 × 100 px** (§6).

**Grouping behavior:**
- Walmart may **re-optimize variant display** based on customer search — it can differ
  from the seller's selection.
- When multiple sellers submit the same items, variant groups **merge automatically**.
- Best practice: limit variations to avoid confusion; use supported attribute names.

---

## Quick-reference cheat sheet (for validators)

| Field | Rule |
|---|---|
| Title | ≤ 150 chars, title-case, no ALL-CAPS/promo/special-chars/URLs/repeat words |
| Description | ≥ 150 words, prose (no bullets), no emojis/promo/URLs/repeat words |
| Key features | 3–10 bullets, ≤ 80 chars each (spaces incl.), no HTML/emojis |
| Main image | 2200×2200 px, 1:1, white RGB 255/255/255, JPEG/PNG/BMP, ≤ 5 MB |
| Zoom image min | 1500×1500 px |
| Swatch | 100×100 px |
| Images per listing | ≥ 4 recommended |
| Image URL | ends in image ext; ports 80/443/8080/8443; no query strings/HTML/Dropbox |
| Variant cap (1 attr) | ≤ 50 items |
| Variant cap (≤3 attrs) | ≤ 500 items (hard ceiling 1,000) |
| Primary variant | exactly 1 per group |
| Keywords | 1–2 primary, used once per field, no repetition |
| Attributes | fill all required + as many recommended/optional as data allows |
| Dashboard latency | new/edited offers reflect in up to ~1 week |
