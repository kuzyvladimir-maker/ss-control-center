# Walmart Marketplace — Category Numeric IDs

> **Source:** Walmart Items API + Seller Center Category Browser
> **Last verified:** 2026-05-17 (partial — Items API verification pending Vladimir's API access)
> **Priority:** P0 для Walmart Stage 7 (Distribution)

---

## TL;DR

Walmart использует **category path strings** + **internal taxonomy IDs**. В отличие от Amazon's numeric browse nodes, Walmart's classification менее formal — есть `productCategory` (high-level), `productSubcategory` (medium), и categorical attribute fields. Категория передаётся в Item API через `productCategory` field как **string path**, не numeric ID.

⚠️ **Most "numeric IDs" в Walmart docs — internal taxonomy refs, не используются sellers напрямую.** Sellers использует category path strings.

---

## 🗂️ Walmart Food category hierarchy (verified through Seller Center)

```
Food
├── Beverages
│   ├── Coffee
│   ├── Tea
│   ├── Juice
│   └── Water
├── Bread & Bakery
├── Breakfast & Cereal
├── Candy
├── Canned Goods & Pantry
├── Cheese
├── Coffee  (alternative path)
├── Condiments & Sauces
├── Dairy
├── Deli
├── Frozen Foods
├── Gift Baskets ⭐ (Vladimir's primary target)
├── Meat & Seafood
├── Pasta & Rice
├── Snacks & Cookies
├── Tea
└── Wine & Spirits (alcohol, Vladimir не sell)
```

### Vladimir's relevant category paths

| Walmart Path | Vladimir's bundle type | Access |
|---|---|---|
| `Food > Gift Baskets > Food Gift Baskets` | Default для Salutem Vita gift sets | TBD verify |
| `Food > Snacks & Cookies > Cookies` | Cookie gift sets | ✅ Open |
| `Food > Snacks & Cookies > Snacks` | Snack mixes | ✅ Open |
| `Food > Candy > Chocolate` | Chocolate gift boxes | ✅ Open |
| `Food > Candy > Candy Variety Packs` | Mixed candy | ✅ Open |
| `Food > Coffee > Ground Coffee` | Coffee gift sets | ✅ Open |
| `Food > Tea > Tea Variety Packs` | Tea sampler | ✅ Open |
| `Food > Breakfast & Cereal > Cereal` | Cereal multi-pack | ✅ Open (shelf-stable) |
| `Food > Canned Goods & Pantry > Pantry Staples` | Pantry essentials kit | ✅ Open |
| `Food > Pasta & Rice > Pasta` | Italian dinner kit | ✅ Open |
| `Food > Bread & Bakery > Cookies` | Cookie multipack | ✅ Open (shelf-stable) |
| `Food > Frozen Foods > Frozen Meals` | Frozen meal bundles | ❌ **CLOSED** для Vladimir |
| `Food > Refrigerated > Cheese` | Cheese bundles | ❌ **CLOSED** |
| `Food > Meat & Seafood > ...` | Frozen meat | ❌ **CLOSED** |

---

## 📋 Item API payload — `productCategory` field

Walmart Item API использует Path-based category specification:

```json
{
  "MPItemFeed": {
    "MPItem": [
      {
        "Item": {
          "sku": "0A-2DLV-8XJU",
          "productIdentifiers": {
            "productIdType": "UPC",
            "productId": "742259726114"
          },
          "productName": "Salutem Vita Pizza Lunch Gift Set 12 Pack",
          "brand": "Salutem Vita",
          "productCategory": "Food",
          "productSubcategory": "Gift Baskets",
          "shortDescription": "Pizza Lunchables Gift Set with 12 individually wrapped meals...",
          "mainImageUrl": "https://images.salutemsolutions.info/main/0A-2DLV-8XJU.jpg",
          "price": 61.51,
          "ShippingWeight": 9.0,
          ...
        }
      }
    ]
  }
}
```

В отличие от Amazon — нет numeric `browse_node_id` для specifying. Walmart classifier работает на:
1. `productCategory` (string path top-level)
2. `productSubcategory`  
3. Auto-detection из product name + attributes

---

## 🚧 Verify через Walmart Items API (Vladimir's TODO)

Когда Walmart API access открыт:

1. **Endpoint:** `GET /v3/items/taxonomy` (Walmart Items API)
2. **Returns:** full category tree с internal IDs
3. **Use to:** map Vladimir's bundle composition → optimal category path

```typescript
async function fetchWalmartTaxonomy(): Promise<WalmartCategory[]> {
  const response = await walmartApi.get('/v3/items/taxonomy', {
    headers: {
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': generateUUID(),
      'WM_SEC.ACCESS_TOKEN': accessToken,
    },
  });
  return response.data.categories;
}
```

Cache results в `MarketplaceRule` table с `rule_key: walmart.category_tree`.

---

## 🔄 Bundle Factory Stage 4 mapping logic

```typescript
function determineWalmartCategoryPath(masterBundle: MasterBundle): { category: string; subcategory: string } {
  // 1. Default для Vladimir's gift set strategy
  if (masterBundle.composition_type === 'CROSS_BRAND' || 
      masterBundle.composition_type === 'HOLIDAY_THEMED') {
    return { category: 'Food', subcategory: 'Gift Baskets' };
  }

  // 2. Category-specific mapping
  const subcategoryMap = {
    FROZEN_GROCERY: null,           // Vladimir не имеет access
    REFRIGERATED: null,             // Vladimir не имеет access
    SHELF_STABLE: 'Snacks & Cookies', // default
    PET_FOOD: null,                  // Phase 2
  };

  if (masterBundle.category === 'SHELF_STABLE') {
    // Refine по composition
    const components = masterBundle.components.map(c => c.product_name.toLowerCase());
    
    if (components.some(n => n.includes('coffee'))) return { category: 'Food', subcategory: 'Coffee' };
    if (components.some(n => n.includes('tea'))) return { category: 'Food', subcategory: 'Tea' };
    if (components.some(n => n.includes('candy') || n.includes('chocolate'))) return { category: 'Food', subcategory: 'Candy' };
    if (components.some(n => n.includes('cookie'))) return { category: 'Food', subcategory: 'Snacks & Cookies' };
    if (components.some(n => n.includes('cereal'))) return { category: 'Food', subcategory: 'Breakfast & Cereal' };
    
    return { category: 'Food', subcategory: 'Gift Baskets' }; // safe default
  }

  return null; // skip Walmart channel
}
```

---

## ⚠️ Category-specific blocked items

Walmart блокирует определённые items в каждой category:

| Category | Blocked |
|---|---|
| Food > anything | Alcohol, tobacco, CBD, raw milk, expired food |
| Frozen Foods | Items требующих cold-chain если у seller no approval |
| Pet Food | Prescription items (require vet auth) |

Bundle Factory pre-publish check: scan components против category blocklist.

---

## 📚 References

- Walmart Items API: https://developer.walmart.com/api/us/mp/items
- Walmart Category Taxonomy: https://developer.walmart.com/doc/us/us-mp/us-mp-items/
- Internal: [`category-grocery.md`](category-grocery.md), [`multipack-policy.md`](multipack-policy.md)

---

## 🚧 TODO

- [ ] **A.1** Fetch live taxonomy через Items API (after Vladimir's API access approved)
- [ ] **A.2** Verify Vladimir's actual category access per Seller Center
- [ ] **A.3** Document any newer/changed category paths (Walmart quarterly review)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
