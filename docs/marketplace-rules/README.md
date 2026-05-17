# Marketplace Rules Knowledge Base

> **Purpose:** Comprehensive policy reference для Bundle Factory's 9 sales channels
> **Maintained:** 2026-05-17
> **Files:** 45 markdown files across 4 channels + 1 comparison matrix
> **Used by:** Bundle Factory Stage 4 (Content Generation) AI prompts, Stage 6 (Validation) compliance checks

---

## 🎯 Структура

```
marketplace-rules/
├── README.md                              ← этот файл
├── CHANNEL_COMPARISON.md                  ⭐ Multi-channel deviation matrix
├── amazon/        (23 файла)
├── walmart/       (11 файлов)
├── ebay/          (5 файлов)
└── tiktok-shop/   (5 файлов)
```

---

## 📂 Amazon (23 файла)

### Core policy
- **`gift-set-policy.md`** ⭐ — фундамент: Oct 2024 Product Bundling Policy + Gift Basket Exception (browse node 12011207011)
- `bundle-policy.md` — общая Product Bundling Policy
- `restricted-products.md` — ASIN-level restrictions, pre-bundle component check
- `compliance-grocery.md` — FDA Big 9 allergens, original packaging requirement
- `brand-registry-benefits.md` — A+ Content, Virtual Bundles, Sponsored Brand, GTIN exemption

### Listing creation
- `title-policy.md` — 200 chars max, structure rules, forbidden patterns
- `bullet-points-policy.md` — 5 bullets, Vladimir's emoji pattern, gift context final bullet
- `description-policy.md` — HTML, A+ Content для Brand Registry
- `image-requirements.md` — 1000×1000+, white bg, no overlays, AI prompt template

### Browse nodes
- **`browse-nodes-grocery.md`** ⭐ — все 13 sub-categories verified с numeric IDs (включая Advent Calendars + dual hierarchy notes)

### GTIN / UPC
- **`gtin-exemption-process.md`** ⭐ — application process, Letter of Authorization template

### Categories (по storage temperature)
- `category-frozen-grocery.md` — Frozen: storage_temperature, cooler shipping, allergens
- `category-refrigerated.md` — Refrigerated: closer to frozen, slightly relaxed
- `category-shelf-stable.md` — Shelf-stable: simplest, Walmart-compatible
- `category-pet-food.md` — Pet food: AAFCO compliance, ungating

### Categories (по type — sub-categories)
- `category-cheese-charcuterie.md` — node 2255573011, dual hierarchy, refrigerated
- `category-coffee-tea.md` — nodes 23900459011 + 23700435011, shelf-stable, Q4 peak
- `category-candy.md` — node 2255572011, heat-sensitive Florida summer warning

### Advanced
- `prohibited-keywords.md` — consolidated TypeScript blocklists (promotional, superlatives, brand IP, health claims)
- `sp-api-attribute-schemas.md` — JSON Listings v2 schemas для GIFT_BASKET productType
- `atoz-claim-avoidance.md` — 5 главных причин claims + listing-time prevention
- `buy-box-rules.md` — FBM vs FBA dynamics, Vladimir's unique-ASIN monopoly strategy, cross-account sync

### Operations
- `fee-schedule.md` — 8%/15% referral, profitability calc на $60 bundle

---

## 📂 Walmart (11 файлов)

### Core
- `multipack-policy.md` — Food Gift Baskets category analog Amazon
- **`frozen-restrictions.md`** ⭐ — почему Vladimir не имеет Frozen access + application process
- `prohibited-items.md` — alcohol, tobacco, CBD, expired food
- `fee-schedule.md` — 8%/12% referral

### Listing creation
- `title-policy.md` — 75 chars max, no em-dash
- `images.md` — 1500×1500+, RGB 240+

### Categories
- `category-grocery.md` — Vladimir's access matrix (shelf-stable open, frozen closed)
- `category-numeric-ids.md` — string-path classification vs Amazon's numeric IDs
- **`food-gift-baskets-deep-dive.md`** ⭐ — Walmart's analog Gift Basket Exception, Phase 1 shelf-stable strategy

### Advanced
- `attribute-keys.md` — required attrs per category (Gift Baskets, Snacks, Coffee/Tea, Candy)
- `wfs-implications.md` — почему Walmart Fulfillment Services не подходит Vladimir's JIT-bundle model

---

## 📂 eBay (5 файлов)

- `basics.md` — channel overview, key differences vs Amazon/Walmart
- `fee-schedule.md` — 12.55% + $0.30, first 250 listings free, ~$7.83 per $60 bundle
- `grocery-deep-dive.md` — niche audience strategy, Item Specifics fields, 80-char title flexibility
- `sub-category-structure.md` — Gift Baskets (14282), Coffee (14302), Tea (14306), Candy (14309), Snacks (14299), Cheese (87014), Pantry (87016)
- `selling-limits.md` — new account 10 items/$500 → unlimited as Top Rated Seller progression

---

## 📂 TikTok Shop (5 файлов)

- `basics.md` — channel overview, 34-char mobile titles, video-first, 5-8% referral
- `approval-process.md` — 2-3 month timeline, business verification steps
- `content-rules.md` — 9:16 vertical video, Commercial Music Library, prohibited claims
- `food-compliance.md` — TikTok food restrictions (no frozen/refrigerated MVP), Vladimir's compatible bundle list
- `affiliate-program.md` — creator-driven sales engine, commission tiers (Standard 15% / Premium 20-25% / Bestseller 10-12%)

---

## ⭐ Top priority files (start here)

Если только что зашёл в KB:
1. **`amazon/gift-set-policy.md`** — фундамент всей стратегии Salutem Vita
2. **`amazon/browse-nodes-grocery.md`** — numeric IDs всех 13 sub-categories
3. **`CHANNEL_COMPARISON.md`** — горизонтальный slice через все 4 channels
4. **`amazon/gtin-exemption-process.md`** — UPC validation для Phase 1

---

## 🔧 Usage в Bundle Factory

### Stage 4 (Content Generation) AI prompts

KB файлы передаются как context для AI generation:

```typescript
const stage4Context = await loadKbContext({
  channel: 'AMAZON_SALUTEM',
  category: 'FROZEN_GROCERY',
  composition_type: 'CROSS_BRAND',
});
// Returns concatenated content из:
// - gift-set-policy.md
// - title-policy.md
// - bullet-points-policy.md
// - description-policy.md
// - category-frozen-grocery.md
// - browse-nodes-grocery.md
// - prohibited-keywords.md
```

### Stage 6 (Validation) compliance checks

Code snippets из KB файлов compiled в validation functions:

```typescript
import { validateTitle } from './validators/amazon-title';
import { validateGTIN } from './validators/amazon-gtin';
import { validateProhibitedKeywords } from './validators/prohibited';
import { validateAntiClaimPatterns } from './validators/atoz-claim';
// ...

const result = await runValidationPipeline(bundleDraft, [
  validateTitle,
  validateGTIN,
  validateProhibitedKeywords,
  validateAntiClaimPatterns,
  // ... 15+ validators total
]);
```

---

## 🔄 Maintenance

### Quarterly review (Vladimir + Claude)

Каждые 3 месяца:
1. Open Amazon/Walmart/eBay/TikTok Help Centers — check for policy updates
2. Update affected KB files
3. Update `MarketplaceRule` DB cache через seed re-run
4. Update wiki references

### When rules change

If marketplace updates policy:
1. Update specific KB file
2. Update `Last verified` date
3. Update DB cache (Bundle Factory `marketplace-rules-seed.ts`)
4. Re-test Stage 6 validators
5. Communicate change в Bundle Factory dashboard (Phase 3+)

---

## 🚧 Known gaps (Phase 2+)

- **Region-specific rules** — currently US-only; expansion в Canada/UK/EU requires region docs
- **Brand-specific seller authorization** — which brands Vladimir can resell без brand owner approval (research-heavy, per-brand)
- **B2B channels** — Amazon Business, Walmart Business pricing/policies (Phase 3+)
- **TikTok international markets** — UK, SEA expansion (Phase 4+)
- **Live shopping rules** — TikTok Live, Walmart Live (Phase 3+)

---

## 📚 Related project docs

- `docs/BUNDLE_FACTORY_CONCEPT_v1_0.md` — master concept
- `docs/BUNDLE_FACTORY_DATA_MODEL.md` — Prisma schema (`MarketplaceRule` model)
- `docs/BUNDLE_FACTORY_PHASE_0_COMPLETION_REPORT.md` — Phase 0 deliverables
- `docs/wiki/bundle-factory.md` — wiki overview

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17 · **Total files:** 45
