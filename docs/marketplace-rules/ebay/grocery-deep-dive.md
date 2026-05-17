# eBay Marketplace — Grocery Deep Dive

> **Source:** eBay Seller Center + eBay food category rules
> **Last verified:** 2026-05-17
> **Priority:** P2 (Phase 2 channel)

---

## TL;DR

eBay's food category — менее formal чем Amazon/Walmart, но имеет specific restrictions. Sales volume для grocery меньше чем Amazon (eBay strong в collectibles, vintage, electronics). НО Vladimir's gift sets могут capture **niche audience** — gift shoppers ищущие unique presentations не доступные на Amazon.

---

## 🎯 eBay Food category structure

```
Home & Garden
└── Food & Beverages
    ├── Cheese
    ├── Coffee
    ├── Tea
    ├── Sauces & Marinades
    ├── Snacks
    ├── Sweets, Chocolate & Gum
    ├── Pantry
    ├── Other Food & Beverages
    └── Gift Baskets ⭐ (Vladimir's primary)
```

**eBay's category ID** для Food & Beverages = `14308`. Gift Baskets sub = TBD verify через Browse API.

---

## ✅ What eBay allows (vs Amazon/Walmart)

1. **Multi-brand bundles** — fewer restrictions on cross-brand combinations
2. **Custom packaging** prominently — buyer expectation
3. **Auction format** возможен (для unique gift sets, не recommended для grocery)
4. **"Does Not Apply" UPC** — для truly custom items
5. **More flexible title** — promotional language tolerated больше чем Amazon
6. **Best Offer** — buyer-seller negotiation

## ❌ What eBay restricts

1. **Alcohol** — never (как Amazon/Walmart)
2. **Hazardous food** (raw meat, raw milk) — restricted
3. **Expired products** — auto-removal
4. **Federal-prohibited** (hemp, CBD, certain supplements)
5. **Recalled items** — auto-removal
6. **International food без proper labeling**

---

## 📋 eBay food listing best practices

### Title (80 chars max)

```
Salutem Vita Pizza Lunch Gift Set 12-Pack Frozen Box Lunchables 4.3 oz
```

eBay's algorithm rewards **keyword-rich** titles. Можно (унlike Amazon) include:
- "Bundle" / "Variety Pack" — boost
- "Gift Set" — boost (gift category)
- Component brand names (Lunchables) — OK в bullets AND title (eBay не имеет Amazon's brand IP restriction)

### Item Specifics (eBay's structured attributes)

```
Type: Food Gift Basket
Cuisine: American
Brand: Salutem Vita
Allergen Information: Contains Milk, Wheat, Soy
Expiration Date: 09/30/2027
Storage Type: Frozen
Pack Size: 12 Count
Weight: 9 lb
Country/Region of Manufacture: United States
Item Condition: New
```

eBay search relies heavily на Item Specifics → fill ALL relevant fields.

### Description (HTML allowed)

eBay description = standalone web page. Can include:
- Custom HTML (responsive)
- Image gallery
- Embedded video (no auto-play)
- Marketing language ("Best gift!", "Free shipping!") — eBay более permissive

### Shipping options

```
Shipping Service: USPS Priority Mail (или UPS Ground)
Handling Time: 2 business days
Returns: 30-day buyer pays return
Domestic only / International (Vladimir's choice)
```

eBay buyers expect:
- ✅ Returns policy (30 days minimum)
- ✅ Tracking number provided
- ✅ Insurance для high-value (Vladimir's $60 bundles → optional)

---

## 🚀 Vladimir's eBay strategy

### Phase 2 launch plan

1. **Open new eBay business account** (Salutem Solutions LLC entity)
2. **Verify business** (W-9, EIN, address)
3. **Start with 10 best-performing Amazon Salutem Vita bundles** (shelf-stable only initially)
4. **Replicate listings** via Bundle Factory cross-channel sync
5. **Build seller reputation** — fast shipping, good packaging, positive feedback
6. **Scale to 50-100 listings** через 90 days

### Niches eBay strong для Vladimir

- **Unique gift sets** не доступные на Amazon
- **Collector items** (limited edition packaging, holiday themes)
- **International buyers** seeking US products (Phase 3 expansion)

### Niches eBay weak для Vladimir

- **Frozen items** — eBay buyers expect immediate shipping (no Mon-Wed restriction)
- **Commodity bundles** — Amazon wins на price/volume
- **Low margin items** — eBay fees + shipping kill economics

---

## 📋 Item Specifics (Vladimir's standard fields)

Bundle Factory должна populate:

```typescript
function buildEbayItemSpecifics(masterBundle: MasterBundle): Record<string, string[]> {
  return {
    'Type': ['Food Gift Basket'],
    'Cuisine': ['American'],
    'Brand': [masterBundle.brand],
    'Country/Region of Manufacture': ['United States'],
    'Item Condition': ['New'],
    'Pack Size': [`${masterBundle.pack_count} Count`],
    'Weight': [`${masterBundle.total_weight_lb} lb`],
    
    // Storage
    'Storage Type': [masterBundle.category === 'FROZEN_GROCERY' ? 'Frozen' : 'Shelf-Stable'],
    
    // Allergens (eBay strict requirement для food)
    'Allergen Information': [aggregateAllergens(masterBundle.components).join(', ')],
    
    // Expiration
    'Expiration Date': [calculateMinExpirationDate(masterBundle.components)],
    
    // Gifting
    'Occasion': ['Christmas', 'Birthday', 'Anniversary'], // multi-value OK
    'Gift Recipient': ['Adults'],
  };
}
```

---

## 💰 eBay fees recap

См. [`fee-schedule.md`](fee-schedule.md). Quick summary для $60 bundle:

- Insertion fee: $0 (under 250 listings/month)
- FVF: 12.55% × $60 = $7.53
- Per-order fee: $0.30
- **Total eBay cost: $7.83** (cheaper than Amazon's $9.00)

---

## 🚨 Common eBay food listing pitfalls

1. **Vague title** — eBay buyers heavily keyword-search. Be specific.
2. **Single image** — eBay allows 12 images free, use them all
3. **No Item Specifics** — major search ranking penalty
4. **Slow shipping** — buyer feedback drops, account standing hit
5. **No returns policy** — буquilometres scared away, lower conversion
6. **Generic stock photos** — buyers prefer "actual product" photos (Vladimir's branded box main image works)

---

## 🎯 Phase 2+ optimization

- **Promoted Listings** — eBay's PPC equivalent (2-12% ad rate, optional но boost visibility)
- **eBay Store subscription** — $4.95-$59.95/month, gives free listings + lower FVF (worth at high volume)
- **Top Rated Seller status** — earned через 100+ transactions с <0.5% defect rate → 10% FVF discount

---

## References

- eBay Food & Beverage policies: https://www.ebay.com/help/policies/prohibited-restricted-items/food-policy
- eBay Item Specifics guide: https://www.ebay.com/help/selling/listings/creating-managing-listings/specifying-item-condition-other-details
- Internal: [`basics.md`](basics.md), [`fee-schedule.md`](fee-schedule.md), [`sub-category-structure.md`](sub-category-structure.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
