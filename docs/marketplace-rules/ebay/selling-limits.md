# eBay Marketplace — Selling Limits (New Account Progression)

> **Source:** eBay Seller Standards documentation
> **Last verified:** 2026-05-17
> **Priority:** P2 (relevant в Phase 2 launch period)

---

## TL;DR

eBay imposes **selling limits** на new accounts чтобы prevent fraud. New seller account starts с ~10 items / $500 monthly. Limits **gradually increase** через positive performance. Vladimir's Bundle Factory should respect these initial limits and progressively scale.

---

## 📊 Default new account limits

| Period | Max items / month | Max sales value / month |
|---|---|---|
| Days 1-30 (new) | 10 items | $500 |
| Days 31-90 | 25 items | $1,000 |
| Days 90+ (depending) | 100+ items | $5,000+ |
| Top Rated Seller status | Unlimited | Unlimited |

**Vladimir's strategy:** Start small, focus на perfect first 30 sales (no defects, fast shipping, positive feedback) → upgrade trigger.

---

## 🎯 How limits work

### Item limit

- Active + scheduled + draft listings count
- Auctions count as 1 (even если 7-day listing)
- Variations count as separate (5 sizes × 3 colors = 15 items)

### Value limit

- Active + sold listings within rolling 30-day window
- Includes pending sales (not yet paid)

### "Limit reached" behaviour

- New listings cannot be created
- Existing listings remain active (don't auto-pause)
- Можно request limit increase каждые 30 days

---

## 🚀 Strategies для quick limit increase

### 1. Stellar first 30 days

- **100% on-time shipping**
- **100% tracking provided**
- **Zero defects** (no returns, no claims)
- **5-star feedback** на каждой transaction
- **Respond to messages within 24h**

### 2. Request manual limit increase

После 30 days с good performance:
- Seller Center → Performance → Selling Limits → "Request higher limits"
- Provide justification (стабильный track record на other platforms = Amazon)
- Provide business documentation (LLC, EIN)

### 3. Anchor / Premium Store subscription

eBay Store subscription ($21.95-$59.95/month) — automatically increases limits + provides additional free listings.

---

## 📋 Bundle Factory limit-aware launch plan

### Phase 2 Week 1-4: Foundation

- Open Vladimir's eBay business account (Salutem Solutions LLC)
- Wait verification (1-3 days)
- Create **10 listings** (shelf-stable Salutem Vita bundles)
- Each at price ≤ $50 → first month max value ~$500
- Goal: 5-10 transactions, perfect performance

### Phase 2 Week 5-12: Scale

- After 30 days good performance, request limit upgrade
- Add **25-50 more listings**
- Diversify categories (coffee, tea, candy, snacks)
- Goal: 30-50 transactions, build Top Rated Seller progress

### Phase 2 Month 4+: Full scale

- Convert to Top Rated Seller (100+ transactions, <0.5% defect rate)
- Unlimited listings
- 10% FVF discount applied
- Capacity: 200-500 active listings

---

## ⚠️ Common limit pitfalls

### 1. Hitting limit mid-month → stuck

If Vladimir creates 25 listings on day 1 but limit is 10, eBay rejects 15. Workaround: stagger launches.

### 2. High-value items eating limit

$60 bundle × 10 = $600 — already over $500 monthly value limit. Solution: lower initial pricing OR fewer initial listings.

### 3. Variations counting separately

If Vladimir lists "Salutem Vita Coffee Gift Set" с 3 variants (light/medium/dark roast) — counts as 3 items, not 1.

### 4. Cancelled transactions blocking limit refresh

If buyer cancels — value still counts towards limit until next month rollover.

---

## 🔧 Bundle Factory enforcement

```typescript
async function canPublishToEbay(masterBundle: MasterBundle, price: number): Promise<{ ok: boolean; reason?: string }> {
  const currentMonth = getCurrentMonthStart();
  
  const activeListings = await prisma.channelSKU.count({
    where: {
      channel: 'EBAY',
      lifecycle_status: { in: ['LIVE', 'PROCESSING'] }
    }
  });

  const monthlyValue = await prisma.channelSKU.aggregate({
    where: {
      channel: 'EBAY',
      created_at: { gte: currentMonth }
    },
    _sum: { price_cents: true }
  });

  const settings = await getEbaySellerLimits(); // cached from Account API
  
  if (activeListings >= settings.maxItems) {
    return { ok: false, reason: `eBay item limit reached: ${activeListings}/${settings.maxItems}` };
  }

  const valueWithBundle = (monthlyValue._sum.price_cents || 0) + (price * 100);
  if (valueWithBundle > settings.maxMonthlyValue * 100) {
    return { ok: false, reason: `eBay monthly value limit would be exceeded: $${valueWithBundle/100} > $${settings.maxMonthlyValue}` };
  }

  return { ok: true };
}
```

---

## 📊 Performance metrics tracking

eBay Seller Standards measure:
- **Defect rate** (transactions с issues / total): <0.5% для Top Rated
- **Late shipment rate**: <3% для Top Rated
- **Tracking uploaded rate**: >95%
- **Cases not resolved by seller**: <0.3%

Bundle Factory + Customer Hub должна track these realtime → flag any drop preemptively.

---

## 🔗 Top Rated Seller benefits

After achieving:
- ✅ 100+ transactions в past 12 months
- ✅ <0.5% defect rate
- ✅ <3% late shipment rate
- ✅ Tracking on >95% transactions

Получает:
- 10% FVF discount
- Top Rated Plus badge on listings (improves CTR)
- Promoted Listings priority в auctions
- Buyer-paid returns option (Vladimir's already standard)
- Unlimited selling limits

Target для Vladimir: 6-12 months after eBay launch.

---

## References

- eBay Seller Standards: https://www.ebay.com/help/policies/selling-policies/seller-performance-policy
- Selling Limits: https://www.ebay.com/help/selling/selling/selling-limits
- Top Rated Seller: https://www.ebay.com/help/selling/managing-store-sales/top-rated-seller-status
- Internal: [`basics.md`](basics.md), [`grocery-deep-dive.md`](grocery-deep-dive.md), [`fee-schedule.md`](fee-schedule.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
