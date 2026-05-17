# Multi-Channel Deviation Matrix — Amazon vs Walmart vs eBay vs TikTok Shop

> **Last verified:** 2026-05-17
> **Priority:** P1 — single reference point для cross-channel Bundle Factory generation
> **Related:** все файлы в `marketplace-rules/{amazon,walmart,ebay,tiktok-shop}/`

---

## TL;DR

Этот документ — **горизонтальный slice** через все 4 channels, показывающий где правила различаются. Bundle Factory Stage 4 (Content Generation) использует это как single source of truth для adapt одного MasterBundle под разные ChannelSKU.

Channels covered:
- **Amazon** (5 accounts: Salutem Solutions, Personal, AMZ Commerce, Sirius International, Retailer Distributor)
- **Walmart Marketplace**
- **eBay**
- **TikTok Shop** (2 accounts: TIKTOK_1, TIKTOK_2)

---

## 📋 Master comparison table

### Title rules

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Max length | 200 chars | 75 chars | 80 chars | 60 chars (mobile-truncated ~34) |
| Brand position | First | First | Flexible | Optional / late |
| Emoji allowed | ❌ Strict no | ❌ No | ⚠️ Tolerated | ✅ Encouraged |
| Em-dash (–) | ✅ OK | ❌ Use hyphen | ✅ OK | ✅ OK |
| Promotional language | ❌ Strict no | ❌ Stricter | ⚠️ Tolerated | ⚠️ Some allowed |
| Foreign brand IP | ❌ Forbidden | ❌ Forbidden | ⚠️ More flexible | ❌ Forbidden in brand position |

### Image rules

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Resolution | ≥1000×1000 | ≥1500×1500 | ≥500×500 (recommend 1600+) | ≥1080×1080 |
| Aspect ratio | Square (1:1) | Square (1:1) | Flexible (1:1 preferred) | Square OR 9:16 |
| Background | Pure white RGB 255 | Near-white RGB 240+ | Flexible (lifestyle OK) | Flexible (lifestyle preferred) |
| Text overlays | ❌ Strict no | ❌ No | ⚠️ Tolerated | ✅ Yes (engagement boost) |
| Lifestyle backgrounds (main) | ❌ No | ❌ No | ✅ OK | ✅ Preferred |
| Max images | 9 (main + 8) | 1 main + 8 secondary | 12 free | 9 |
| Video supported | ⚠️ Limited (A+) | ⚠️ Limited | ✅ Yes | ✅ **REQUIRED** для conversion |

### Description rules

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Max length | 5500 chars | 4000 chars | ~25000 (effectively unlimited) | 1000 chars |
| HTML allowed | ✅ Limited (Brand Registry) | ❌ Plain text only | ✅ Full HTML | ⚠️ Basic formatting |
| External links | ❌ No | ❌ No | ⚠️ Restricted | ❌ No |
| Promotional language | ❌ Restricted | ❌ Restricted | ✅ Allowed | ✅ Allowed |

### UPC / GTIN

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| GS1 UPC required | ✅ (or exemption) | ✅ Strict (GEPIR check) | ⚠️ "Does Not Apply" allowed | ✅ Required |
| Brand Registry / Verification | Required для exemption | Brand Verification process | Optional но recommended | Required для food |
| Vladimir's status | ✅ Salutem Vita registered | ⚠️ TBD verify | TBD apply Phase 2 | TBD apply Phase 2 |

### Categories / Browse nodes

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| ID format | Numeric (e.g. 12011207011) | String path (e.g. "Food > Gift Baskets") | Numeric (e.g. 14282) | String + ID |
| Main gift basket node | 12011207011 (Food Assortments & Variety Gifts) | Food > Gift Baskets | 14282 (Food Gift Baskets) | "Food & Beverage > Gift Sets" |
| Gift basket exception (multi-brand) | ✅ Yes (Oct 2024) | ✅ Yes (analog) | ✅ Yes (more flexible) | ⚠️ Limited |

### Storage / Shipping

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Frozen support | ✅ Full (после ungating) | ❌ Vladimir blocked | ⚠️ Possible но tricky | ❌ Not for MVP |
| Refrigerated support | ✅ Full | ❌ Vladimir blocked | ⚠️ Possible | ❌ Not for MVP |
| Shelf-stable | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| Mon-Wed ship restriction (frozen) | ✅ Vladimir's policy | N/A | Buyer expects faster | N/A |
| Custom packaging (gift box) | ✅ Full control (FBM) | ✅ SF only / not WFS | ✅ Full control | ✅ Full control |

### Pricing & Fees

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Referral fee (Grocery) | 8% (≤$15) / 15% (>$15) | 8% (≤$10) / 12% (>$10) | 12.55% + $0.30/order | 5-8% |
| Min fee | $0.30 | $0.30 | included | Variable |
| Per-listing fee | $0 | $0 | $0 (first 250/mo) | $0 |
| Variable closing fee | N/A для Grocery | N/A | N/A | N/A |
| **Net на $60 sale** | **$9.00** | **$7.20** | **$7.83** | **$3-5** |

### Affiliate / Promotion

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Affiliate program | Amazon Associates (limited для seller) | Walmart Creator (Phase 2+) | eBay Partner Network | ⭐ Affiliate Center (PRIMARY driver) |
| Default commission | N/A | N/A | N/A | 15-25% |
| Creator marketplace | Influencer programs | Creator API | Promoted Listings (PPC) | Built-in (TikTok creators) |
| % sales через affiliate | <10% | <10% | <10% | **~80%** |

### Buy Box / Competition

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Concept | Buy Box | Featured Buy / Pro Seller Badge | Best Match algorithm | Algorithmic feed |
| Vladimir's strategy | Unique ASIN monopoly | Same-strategy | Unique listings | New product feed boost |
| Cross-account competition | 5 Vladimir accounts can compete | Single account | Single account | 2 Vladimir accounts |

### Returns & A-to-Z

| Aspect | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Default return policy | 30-day buyer-funded | 30-day buyer-funded | Configurable (30/60/90) | 14-day |
| Claim dispute system | A-to-Z Guarantee | Walmart Dispute | eBay Money Back Guarantee | Tiktok Resolution |
| Buy Shipping protection | ✅ Yes (Veeqo integration) | ⚠️ Limited | ✅ eBay-USPS | ⚠️ Limited |

---

## 🎯 Channel-specific deviations Bundle Factory должна handle

### Title generation logic

```typescript
function generateTitle(masterBundle: MasterBundle, channel: SalesChannel): string {
  switch (channel) {
    case 'AMAZON_SALUTEM':
    case 'AMAZON_PERSONAL':
    case 'AMAZON_AMZCOM':
    case 'AMAZON_SIRIUS':
    case 'AMAZON_RETAILER':
      return generateAmazonTitle(masterBundle, { maxLength: 200, noEmoji: true, brandFirst: true });
    
    case 'WALMART':
      return generateWalmartTitle(masterBundle, { maxLength: 75, noEmDash: true, noEmoji: true });
    
    case 'EBAY':
      return generateEbayTitle(masterBundle, { maxLength: 80, keywordsHeavy: true });
    
    case 'TIKTOK_1':
    case 'TIKTOK_2':
      return generateTikTokTitle(masterBundle, { maxLength: 60, allowEmoji: true, frontLoadBenefit: true });
  }
}
```

### Image asset selection

```typescript
function selectImageAssets(masterBundle: MasterBundle, channel: SalesChannel) {
  const assets = {
    main: masterBundle.main_image_url,
    secondary: masterBundle.secondary_images,
  };

  switch (channel) {
    case 'WALMART':
      // Walmart requires HIGHER resolution
      return enforceMinResolution(assets, 1500, 1500);
    
    case 'TIKTOK_1':
    case 'TIKTOK_2':
      // TikTok ideally wants video — fallback to images
      return {
        ...assets,
        primary_video: masterBundle.tiktok_video_url || null,
      };
    
    case 'EBAY':
      // eBay allows up to 12 images — include all available
      return { ...assets, max_count: 12 };
    
    default:
      return assets;
  }
}
```

### Channel availability filter

Не каждый bundle подходит для каждого channel:

```typescript
function isChannelEligible(masterBundle: MasterBundle, channel: SalesChannel): { eligible: boolean; reason?: string } {
  // Frozen / refrigerated не для Walmart (Vladimir не имеет access)
  if (channel === 'WALMART' && ['FROZEN_GROCERY', 'REFRIGERATED'].includes(masterBundle.category)) {
    return { eligible: false, reason: 'Walmart frozen/refrigerated access not granted' };
  }

  // Frozen / refrigerated не для TikTok MVP
  if (['TIKTOK_1', 'TIKTOK_2'].includes(channel) && ['FROZEN_GROCERY', 'REFRIGERATED'].includes(masterBundle.category)) {
    return { eligible: false, reason: 'TikTok MVP shelf-stable only' };
  }

  // Pet food отложено
  if (masterBundle.category === 'PET_FOOD' && !['AMAZON_SALUTEM'].includes(channel)) {
    return { eligible: false, reason: 'Pet food initially Amazon Salutem only' };
  }

  return { eligible: true };
}
```

---

## 📊 Channel performance heuristics

Phase 2+ Bundle Factory tracking:

| Metric | Amazon | Walmart | eBay | TikTok Shop |
|---|---|---|---|---|
| Expected conversion rate | 8-15% (Buy Box win) | 5-10% | 3-7% | 10-20% (viral video) |
| Average order value (Vladimir's gift sets) | $45-75 | $40-70 | $35-65 | $25-50 |
| Customer LTV | High | Medium | Low | High (если viral) |
| Sales velocity | Steady | Steady, lower | Spikes | Viral (high variance) |
| Effort to maintain | Low (Brand Registry) | Medium (compliance) | Medium (relisting) | High (content) |

---

## 🚀 Stage 7 (Distribution) priority

Default publish order для new MasterBundle:

1. **Amazon Salutem Solutions** (PRIMARY) — Brand owner, full Buy Box
2. **Amazon Personal** — secondary buy box, redundancy
3. **Amazon AMZ Commerce** — additional inventory
4. **Amazon Sirius International** — Starfit bundles primary
5. **Amazon Retailer Distributor** — flex channel
6. **Walmart** — if shelf-stable
7. **eBay** — Phase 2+
8. **TikTok 1** — Phase 2+ (shelf-stable only)
9. **TikTok 2** — Phase 2+

`MasterBundle.distribution_strategy` field controls который channels enabled.

---

## 🔄 Multi-channel sync rules

### Same-day sync triggers

- **Price change** → propagate to all 9 channels simultaneously
- **Inventory pause** → pause all channels (or specific subset)
- **Image refresh** → all channels (each may auto-process via CDN re-fetch)

### Eventual consistency tolerated

- **Title micro-edits** — sync within 24h OK
- **Description updates** — sync within 24h OK  
- **Browse node changes** — manual review, not auto-sync

---

## 🚨 Channel-specific compliance lockouts

### Amazon — A-to-Z claim spike

If a particular bundle получает >2% A-to-Z claims → pause from all 5 Amazon accounts. Investigate via Account Health monitor.

### Walmart — performance score

If Walmart Performance score drops <70% (8 metrics) → ChannelSKU lifecycle status = SUSPENDED until performance recovers.

### eBay — Top Rated Status loss

If defect rate >0.5% → lose Top Rated bonus, 10% FVF discount gone, profitability hit.

### TikTok — content violations

3+ video flags → account warning. Vladimir must respond fast through Customer Hub.

---

## 📚 Source documents

Each rule above sourced from specific KB document:

- Amazon: `marketplace-rules/amazon/*.md` (23 files)
- Walmart: `marketplace-rules/walmart/*.md` (11 files)
- eBay: `marketplace-rules/ebay/*.md` (5 files)
- TikTok Shop: `marketplace-rules/tiktok-shop/*.md` (5 files)

Conflicts между этим matrix и source doc → **source doc wins** (this is summary, not authority).

---

## 🚧 Known gaps (Phase 2+)

- [ ] **Region-specific rules** — Canada, UK, EU expansion (currently US-only)
- [ ] **Brand-specific seller authorization lists** — which brands can Vladimir resell без brand owner approval (requires deep research per brand)
- [ ] **B2B / Wholesale channels** — Amazon Business, Walmart Business (Phase 3+)
- [ ] **International TikTok Shop** — UK/SEA markets (Phase 4+)

---

## References

- All `marketplace-rules/{amazon,walmart,ebay,tiktok-shop}/` files
- Bundle Factory concept: `BUNDLE_FACTORY_CONCEPT_v1_0.md`
- Data Model: `BUNDLE_FACTORY_DATA_MODEL.md`

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
