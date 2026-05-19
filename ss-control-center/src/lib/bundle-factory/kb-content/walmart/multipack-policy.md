# Walmart Marketplace — Multipack Policy

> **Source:** https://sellercentral.walmart.com/help (Walmart Marketplace Seller Help)
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Walmart Marketplace разрешает multipacks и variety packs, но **не использует "gift basket exception"** концепцию как Amazon. Multi-brand bundles в strict regular categories — нарушение. Vladimir's strategy на Walmart — focus на **single-brand multipacks** или **own-brand (Salutem Vita) gift bundles** в "Food Gift Baskets" category.

---

## Hard rules

### 1. Multipack vs Bundle

| Тип | Walmart support |
|---|---|
| Multipack (same product × N) | ✅ Full support |
| Variety pack (same brand, multiple variants) | ✅ Full support |
| Multi-brand bundle | ⚠️ Только в "Food Gift Baskets" category |
| Cross-category bundle | ❌ Not supported |

### 2. "Food Gift Baskets" category на Walmart

Walmart имеет analog Amazon's gift basket exception:
- Category path: `Food > Gift Baskets`
- Walmart category ID: (TBD verify через Walmart Items API)
- Same physical packaging requirement (presentation box)

Vladimir's strategy:
- Salutem Vita gift baskets/sets listed в Food Gift Baskets category
- Brand owner = Vladimir's company (Salutem Solutions через Salutem Vita brand)
- Same UPC pool используется

### 3. UPC requirements

Walmart **строже Amazon на UPC validation**:
- UPC должен быть **GS1-registered**
- GEPIR lookup verification
- Each ASIN unique UPC

Vladimir's UPC pool (742259/789232/617261) — должны pass GEPIR check. Phase 0 — verify через GS1 API.

### 4. Brand Registry / Brand Verification

Walmart Brand Verification (analog Amazon Brand Registry):
- Vladimir submitted Salutem Vita registration ✓ (Brand Registry confirmation)
- Если не verified — third-party sellers могут joinings the listing

### 5. Brand-owned products

Walmart prefers brand owners selling собственные products. Reseller-style listings (Vladimir resell-ing Jimmy Dean) — лимитированы.

---

## Vladimir's current Walmart status

- Walmart Marketplace API access: **on pause** (pending API approval)
- Frozen Grocery category: **closed** для Vladimir (нет approval)
- Shelf-stable Grocery: **open** (вот где Vladimir будет начинать)
- Food Gift Baskets: **likely open** — нужно verify

Phase 1-2 plan:
1. Apply for Walmart API access
2. Get Frozen category approval (separate application)
3. Sync existing shelf-stable Salutem Vita bundles на Walmart

---

## Bundle Factory implications

Stage 7 (Distribution) для Walmart channel:
- Only push bundles с `category in [SHELF_STABLE]` first (frozen blocked)
- Generate Walmart-specific shorter title (≤75 chars)
- Same UPC, same composition
- Different `walmart_item_id` after publish

`ChannelSKU` table уже имеет `channel: WALMART` и `walmart_item_id` field.

---

## References

- https://sellercentral.walmart.com/help
- Walmart Items API: https://developer.walmart.com/api/us/mp/items
- Internal: [`../amazon/gift-set-policy.md`](../amazon/gift-set-policy.md), [`frozen-restrictions.md`](frozen-restrictions.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
