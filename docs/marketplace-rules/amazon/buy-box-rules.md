# Amazon Buy Box Rules (FBM perspective)

> **Last verified:** 2026-05-17
> **Priority:** P1 для multi-seller competition; P0 для cross-account strategy

---

## TL;DR

Buy Box = the "Add to Cart" button winner на product page. ~83% of Amazon sales идут через Buy Box. Vladimir's strategy = each bundle = **unique ASIN** (no Buy Box competition initially). НО если competitors начнут replicating (создавая matching ASINs или offers на Vladimir's ASINs) — Buy Box dynamics включаются. Brand Registry + cross-account authorization защищают позицию.

---

## 🎯 Buy Box eligibility factors

Amazon's algorithm учитывает:

1. **Performance metrics** (most important):
   - Order Defect Rate (ODR) < 1%
   - Late Ship Rate (LSR) < 4%
   - Cancellation Rate < 2.5%
   - Valid Tracking Rate (VTR) > 95%

2. **Fulfillment method**:
   - FBA > FBM (default boost FBA)
   - FBM с Buy Shipping protection + valid tracking ≈ FBA

3. **Pricing**:
   - Competitive vs other sellers
   - Total landed cost (price + shipping) compared

4. **Shipping speed**:
   - Faster delivery promise = boost
   - Vladimir's JIT 2-day handling + FBM ground = "Standard" speed

5. **Inventory**:
   - Stock availability (Bundle Factory JIT = "always available")
   - Stockouts hurt Buy Box

6. **Customer service**:
   - Response time < 24h (Customer Hub critical)
   - Account health overall

7. **Seller tenure / volume**:
   - More history = более eligible

---

## 🛡️ Vladimir's Buy Box strategy

### Default state: монополия на собственном ASIN

Каждый Salutem Vita bundle = **unique ASIN/UPC**. Other sellers не могут join existing ASIN потому что:
- UPC принадлежит Vladimir's GS1 pool
- Brand Registry blocks unauthorized joins to Salutem Vita ASINs
- Bundle composition uniquely Vladimir's

**Result:** Vladimir = sole seller, always wins Buy Box by default.

### Cross-account Buy Box (5 Amazon accounts)

Vladimir's 5 accounts (Salutem, Personal, AMZ Commerce, Sirius, Retailer) — все authorized sellers на Salutem Vita brand. Same ASIN может имееть **multiple offers** от Vladimir's accounts.

В этом случае Amazon выбирает Buy Box winner среди Vladimir's accounts based on:
- Который account имеет lowest landed price
- Который account имеет faster handling time
- Который account имеет lowest LSR/ODR

**Vladimir's optimization:**
- Set всем accounts identical price (предотвратить self-cannibalization)
- Or set Salutem Solutions (Brand owner) slightly lower → primary account wins Buy Box
- Or randomize Buy Box winner для diversifying revenue across accounts

Bundle Factory подсказка: при создании 5 cross-account ChannelSKU records — copy price, но slight handling time variation OK для diversification.

### Когда другие sellers atакуют

Если конкурент создаёт **similar bundle** (с same component theme, e.g. Lunchables 12-pack gift set) — это **новый ASIN с разным UPC**. Они не на Vladimir's ASIN.

НО если конкурент находит ваши bundles через scraping и creates exact replicas:
- New ASIN — Amazon may "merge" similar listings (rarely для bundle-style products)
- Detect через automated scraping monitoring (Phase 3+ feature)

### Если merge happens

Если Amazon мерджит ASINs (Vladimir's + competitor's) — multiple offers на single ASIN:
- Vladimir competes via metrics (ODR, FBA, pricing)
- Brand Registry может request **brand gating** — block competitors
- Apply for **Transparency Program** ($0.05/code) — uniquely mark products

Это Phase 3+ defensive strategy.

---

## 📊 FBM vs FBA Buy Box implications

| Factor | FBM (Vladimir's MVP) | FBA |
|---|---|---|
| Buy Box base boost | Lower | Higher |
| Mitigation | Buy Shipping protection + valid tracking | N/A |
| Frozen support | Limited (insulated FBM) | Frozen FBA available только в few centers |
| Custom packaging | ✅ Full control (gift box) | ❌ Standard FBA prep |
| Margin | Higher (no FBA fees) | Lower |

**Vladimir's verdict:** FBM **must** because:
1. Custom Salutem Solutions gift box packaging
2. Sourcing JIT не fits FBA inventory model
3. Frozen FBA limited locations + high fees

Mitigation: aggressive Buy Shipping integration + sub-24h shipping notification.

---

## 💰 Pricing strategy for Buy Box

### Single-seller (default Vladimir state)

- Price freely; no Buy Box pressure
- A/B test pricing per ChannelSKU
- Phase 4+: implement Repricer (auto-adjust based on demand/inventory)

### Multi-seller (competitor enters)

- Match (или slightly underbid) competitor's landed cost
- Don't undercut excessively → margin destruction
- Use Brand Registry advantage for ranking boost

### Cross-account (Vladimir's 5 accounts)

- Synchronize pricing через Bundle Factory's ChannelSKU
- Each account = same `price_cents` field
- Repricer (Phase 4+) updates all 5 simultaneously

---

## 🔧 Bundle Factory implementation

### Stage 4 (Content Generation): pricing setup

```typescript
function calculateChannelPrice(masterBundle: MasterBundle, channel: SalesChannel): number {
  const baseCostCents = masterBundle.estimated_cost_cents;
  
  // Different markup per channel
  const markup = {
    AMAZON_SALUTEM: 2.5,       // 2.5x cost = ~60% gross margin
    AMAZON_PERSONAL: 2.5,
    AMAZON_AMZCOM: 2.5,
    AMAZON_SIRIUS: 2.5,
    AMAZON_RETAILER: 2.5,
    WALMART: 2.4,              // slightly lower for Walmart traffic
    EBAY: 2.6,                 // higher because eBay fees lower
    TIKTOK_1: 2.3,             // initial pricing for traction
    TIKTOK_2: 2.3,
  }[channel] || 2.5;

  return Math.round(baseCostCents * markup);
}
```

### Stage 7 (Distribution): cross-account sync

```typescript
async function publishToAllAmazonChannels(masterBundle: MasterBundle) {
  const AMAZON_CHANNELS = [
    'AMAZON_SALUTEM',
    'AMAZON_PERSONAL',
    'AMAZON_AMZCOM',
    'AMAZON_SIRIUS',
    'AMAZON_RETAILER',
  ];

  // Same price на all 5 accounts
  const basePrice = calculateChannelPrice(masterBundle, 'AMAZON_SALUTEM');

  for (const channel of AMAZON_CHANNELS) {
    const channelSku = await createChannelSku({
      master_bundle_id: masterBundle.id,
      channel,
      price_cents: basePrice,
      // ... other fields
    });

    await publishChannelSku(channelSku);
  }
}
```

---

## 📈 Buy Box monitoring (Phase 3+)

Bundle Factory should track:
- `buy_box_winner_account` per ChannelSKU per day
- `buy_box_percentage` (% of time owned за period)
- Drop alerts → investigate

UI dashboard widget:
- Buy Box ownership distribution by account
- Bundles losing Buy Box → action items

---

## 🚨 Common Buy Box mistakes (что НЕ делать)

❌ Set drastically different prices на 5 accounts (one wins, others die)
❌ Add buy-now keywords в title to "win" — это Style Guide violation
❌ Pause listings когда Buy Box lost — kills momentum
❌ Lower price below cost — race to bottom
❌ Ignore ODR/LSR — single defect can kick out of Buy Box for weeks

---

## References

- Buy Box eligibility: https://sellercentral.amazon.com/help/hub/reference/external/G201687090
- Brand Registry gating: https://brandservices.amazon.com/brandregistry/eligibility
- Transparency Program: https://brandservices.amazon.com/transparency
- Internal: [`brand-registry-benefits.md`](brand-registry-benefits.md), [`account-health-v2.md`](../../wiki/account-health-v2.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
