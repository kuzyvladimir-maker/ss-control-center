# Walmart Marketplace — Attribute Keys per Category

> **Source:** Walmart Items API spec + Item Setup documentation
> **Last verified:** 2026-05-17
> **Priority:** P0 для Stage 7 (Distribution) к Walmart

---

## TL;DR

Walmart Item API использует **flat JSON attributes** в отличие от Amazon's productType-keyed structure. Каждое поле = `key: value`. Required vs optional attributes варьируются по category. Этот файл — практический cheat sheet attributes для Vladimir's main categories.

---

## 📋 Universal required attributes (all Walmart items)

Каждый item MUST иметь:

```json
{
  "sku": "0A-2DLV-8XJU",                    // Vladimir's SKU pattern
  "productIdentifiers": {
    "productIdType": "UPC",
    "productId": "742259726114"             // GS1-registered UPC
  },
  "productName": "Salutem Vita Pizza...",   // ≤75 chars
  "brand": "Salutem Vita",
  "productCategory": "Food",                // top-level
  "productSubcategory": "Gift Baskets",     // sub-level
  "mainImageUrl": "https://...",            // ≥1500x1500, JPEG
  "shortDescription": "...",                // 4000 chars max
  "shippingWeight": 9.0,                    // pounds
  "price": 61.51,                           // USD
  "manufacturer": "Salutem Solutions LLC",  // optional but recommended
}
```

---

## 📋 Food > Gift Baskets specific attributes

```json
{
  "productCategory": "Food",
  "productSubcategory": "Gift Baskets",
  
  // Food-specific
  "foodForm": "Mixed",                       // Mixed / Liquid / Solid / Powder
  "isPerishable": true,                      // если frozen/refrigerated
  "storageInstruction": "Store in freezer at 0°F or below. Refrigerate after opening.",
  
  // Allergen disclosure
  "containsAllergens": ["Milk", "Wheat", "Soybeans"],
  "containsArtificialIngredients": false,
  
  // Gifting-specific
  "isGift": true,
  "occasion": ["Christmas", "Birthday", "Thank You"],
  "giftRecipient": "Adults",                 // Adults / Children / Teens / Any
  
  // Compositional
  "containedItemCount": 12,
  "totalCount": 12,
  
  // Marketing
  "keywords": "gift set, frozen meal, pizza, lunch kit, salutem vita",
  
  // Compliance
  "countryOfOrigin": "US",
  "californiaProp65Warning": false,          // Vladimir's items typically не need это
  
  // Shipping
  "shippingProgram": "Walmart Fulfillment Services" // или "Seller Fulfilled" (Vladimir = SF)
}
```

---

## 📋 Food > Snacks & Cookies specific

Простая категория, fewer required attrs:

```json
{
  "productCategory": "Food",
  "productSubcategory": "Snacks & Cookies",
  
  "foodForm": "Solid",
  "isPerishable": false,
  "storageInstruction": "Store in cool, dry place.",
  
  "containsAllergens": ["Wheat", "Milk"],
  
  "netWeight": 12.0,                         // ounces
  "netWeightUOM": "oz",
  
  "containedItemCount": 12,
  
  "shippingProgram": "Seller Fulfilled"
}
```

---

## 📋 Food > Coffee / Tea specific

```json
{
  "productCategory": "Food",
  "productSubcategory": "Coffee",            // или "Tea"
  
  "foodForm": "Solid",                       // grounds / leaves
  "isPerishable": false,
  
  "containsCaffeine": true,                  // или false для decaf
  "isOrganic": false,                        // если certified — true
  "isFairTrade": false,                      // если certified — true
  
  "containsAllergens": [],                   // typically none для pure coffee
  
  "containedItemCount": 5,
  
  "storageInstruction": "Store in cool, dry place. Keep sealed.",
}
```

---

## 📋 Food > Candy specific

```json
{
  "productCategory": "Food",
  "productSubcategory": "Candy",
  
  "foodForm": "Solid",
  "isPerishable": false,                     // shelf-stable но heat-sensitive
  
  "containsAllergens": ["Milk", "Soybeans", "Tree Nuts"], // typical chocolate
  
  "heatSensitive": true,                     // optional но recommended для chocolate
  "storageInstruction": "Store in cool, dry place. May melt above 75°F.",
  
  "containedItemCount": 15,
  
  "occasion": ["Christmas", "Halloween", "Valentine's Day", "Easter"],
}
```

---

## 🔧 Bundle Factory Stage 4 builder

```typescript
function buildWalmartAttributes(masterBundle: MasterBundle, channelSku: ChannelSKU): Record<string, any> {
  const baseAttrs = {
    sku: channelSku.sku,
    productIdentifiers: {
      productIdType: 'UPC',
      productId: channelSku.upc,
    },
    productName: channelSku.title,
    brand: masterBundle.brand,
    manufacturer: getBrandManufacturer(masterBundle.brand), // 'Salutem Solutions LLC' or 'Sirius International LLC'
    mainImageUrl: masterBundle.main_image_url,
    shortDescription: stripHtml(channelSku.description).substring(0, 4000),
    shippingWeight: masterBundle.total_weight_lb,
    price: channelSku.price_cents / 100,
    containedItemCount: masterBundle.pack_count,
    countryOfOrigin: 'US',
    keywords: extractKeywords(channelSku),
  };

  // Category-specific attrs
  const categoryPath = determineWalmartCategoryPath(masterBundle);
  baseAttrs.productCategory = categoryPath.category;
  baseAttrs.productSubcategory = categoryPath.subcategory;

  // Storage temperature
  baseAttrs.isPerishable = masterBundle.category === 'FROZEN_GROCERY' || masterBundle.category === 'REFRIGERATED';
  baseAttrs.storageInstruction = generateStorageInstruction(masterBundle.category);

  // Allergens
  baseAttrs.containsAllergens = aggregateAllergens(masterBundle.components);

  // Gift attributes
  if (masterBundle.composition_type === 'CROSS_BRAND' || categoryPath.subcategory === 'Gift Baskets') {
    baseAttrs.isGift = true;
    baseAttrs.occasion = ['Christmas', 'Birthday', 'Thank You & Appreciation'];
    baseAttrs.giftRecipient = 'Adults';
  }

  // Category-specific overrides
  if (categoryPath.subcategory === 'Candy') {
    baseAttrs.heatSensitive = masterBundle.components.some(c => c.product_name.toLowerCase().includes('chocolate'));
  }

  if (categoryPath.subcategory === 'Coffee' || categoryPath.subcategory === 'Tea') {
    baseAttrs.containsCaffeine = !channelSku.title.toLowerCase().includes('decaf');
  }

  return baseAttrs;
}
```

---

## 📋 Image attributes (gallery)

```json
{
  "mainImageUrl": "https://images.salutemsolutions.info/main/{sku}.jpg",
  
  "secondaryImages": [
    { "imageUrl": "https://images.salutemsolutions.info/sec/{sku}-1.jpg" },
    { "imageUrl": "https://images.salutemsolutions.info/sec/{sku}-2.jpg" },
    { "imageUrl": "https://images.salutemsolutions.info/sec/{sku}-3.jpg" }
    // up to 8 secondary
  ]
}
```

См. [`images.md`](images.md) для requirements.

---

## 🔄 Variation attributes (variant items)

Walmart supports variations (например, "Same gift set, 3 different occasions" = parent с 3 variants):

```json
{
  "variantGroupId": "SALUTEM_PIZZA_GIFT_SET_2026",
  "variantAttributeNames": ["occasion"],
  "isPrimaryVariant": true,                   // для one variant per group
  "variantAttributes": [
    { "name": "occasion", "value": "Christmas" }
  ]
}
```

Bundle Factory Phase 2+ — variation support для seasonal packaging variants.

---

## 🚨 Common attribute issues

| Issue | Cause | Fix |
|---|---|---|
| Item rejected: "Missing required" | Required attr missing | Check schema через `/items/feedItemStatus` API |
| Item rejected: "Image URL invalid" | Google Drive / non-CDN URL | Use Cloudflare R2 |
| Item rejected: "Brand verification" | Brand not registered | Walmart Brand Verification process |
| Stuck "Stage 3 (Setup)" | Pricing missing OR inventory not synced | Set price + push inventory |
| "Inactive" listing | Missing image OR description | Verify both populated |

---

## References

- Walmart Item API spec: https://developer.walmart.com/api/us/mp/items
- Item Setup Guide: https://sellerhelp.walmart.com/seller/s/article/Item-Setup-Guide
- Internal: [`category-grocery.md`](category-grocery.md), [`category-numeric-ids.md`](category-numeric-ids.md), [`images.md`](images.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
