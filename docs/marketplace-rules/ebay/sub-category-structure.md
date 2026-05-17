# eBay Marketplace — Sub-Category Structure

> **Source:** eBay Browse API + category navigation
> **Last verified:** 2026-05-17
> **Priority:** P2

---

## TL;DR

eBay's category structure is more granular than Amazon/Walmart. **Каждая eBay listing должна быть в exactly one leaf category** (deepest sub). Choosing right leaf category boosts search ranking significantly. Bundle Factory должна map masterBundle → leaf category per composition type.

---

## 🌳 Vladimir's relevant eBay leaf categories (Food & Beverages branch)

```
Home & Garden (ID 11700)
└── Food & Beverages (ID 14308)
    ├── Cheese (ID 87014)
    │   ├── Hard Cheese
    │   ├── Soft Cheese
    │   └── Cheese Variety Packs
    │
    ├── Coffee (ID 14302)
    │   ├── Ground Coffee
    │   ├── Whole Bean Coffee
    │   ├── Instant Coffee
    │   ├── K-Cups
    │   └── Coffee Variety Packs ⭐ (Vladimir's gift sets)
    │
    ├── Tea (ID 14306)
    │   ├── Tea Bags
    │   ├── Loose Leaf Tea
    │   ├── Herbal Tea
    │   └── Tea Variety Packs ⭐
    │
    ├── Sweets, Chocolate & Gum (ID 14309)
    │   ├── Chocolate
    │   ├── Hard Candy
    │   ├── Gummy & Chewy Candy
    │   ├── Candy Variety Packs ⭐
    │   └── Holiday Candy
    │
    ├── Snacks (ID 14299)
    │   ├── Chips
    │   ├── Crackers
    │   ├── Cookies
    │   ├── Nuts & Trail Mix
    │   └── Snack Variety Packs ⭐
    │
    ├── Sauces & Marinades (ID 87015)
    │
    ├── Pantry (ID 87016)
    │   ├── Pasta
    │   ├── Rice
    │   ├── Canned Goods
    │   └── Pantry Essentials Bundles
    │
    ├── Gift Baskets (ID 14282) ⭐⭐ Vladimir's PRIMARY
    │   ├── Food Gift Baskets ⭐
    │   ├── Holiday Gift Baskets
    │   ├── Custom Gift Baskets
    │   └── Themed Gift Baskets
    │
    └── Other Food & Beverages (ID 5008)
```

⚠️ Category IDs above — **representative**, точные IDs нужно verify через eBay Browse API `/buy/browse/v1/category_tree`.

---

## 🎯 Mapping rules: composition → leaf category

```typescript
function determineEbayLeafCategory(masterBundle: MasterBundle): number {
  // 1. Multi-component / mixed → Gift Baskets root
  if (masterBundle.composition_type === 'CROSS_BRAND' ||
      masterBundle.composition_type === 'HOLIDAY_THEMED' ||
      masterBundle.components.length >= 3) {
    return 14282; // Food Gift Baskets
  }

  // 2. Single-category multipacks → specific variety pack sub
  const componentName = masterBundle.components[0]?.product_name.toLowerCase() || '';
  
  if (componentName.includes('coffee')) return 14302; // Coffee Variety Packs
  if (componentName.includes('tea')) return 14306;    // Tea Variety Packs
  if (componentName.includes('chocolate') || componentName.includes('candy')) return 14309; // Candy Variety Packs
  if (componentName.includes('cheese')) return 87014; // Cheese
  if (componentName.includes('snack') || componentName.includes('chips')) return 14299;
  if (componentName.includes('pasta') || componentName.includes('rice')) return 87016; // Pantry
  
  // Default fallback
  return 14282; // Food Gift Baskets (safe для unknown)
}
```

---

## 📋 Leaf-category specific attributes (Item Specifics)

Каждая leaf категория имеет свои required + recommended Item Specifics. Examples:

### Food Gift Baskets (ID 14282)

Required:
- Type ("Food Gift Basket")
- Brand
- Cuisine

Recommended:
- Occasion (holiday/birthday/etc.)
- Gift Recipient
- Pack Size
- Allergen Information

### Coffee Variety Packs (ID 14302 / sub)

Required:
- Type ("Ground" / "K-Cup" / "Instant")
- Brand
- Flavor (если single или primary)

Recommended:
- Caffeine Content
- Roast (Light/Medium/Dark)
- Country of Origin (beans)
- Organic certification

### Tea Variety Packs (ID 14306 / sub)

Required:
- Type ("Black Tea" / "Green Tea" / "Herbal" / "Variety")
- Brand
- Form ("Bags" / "Loose Leaf")

Recommended:
- Flavor variety
- Caffeine Content
- Origin

### Candy Variety Packs (ID 14309 / sub)

Required:
- Type ("Chocolate" / "Hard Candy" / "Gummy")
- Brand
- Flavor

Recommended:
- Allergens
- Heat-sensitive flag

---

## 🔧 Bundle Factory Stage 4 — eBay-specific attribute generation

```typescript
function buildEbayListing(masterBundle: MasterBundle, channelSku: ChannelSKU) {
  const categoryId = determineEbayLeafCategory(masterBundle);
  const itemSpecifics = buildEbayItemSpecifics(masterBundle);
  
  // Add category-specific attrs
  if (categoryId === 14302) { // Coffee
    itemSpecifics['Roast'] = determineRoast(masterBundle); // Light/Medium/Dark
    itemSpecifics['Type'] = ['Ground Coffee']; // или другое
  }
  if (categoryId === 14309) { // Candy
    itemSpecifics['Type'] = determineCandyType(masterBundle);
  }
  
  return {
    Title: channelSku.title, // ≤80 chars eBay limit
    PrimaryCategory: { CategoryID: categoryId },
    StartPrice: channelSku.price_cents / 100,
    Description: channelSku.description, // HTML allowed
    ListingType: 'FixedPriceItem',
    ListingDuration: 'GTC', // Good Till Cancelled
    Quantity: 100, // initial stock (JIT actually unlimited)
    ItemSpecifics: itemSpecifics,
    PictureDetails: {
      PictureURL: [
        masterBundle.main_image_url,
        ...(masterBundle.secondary_images || []),
      ]
    },
    ShippingDetails: {
      ShippingType: 'Flat',
      ShippingServiceOptions: [
        {
          ShippingService: 'USPSPriority',
          ShippingServiceCost: 0, // free shipping (built into price)
          ShippingServiceAdditionalCost: 0,
        }
      ]
    },
    DispatchTimeMax: masterBundle.category === 'FROZEN_GROCERY' ? 3 : 2,
    ReturnPolicy: {
      ReturnsAcceptedOption: 'ReturnsAccepted',
      ReturnsWithinOption: 'Days_30',
      ShippingCostPaidByOption: 'Buyer',
    },
    Country: 'US',
    Location: 'Clearwater, FL',
    PaymentMethods: ['CreditCard', 'PayPal'], // managed по eBay Managed Payments
    Currency: 'USD',
  };
}
```

---

## ⚠️ Edge cases

### "Variety Pack" sub-categories vs main category

eBay's "Variety Packs" sub-categories появились недавно для multipacks/bundles. Если eBay не имеет такой sub в твоей primary category → fallback на parent (e.g. Coffee root 14302 без sub).

### Cross-category bundles

Bundle = coffee + chocolate + cookies = 3 different leaf categories. eBay rules: pick **predominant** category by:
1. Weight contribution (heaviest item type)
2. Value contribution (most expensive items)
3. Visual prominence в main image

Default: pick Food Gift Baskets (14282) для true multi-category bundles.

### Holiday themed

Если bundle = Christmas-themed → primary category Holiday Gift Baskets sub под Gift Baskets. Boost в Q4 seasonal search.

---

## 🚀 Phase 2 launch sequence

1. Start с **Food Gift Baskets (14282)** для все Vladimir's existing Salutem Vita gift sets
2. Test 10-20 listings → measure conversion
3. **Refine** mapping per composition type
4. Expand в Coffee/Tea/Candy variety pack sub-categories для appropriate bundles
5. Phase 3+ — Holiday-themed sub категории для seasonal launches

---

## 📚 References

- eBay Browse API category tree: https://developer.ebay.com/api-docs/buy/browse/resources/category_tree/methods/getCategoryTree
- eBay Trading API GetSuggestedCategories: https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetSuggestedCategories.html
- Internal: [`grocery-deep-dive.md`](grocery-deep-dive.md), [`basics.md`](basics.md)

---

## 🚧 TODO

- [ ] Verify exact category IDs через Browse API
- [ ] Document any newer sub-category additions
- [ ] Cross-check Vladimir's competitor listings — какие categories they use?

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
