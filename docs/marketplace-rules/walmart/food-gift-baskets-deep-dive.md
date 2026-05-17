# Walmart Marketplace — Food Gift Baskets Deep Dive

> **Category Path:** `Food > Gift Baskets`
> **Last verified:** 2026-05-17
> **Priority:** P0 — primary Walmart target для Salutem Vita bundles

---

## TL;DR

Walmart's "Food Gift Baskets" category — это analog Amazon's "Food Assortments & Variety Gifts" (12011207011). **Может разрешить multi-brand bundles** аналогично Amazon's Gift Basket Exception, но Walmart's policy строже — preference на **single-brand multipacks** и **own-brand gift sets**. Vladimir's Salutem Vita gift sets — perfect fit (own brand + multi-component).

---

## 🎯 Category structure

```
Food
└── Gift Baskets
    ├── Food Gift Baskets ⭐ (Vladimir's primary)
    ├── Beverage Gift Baskets
    ├── Snack Gift Baskets
    ├── Holiday Gift Baskets
    └── Themed Gift Baskets
```

⚠️ Walmart's sub-categories под Gift Baskets могут варьироваться по seller account и могут require отдельную approval. Vladimir's primary path: `Food > Gift Baskets` (top-level).

---

## ✅ Walmart Gift Baskets allows

1. **Multi-brand bundles** (Lunchables + Eggland's + Salutem Vita packaging) — аналог Amazon's exception
2. **Own-brand gift sets** (single brand = Salutem Vita)
3. **Holiday-themed packaging**
4. **Cross-category content** (food + accessory like mug) — менее strict чем Amazon

## ❌ Walmart Gift Baskets restricts

1. **Frozen content** — Vladimir не имеет Frozen access, поэтому frozen bundles нельзя
2. **Refrigerated content** — same restriction
3. **Alcohol** — never allowed
4. **Cross-channel resale** — bundles нельзя пересекаться с Walmart's first-party (1P) listings (Walmart's own retail)
5. **Recalled products** — auto-removal через recall monitoring

---

## 📋 Required attributes для Gift Baskets

Дополнительно к [`attribute-keys.md`](attribute-keys.md):

```json
{
  "productCategory": "Food",
  "productSubcategory": "Gift Baskets",
  
  // Gift-specific (recommended boost SEO)
  "isGift": true,
  "occasion": ["Christmas", "Birthday", "Thank You", "Anniversary"],
  "giftRecipient": "Adults",                 // или "Children" / "Any"
  "presentationType": "Box",                 // Box / Basket / Sampler / Tin
  
  // Composition transparency
  "containedItemCount": 12,
  "totalCount": 12,
  "componentList": "12 frozen breakfast items in branded gift box: 6 sausage croissants, 6 cheese omelets",
  
  // Allergens aggregated
  "containsAllergens": ["Milk", "Wheat", "Soybeans"],
  
  // Quality assurance
  "isFreshness Guaranteed": true,           // matches Vladimir's "100% FRESHNESS GUARANTEED" badge
  
  // Manufacturing
  "manufacturer": "Salutem Solutions LLC",
  "manufacturerPartNumber": "0A-2DLV-8XJU", // Vladimir's SKU
}
```

---

## 🚛 Shipping requirements

**Shelf-stable Gift Baskets (Vladimir's MVP scope):**

```json
{
  "shippingProgram": "Seller Fulfilled",
  "shippingWeight": 5.5,                     // lbs
  "shippingWeightUOM": "lb",
  "packageWeight": 5.5,
  "packageLength": 12.0,                     // inches
  "packageWidth": 10.0,
  "packageHeight": 8.0,
  "fulfillmentLeadTime": 2,                  // business days
  "expedidedShippingAvailable": false,       // default
}
```

**Frozen Gift Baskets (Phase 2 после Vladimir's approval):**

```json
{
  "shippingProgram": "Seller Fulfilled",
  "shippingWeight": 9.0,
  "fulfillmentLeadTime": 3,                  // accounts for Mon-Wed restriction
  "specialHandling": "Frozen items - ship with insulated packaging and gel ice packs Mon-Wed only.",
  "isPerishable": true,
  "perishableShipping": "RequiresCooler",
}
```

---

## 🎁 Presentation strategy для Vladimir

### Main image criteria

Walmart Gift Basket main image:
- Show **physical box** prominently ("GIFT SET N COUNT" text visible)
- Show **components inside** (open box, partially visible)
- Show **branding** (Salutem Solutions logo + "100% FRESHNESS GUARANTEED" badge)
- Background: white (RGB 240+, less strict than Amazon's 255)

### Title pattern (Walmart's 75-char limit)

```
Salutem Vita Pizza Lunch Gift Set 12-Pack Frozen Box
```

Vladimir's Amazon title 79 chars → Walmart shorter ≤75:
- Drop em-dash
- Drop parenthetical details
- Front-load brand + product type + size

### Description (Walmart shortDescription ≤4000 chars)

```html
<p>The Salutem Vita Pizza Lunch Gift Set delivers 12 individually-wrapped Lunchables Pizza meals in our signature presentation packaging — perfect for surprise gifts, holiday gatherings, or stocking up the freezer.</p>

<p><b>What's in this Pack of 12:</b></p>
<ul>
  <li>12 × Lunchables Pizza with Pepperoni (4.3 oz each)</li>
  <li>Individually wrapped components for freshness</li>
  <li>Branded gift box with "GIFT SET 12 COUNT" presentation</li>
</ul>

<p><b>Storage:</b> Refrigerate or freeze immediately upon arrival. Best within 3 months of receipt.</p>

<p><b>Allergens:</b> Contains milk, wheat, soybeans. Check individual product labels for specific allergen information.</p>
```

---

## 🆚 Comparison: Amazon vs Walmart Gift Baskets

| Aspect | Amazon (12011207011) | Walmart (Food > Gift Baskets) |
|---|---|---|
| Multi-brand allowed | ✅ Yes (Gift Basket Exception) | ✅ Yes (Walmart equivalent) |
| Frozen support | ✅ Full (after ungating) | ⚠️ Vladimir has no access |
| Title length | 200 chars | 75 chars |
| Image size | 1000x1000+ pure white | 1500x1500+ near-white (240+) |
| UPC validation | Less strict с Brand Registry | Strict GS1 GEPIR check |
| Brand verification | Brand Registry | Walmart Brand Verification |
| Search algorithm | Keywords-heavy | Keywords + product hierarchy |
| Buy Box concept | Yes | Yes (called "Featured Buy") |
| Audience volume | Higher (cross-Amazon traffic) | Lower (но buyer intent often stronger) |
| Referral fee | 15% (>$15) | 12% (>$10) |
| Margin advantage | - | +3% better on $40+ sales |

---

## 🚧 Vladimir's strategy

### Phase 1 (Current): Shelf-stable only

- Listing categories: Coffee Gifts, Tea Gifts, Candy Variety, Snack mixes, Pantry kits, Italian dinner kits
- Same Salutem Vita branding
- Same UPC pool
- Different title (Walmart 75-char version)
- Sync через Bundle Factory Stage 7

### Phase 2 (After Vladimir's Frozen approval): Expand

- Listing frozen breakfast / lunch gift sets
- Larger inventory scaling

---

## 🔧 Bundle Factory Stage 7 — Walmart-specific publish

```typescript
async function publishToWalmart(channelSku: ChannelSKU, masterBundle: MasterBundle) {
  // Skip if category doesn't allow
  if (!isWalmartCategoryAllowed(masterBundle.category)) {
    await db.channelSKU.update({
      where: { id: channelSku.id },
      data: { lifecycle_status: 'SUSPENDED', errors: ['Walmart access not granted для этой category'] }
    });
    return;
  }

  const walmartPayload = {
    MPItemFeed: {
      MPItem: [
        {
          Item: buildWalmartAttributes(masterBundle, channelSku)
        }
      ]
    }
  };

  const response = await walmartApi.post('/v3/feeds?feedType=MP_ITEM', walmartPayload);
  
  // Capture feedId for status tracking
  await db.channelSKU.update({
    where: { id: channelSku.id },
    data: {
      lifecycle_status: 'PROCESSING',
      submitted_at: new Date(),
      attributes: { ...channelSku.attributes, walmart_feed_id: response.data.feedId }
    }
  });
}
```

---

## References

- Walmart Item Specifications: https://sellerhelp.walmart.com/seller/s/article/Walmart-Item-Specifications
- Gift Baskets category: https://www.walmart.com/cp/Food-Gift-Baskets/976777
- Internal: [`category-grocery.md`](category-grocery.md), [`multipack-policy.md`](multipack-policy.md), [`../amazon/gift-set-policy.md`](../amazon/gift-set-policy.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
