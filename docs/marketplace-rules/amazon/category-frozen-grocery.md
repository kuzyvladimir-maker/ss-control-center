# Amazon Category: Frozen Grocery

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/G201307470 (Grocery requirements)
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Frozen grocery — самая регулируемая категория Vladimir-а. Требует Approval ("Ungating"). Storage temperature, allergen disclosure, expiration tracking — обязательны. FBM only для Vladimir's MVP (FBA Frozen есть только в нескольких fulfillment centers).

---

## Hard rules

### 1. Storage temperature attribute

Каждый Frozen listing требует `storage_temperature` attribute:
- `Frozen` — для меня основное (Lunchables hot pockets, Jimmy Dean, Eggland's)
- `Refrigerated` — для refrigerated items (отдельная category)
- `Shelf-stable` — не применяется

В Flat File / SP-API:
```json
"storage_temperature": [{ "value": "Frozen", "marketplace_id": "ATVPDKIKX0DER" }]
```

### 2. Allergen disclosure

Обязательно указать allergens из FDA "Big 9":
- Milk
- Eggs
- Fish
- Crustacean shellfish
- Tree nuts
- Peanuts
- Wheat
- Soybeans
- Sesame (added 2023)

В Flat File: `allergen_information` — array из allergens.

### 3. Expiration date attribute

Для Frozen — нужно указать `is_expiration_dated_product: true`. Опционально `expiration_period` (e.g. "12 months from production").

### 4. Approval requirement (Ungating)

Frozen Grocery — restricted category. Чтобы продавать, account должен be approved. Vladimir's 5 accounts:

| Account | Frozen Approved? |
|---|---|
| Salutem Solutions | ✅ (existing 1028 gift sets prove this) |
| Sirius International | TBD — нужно verify |
| AMZ Commerce | TBD |
| Personal (Vladimir) | TBD |
| Retailer Distributor | TBD |

В Phase 0 — verify approval status каждого account через Seller Central → Inventory → Add Product → Search для Frozen item → если "Apply to sell" button — нужно apply.

### 5. Shipping requirement (FBM)

Frozen FBM listings требуют:
- **Insulated packaging** (cooler box)
- **Gel ice packs** (минимум 2 на bundle)
- **Same-day или Next-day shipping** ((Mon-Wed только — чтобы не оставить в склад UPS на weekend)
- **Tracking required**

Vladimir's setup через Veeqo: insulated box + 2 gel packs default per frozen bundle. Cooler size = small / medium / large based на bundle size.

---

## Soft rules

### 1. Cold chain disclosure

В description рекомендуется указать:
> "This product is shipped frozen with insulated packaging and gel ice packs. We recommend refrigerating or freezing immediately upon arrival to maintain quality. Items are shipped Monday through Wednesday to avoid weekend transit delays."

### 2. Specific gift set messaging

> "Perfect for surprise gifts, holiday gatherings, or stocking up for the week. Components are individually wrapped for freshness and easy storage."

---

## Examples

### ✅ Correct frozen gift set listing

ASIN B0FH2NX7J9 — Salutem Vita Pizza Lunchables Gift Set (Frozen):
- storage_temperature: Frozen ✓
- allergen_information: [Milk, Wheat, Soybeans] ✓
- is_expiration_dated_product: true ✓
- FBM fulfillment ✓
- Cooler + gel packs included в packaging ✓

---

## Cost considerations

Frozen shipping cost premium:
- Cooler box: $1.50-$3.00
- Gel packs (2-4): $1.00-$2.00
- Insulation foam: $0.50
- Total packaging overhead: **~$4-5 per bundle**

Bundle Factory cost calculator должен add `+$4.50` для Frozen bundles в `cost_breakdown.packaging_cents`.

---

## References

- https://sellercentral.amazon.com/help/hub/reference/external/G201307470
- FDA allergen list: https://www.fda.gov/food/food-allergensgluten-free-guidance-documents-regulatory-information/food-allergies
- Internal: [`compliance-grocery.md`](compliance-grocery.md), [`gift-set-policy.md`](gift-set-policy.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
