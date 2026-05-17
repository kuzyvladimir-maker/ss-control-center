# TikTok Shop — Content Rules

> **Source:** TikTok Seller University + Shop Policies
> **Last verified:** 2026-05-17
> **Priority:** P2 (Phase 2 channel)

---

## TL;DR

TikTok Shop = **video-first marketplace**. Content rules радикально отличаются от Amazon/Walmart: short-form video preferred, emoji + creator culture, музыка (если licensed), strict no-misinformation policy, age-appropriate language. Vladimir's gift sets — visually presentable → fits TikTok algorithm well.

---

## 🎬 Video content rules (primary)

### Format

- **Length:** 9-60 seconds optimal (15-30s best for conversion)
- **Aspect ratio:** 9:16 vertical (mobile-first)
- **Resolution:** 1080×1920 (HD vertical)
- **File format:** MP4, MOV
- **File size:** ≤500MB

### Required elements в product video

- ✅ Show **actual product** prominently (≥40% of frames)
- ✅ Show **usage / unboxing** (буyer experience)
- ✅ Brand name visible (Salutem Vita on box)
- ✅ Voice-over or text overlay describing product
- ❌ No misleading "before/after" claims
- ❌ No fake reviews / testimonials
- ❌ No copyrighted music без licensed access

### Music

- Use **TikTok's Commercial Music Library** (CML) — free for business accounts
- НЕ использовать chart hits / Spotify / artist songs → copyright strike
- Trending sounds могут быть used IF в Commercial Music Library

---

## 📝 Text content rules

### Product title (≤60 chars, mobile-truncated ~34)

```
🎁 Pizza Lunch Gift Set 12-Pack 🍕
```

vs Amazon's:
```
Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12 (79 chars)
```

TikTok front-loads emoji + benefit + format. Brand name optional в title (можно в description).

### Description (≤1000 chars, supports basic formatting)

```
🍕 The ultimate frozen pizza gift box! 

What's inside:
✨ 12 individually wrapped Lunchables Pizza meals
🎁 Salutem Vita branded gift box presentation
❄️ Ships frozen Mon-Wed with insulated packaging
🛡️ 100% Freshness Guaranteed

Perfect for:
- Birthday surprises 🎂
- Holiday gifts 🎄
- Office appreciation ☕
- Last-minute hostess gift 🌹

Contains: Milk, Wheat, Soy. Check labels for full allergens.
```

---

## 🚫 Prohibited content

### Misleading claims

- ❌ "Best gift ever" — subjective superlative
- ❌ "FDA approved" если не actually approved
- ❌ "100% guaranteed weight loss" — health claim
- ❌ Fake scarcity ("Only 5 left!" если inventory unlimited)

### Sensitive topics

- ❌ Political/religious content
- ❌ Tragedy exploitation
- ❌ Stereotyping audiences

### Restricted categories (food specific)

- ❌ Alcohol (даже beer/wine)
- ❌ Tobacco / vape
- ❌ Cannabis / CBD
- ❌ Caffeine pills / energy supplements в high doses
- ❌ Weight loss supplements
- ❌ Raw / unpasteurized food
- ❌ Recalled items

### Trademark / brand IP

Аналогично Amazon/Walmart — нельзя use foreign brands в Vladimir's brand position. НО показывать components в video OK:
- ✅ Video shows Lunchables packaging close-up
- ✅ Voice-over: "Includes 12 Lunchables Pizza meals..."
- ❌ Title: "Lunchables Gift Set by Salutem Vita"

---

## 🎯 Visual content best practices

### Image requirements (если video не используется)

- Main image: 1080×1080 square (square preferred over Amazon's 1000×1000)
- White background OK но lifestyle backgrounds **also acceptable** (TikTok менее strict)
- Up to 9 images per listing
- Mobile-optimized (visible at thumbnail size)

### Video best practices

Top-performing TikTok product videos:
1. **Hook within 3 seconds** — visual surprise, question, "POV: ..."
2. **Unboxing reveal** — buyer opens gift box, shows contents
3. **Use case scenario** — "Gift this to your friend who..."
4. **Call to action** — "Tap to buy" overlay
5. **Background music** — trending CML track
6. **Captions** — overlay text для muted viewing

### Avoid

- ❌ Static product slideshow (low engagement)
- ❌ Music from chart artists (copyright strike)
- ❌ Overuse of stock footage
- ❌ Talking-head explanation videos (грим — keep visual)

---

## 🎨 Vladimir's Bundle Factory video strategy

Phase 2+: integrate Higgsfield для auto-generation of TikTok-ready videos:

```typescript
async function generateTikTokVideo(masterBundle: MasterBundle): Promise<string> {
  const video = await higgsfield.generateProductVideo({
    productImage: masterBundle.main_image_url,
    productDescription: masterBundle.name,
    durationSeconds: 15,
    style: 'unboxing-reveal',
    music: 'commercial-trending-1', // from CML
    overlayText: [
      'POV: You\'re the best gift-giver',
      `${masterBundle.pack_count} surprise items`,
      'Ships frozen for freshness',
      'Tap to buy ⬇️'
    ]
  });
  
  return video.url; // CDN-hosted
}
```

Higgsfield (Vladimir's existing tool) → AI generates short product videos. Cost ~$2-5 per video.

---

## 📋 TikTok Shop posting rules

### Frequency

- Optimal: 1-2 product posts per day (через creator content)
- For Vladimir's product page: weekly refresh main video
- Holiday / event-driven posts get boost

### Engagement rules

- Respond to comments within 24h
- Address negative feedback constructively
- Encourage user-generated content (gift recipients posting reactions)

### Live shopping

Phase 3+: TikTok Live shopping events
- Real-time selling
- Limited-time discounts
- Affiliate creator can host

---

## 🔧 Stage 4 (Content Generation) для TikTok

```typescript
function buildTikTokListing(masterBundle: MasterBundle, channelSku: ChannelSKU) {
  return {
    productName: shortenTitleForTikTok(channelSku.title, 60), // ≤60 chars
    productDescription: formatTikTokDescription(channelSku.description),
    productCategory: mapTikTokCategory(masterBundle.category),
    
    // Pricing
    skuList: [
      {
        sku: channelSku.sku,
        upc: channelSku.upc,
        price: { amount: channelSku.price_cents / 100, currency: 'USD' },
        inventory: 100, // JIT effectively unlimited
      }
    ],
    
    // Visual
    mainImageUrl: masterBundle.main_image_url,
    additionalImages: masterBundle.secondary_images || [],
    productVideo: channelSku.attributes?.tiktok_video_url || null, // optional but boosts conversion 5x
    
    // Compliance
    allergens: aggregateAllergens(masterBundle.components),
    expirationInfo: 'Best within 3 months',
    
    // TikTok-specific
    isAffiliate: true, // allow creator promotion
    affiliateCommission: 15, // % share with creators
    occasion: ['Christmas', 'Birthday', 'Thank You'],
  };
}
```

---

## References

- TikTok Seller University: https://seller-us.tiktok.com/university
- Commercial Music Library: https://commercialmusic.tiktok.com/
- Content policies: https://seller-us.tiktok.com/university/article?article_id=10000000000
- Internal: [`basics.md`](basics.md), [`food-compliance.md`](food-compliance.md), [`affiliate-program.md`](affiliate-program.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
