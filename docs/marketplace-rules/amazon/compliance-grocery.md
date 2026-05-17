# Amazon Compliance — Grocery (FDA)

> **Source:** FDA Food Labeling Guide + Amazon Seller Central
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Grocery bundles в US должны соответствовать FDA Food Labeling Requirements. Главное правило: **оригинальную упаковку компонентов нельзя удалять или скрывать**. Allergens, nutrition, expiration — обязательно visible.

---

## Hard rules

### 1. Original packaging — preserved

Bundle creator (Vladimir) **не может**:
- Удалить original Jimmy Dean / Lunchables / Uncrustables packaging
- Repackage components в generic containers
- Скрыть expiration dates, allergen labels

Bundle = **outer presentation box** (Salutem Solutions branded) + **original retail packaging components inside**.

### 2. Allergen disclosure (FDA Big 9)

В Listing attributes `allergen_information` нужно указать ВСЕ allergens, присутствующие в любом из components:

| Allergen | Symbol |
|---|---|
| Milk | 🥛 |
| Eggs | 🥚 |
| Fish | 🐟 |
| Crustacean shellfish | 🦐 |
| Tree nuts | 🌰 |
| Peanuts | 🥜 |
| Wheat | 🌾 |
| Soybeans | 🫘 |
| Sesame | (новое 2023) |

Stage 4 (Content Generation): AI должен агрегировать allergens из всех components в bundle.

### 3. Nutrition Facts

Bundle сам не обязан иметь nutrition facts, потому что components сохраняют свои original labels. Но **если** на presentation box есть food claims (e.g. "Healthy Snack Pack") — потребуется агрегированная nutrition info.

Vladimir's strategy: **no health claims на box** → no nutrition aggregation needed.

### 4. Expiration date handling

Bundle expiration date = earliest expiration среди all components. Это критично для frozen + refrigerated.

Bundle Factory tracking:
- `BundleComponent.expiration_days` (days from production)
- Aggregated bundle expiration = MIN(component expiration days)
- Display on listing: "Best within X months of receipt"

### 5. Country of origin

Attribute `country_of_origin` = `USA` (assuming Vladimir's sourcing all US-based).

---

## Specific concerns по типам products

### Frozen meats (Jimmy Dean, Hormel, etc.)
- USDA inspected (not FDA primarily)
- Must remain frozen in transit
- Allergen disclosure обязательна

### Dairy (cheese, yogurt)
- Pasteurization status (Vladimir's components — all pasteurized)
- Refrigerated

### Snacks/dry (Cheez-Its, Pringles)
- Allergens (wheat, dairy для some)
- Shelf-stable

### Pet food
- AAFCO compliance (separate from FDA)
- Не для human consumption — clear labeling

---

## Stage 4 AI Aggregation Logic

```typescript
function aggregateAllergens(components: BundleComponent[]): string[] {
  const allergens = new Set<string>();
  for (const comp of components) {
    if (comp.allergens) {
      for (const a of comp.allergens) {
        allergens.add(a);
      }
    }
  }
  return Array.from(allergens);
}

function aggregateExpiration(components: BundleComponent[]): number {
  return Math.min(...components.map(c => c.expiration_days || 365));
}
```

Result добавляется в ChannelSKU.attributes:
```json
{
  "allergen_information": [{"value": "Milk, Wheat, Soybeans", "marketplace_id": "..."}],
  "expiration_period": [{"value": "12 months from receipt"}]
}
```

---

## References

- FDA Food Labeling: https://www.fda.gov/food/food-labeling-nutrition/food-labeling-guide
- FDA Allergens: https://www.fda.gov/food/food-allergensgluten-free-guidance-documents-regulatory-information
- USDA (для meat): https://www.fsis.usda.gov/
- Internal: [`category-frozen-grocery.md`](category-frozen-grocery.md), [`gift-set-policy.md`](gift-set-policy.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
