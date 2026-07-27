# Walmart Marketplace — Category Grocery

> **ARCHIVED SNAPSHOT — NOT A RUNTIME POLICY SOURCE.** The account/category
> access table and static attribute examples below are historical assumptions,
> not current evidence. This file is excluded from the KB loader. Use
> `prepublication-compliance.md`, Seller Center evidence and live Get Spec.

> **Source:** https://sellercentral.walmart.com/help
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Walmart's Grocery category structure аналогична Amazon-у, но с **separate sub-categories** для Frozen, Refrigerated, Shelf-stable. Каждая sub-category — отдельная approval. Vladimir's status: shelf-stable open, frozen closed.

---

## Category structure

```
Walmart Grocery
├── Beverages
├── Bread & Bakery
├── Breakfast & Cereal
├── Candy
├── Canned Goods & Pantry
├── Cheese
├── Coffee
├── Condiments & Sauces
├── Dairy
├── Deli
├── Frozen Foods
├── Gift Baskets ⭐ (Vladimir's target)
├── Meat & Seafood
├── Pasta & Rice
├── Snacks & Cookies
├── Tea
└── Wine & Spirits
```

### Vladimir's relevant sub-categories

| Walmart Category | Vladimir's Access | Notes |
|---|---|---|
| Gift Baskets | TBD verify | Primary target для Salutem Vita bundles |
| Snacks & Cookies | Open (shelf-stable) | Dry bundles |
| Coffee | Open | Coffee gift sets |
| Tea | Open | Tea gift sets |
| Candy | Open | Candy gift sets |
| Pasta & Rice | Open | Italian dinner kits |
| Canned Goods & Pantry | Open | Pantry essentials |
| Breakfast & Cereal | Mixed | Shelf-stable cereal OK; frozen breakfast — closed |
| Bread & Bakery | Mixed | Shelf-stable bread; frozen bread — closed |
| Frozen Foods | **CLOSED** | Vladimir doesn't have access |
| Refrigerated | **CLOSED** | Vladimir doesn't have access |
| Meat & Seafood | **CLOSED** | Pending |
| Dairy | **CLOSED** | Pending |
| Cheese | **CLOSED** | Pending |

---

## Category-specific attributes

В Walmart Item API attributes vary по category. Bundle Factory должна generate proper attributes для каждого:

### Snacks & Cookies bundle
```json
{
  "productCategory": "Snacks",
  "productType": "Gift Set",
  "containedItemCount": 12,
  "totalCount": 12,
  "isReplenishable": false,
  "isGift": true
}
```

### Gift Baskets bundle (Salutem Vita main target)
```json
{
  "productCategory": "Gift Baskets",
  "productType": "Food Gift Basket",
  "occasion": ["Birthday", "Christmas", "Thank You"],
  "isGift": true
}
```

---

## Bundle Factory adaptation

Stage 4 (Content Generation):
- AI determines Walmart category from composition
- Mapping table в `MarketplaceRule` (для каждой Amazon browse_node → Walmart category)
- Если bundle includes frozen component → ChannelSKU.lifecycle_status = SUSPENDED для WALMART channel (Vladimir не имеет access)

---

## Phase 2 expansion

Когда Vladimir получит Frozen approval на Walmart:
- Generate Frozen ChannelSKU automatically для existing bundles
- Same UPC, same composition, just new walmart_item_id
- Bundle Factory `BrandAccount` table уже supports `WALMART` channel

---

## References

- https://sellercentral.walmart.com/help
- Walmart Items API: https://developer.walmart.com/api/us/mp/items
- Internal: [`title-policy.md`](title-policy.md), [`frozen-restrictions.md`](frozen-restrictions.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
