# TikTok Shop — Affiliate Program

> **Source:** TikTok Shop Affiliate Center
> **Last verified:** 2026-05-17
> **Priority:** P2 (Phase 2 growth lever)

---

## TL;DR

TikTok Shop Affiliate Program = creator-driven sales engine. Vladimir's products become eligible для creators to promote в их videos для commission. **80% of TikTok Shop sales** идут через Affiliate creators. Vladimir's brand strategy: set 15-25% commission rate для optimal creator interest.

---

## 🎯 How Affiliate Program works

### Setup flow (seller side)

1. Open TikTok Shop business account → Marketing → Affiliate
2. Set **default commission rate** per category (e.g. Food: 15%)
3. Mark products as **Affiliate-eligible**
4. Optionally: set higher rate для specific bundles (premium 25%, standard 15%)
5. Wait для creators to discover + apply

### Creator flow

1. Creator joins TikTok Shop Affiliate Center
2. Browses available products → finds Vladimir's gift sets
3. Creates promotional video (their channel, their style)
4. Adds product link to video → buyers can purchase directly в TikTok app
5. Earns commission на каждой sale через their video

### Revenue split (per sale)

For $60 bundle с 20% commission:
- TikTok platform fee: 8% × $60 = $4.80
- Affiliate commission: 20% × $60 = $12.00
- **Vladimir net:** $43.20 (vs $55.20 без affiliate)

Looks expensive — но Affiliate-driven sales are **incremental** (creator brings buyer who wouldn't have found Vladimir otherwise). Net more revenue overall.

---

## 💰 Commission rate strategy

### Tier 1: Standard products (15%)

- Default rate для most bundles
- Competitive в food category
- Attracts mid-tier creators (10K-100K followers)

### Tier 2: Premium / launch bundles (20-25%)

- New product launches
- High-margin bundles
- Attracts top creators (100K+ followers)
- Worth higher commission для initial momentum

### Tier 3: Bestsellers (10-12%)

- Already-popular bundles
- Reduce commission once organic demand strong
- Save margin

### Tier 4: Closeouts / clearance (30-40%)

- High-commission incentive для quick clearance
- Limited duration

---

## 📋 Bundle Factory Affiliate management

`ChannelSKU` extension:

```prisma
model ChannelSKU {
  // existing fields
  
  affiliate_enabled       Boolean  @default(false)
  affiliate_commission_pct Float?  // 15.0 = 15%
  affiliate_tier          String?  // 'STANDARD' | 'PREMIUM' | 'BESTSELLER' | 'CLEARANCE'
}
```

Bundle Factory UI page `/bundle-factory/affiliate` (Phase 2+):
- Bulk-set commissions
- Per-bundle override
- Performance tracking — affiliate-driven sales % per bundle

---

## 🎬 What makes a video Affiliate-friendly

For Vladimir's gift sets, ideal Affiliate videos:

1. **Unboxing reveal** — creator opens Salutem Vita gift box, shows surprise
2. **Gift suggestion content** — "Perfect gift for [audience]" videos
3. **Recipe / use case** — creator uses bundle components in lunch prep
4. **Comparison / review** — "I tried 5 frozen gift sets, here's the best"
5. **Holiday / seasonal** — Christmas gift guide, Valentine's, etc.

Bundle Factory должна provide creators с:
- High-quality product photos
- Suggested talking points (без scripting)
- Authentic product samples (Vladimir sends free product to top creators)

---

## 🚀 Affiliate strategy для Vladimir's Phase 2 launch

### Month 1: Foundation

- Mark **all** Salutem Vita bundles Affiliate-eligible
- Default commission: 20% (higher attract initial creators)
- Apply for **TikTok Shop verified seller** badge

### Month 2-3: Build creator network

- Reach out to 20-50 micro-influencers (10K-100K) в food/lifestyle niche
- Send **free samples** to top 10
- Track which creators drive most sales
- **Boost commission** для high-performers (25-30%)

### Month 4+: Scale + optimize

- Reduce commission на bestsellers (15%)
- Maintain premium rate для new launches
- Build dedicated creator partnerships (exclusive products?)

### Year 1+ goal

- 30-50% revenue через Affiliate
- Top 5-10 creator partners drive 60% of Affiliate revenue
- Brand recognition построена через consistent creator content

---

## 🚨 Affiliate program rules

### Creator restrictions

- ✅ Verified TikTok creators only (not new accounts)
- ✅ Must follow content guidelines (no misleading claims)
- ✅ Must disclose `#ad` или `#sponsored` в videos
- ❌ Cannot make false claims about product
- ❌ Cannot use copyrighted music inappropriately

### Vladimir's compliance check

Vladimir не controls creator videos directly — но через TikTok Shop dashboard can:
- Report misleading videos for review
- Pause Affiliate program для specific creator
- Set "blocked creators" list

### Performance monitoring

Bundle Factory Phase 2+ widget:
- Top 10 Affiliate creators by revenue
- Affiliate conversion rate per bundle
- Commission spend per month
- ROI calculation: revenue brought vs commission paid

---

## 📊 Bundle Factory metrics tracking

```typescript
model AffiliateSale {
  id                    String   @id @default(cuid())
  channel_sku_id        String
  channel_sku           ChannelSKU @relation(fields: [channel_sku_id], references: [id])
  
  creator_id            String   // TikTok creator handle
  creator_followers     Int?
  
  sale_amount_cents     Int
  commission_amount_cents Int
  vladimir_net_cents    Int
  
  video_url             String?
  video_views           Int?
  
  sold_at               DateTime @default(now())
}
```

---

## 🔧 Implementation timing

| Phase | Action |
|---|---|
| Phase 1 (current) | NO Affiliate work (Vladimir's TikTok Shop not yet approved) |
| Phase 2 launch | After TikTok approval, enable Affiliate on first 20 bundles |
| Phase 3 | Scale + automate creator outreach |
| Phase 4+ | Build owned creator network |

---

## References

- TikTok Affiliate Center: https://affiliate-us.tiktok.com/
- TikTok Shop Seller University: https://seller-us.tiktok.com/university
- Content guidelines: https://www.tiktok.com/community-guidelines
- Internal: [`basics.md`](basics.md), [`approval-process.md`](approval-process.md), [`content-rules.md`](content-rules.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
