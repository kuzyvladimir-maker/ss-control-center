# Amazon Category: Cheese & Charcuterie Gifts

> **Browse Node ID:** `2255573011`
> **Dual hierarchy:** доступна через `Food & Beverage Gifts` AND `Meat & Seafood` parents
> **Last verified:** 2026-05-17
> **Priority:** P0 для cheese/charcuterie gift bundles

---

## TL;DR

Cheese & Charcuterie Gifts — refrigerated category с двойной hierarchy в Amazon catalog. Все bundles требуют cold-chain shipping (cooler + 1-2 gel packs). Allergen `Milk` обязателен. Bundle Factory check: Vladimir's Amazon ungating status для Refrigerated — TBD verify.

---

## Hard rules

### 1. Browse node + dual path

```
Path A: Grocery & Gourmet Food → Food & Beverage Gifts → Cheese & Charcuterie Gifts
Path B: Grocery & Gourmet Food → Meat & Seafood → Cheese & Charcuterie Gifts
```

Указываем единый node ID `2255573011` — Amazon индексирует в оба пути автоматически.

### 2. Storage temperature

`storage_temperature: Refrigerated` обязательно. См. [`category-refrigerated.md`](category-refrigerated.md).

### 3. Allergens (FDA Big 9 — обязательно указать)

Все cheese содержит `Milk`. Часто также:
- `Tree nuts` — если nut-encrusted cheeses
- `Wheat` — если включены crackers
- `Soybeans` — некоторые artisan cheeses

### 4. Pasteurization

Vladimir's sourcing — Walmart/Target/Publix — **все cheeses pasteurized** (US retail standard). Unpasteurized cheeses (raw milk) — separate FDA approval, не для MVP.

### 5. Component composition

Typical bundles:
| Type | Components | Bundle Size |
|---|---|---|
| Classic cheese board | 3-4 cheeses + crackers + jam | 6-8 items |
| Italian charcuterie | Prosciutto + salami + parmesan + olives | 5-7 items |
| Wine pairing kit | Cheeses + dried fruit + nuts (no actual wine) | 6-8 items |
| Holiday gift box | Multi-cheese assortment + accompaniments | 8-12 items |

### 6. Shipping requirements

- **Cooler box:** medium-large (heavier than frozen due to glass jars + multiple items)
- **Gel packs:** 2-4 (refrigerated, не frozen)
- **Mon-Wed only ship dates** (предотвратить weekend in transit)
- **Tracking required**
- **Expiration display:** "Best within X weeks of receipt"

### 7. Sourcing notes

| Source | What to buy |
|---|---|
| Publix | Premium cheeses (Boar's Head, deli meats) |
| Target | Murray's cheese line |
| BJ's | Bulk multi-cheese packs |
| Whole Foods | Artisan / organic specialty |
| Walmart | Marketplace pricing для commodity cheeses |

---

## Soft rules

### Title pattern

```
Salutem Vita – Cheese & Charcuterie Gift Set, {variant}, Gift Box
```

Examples:
- `Salutem Vita – Cheese & Charcuterie Gift Set, Italian Selection, Gift Box`
- `Salutem Vita – Premium Cheese Board Gift Set, 8 Count`

### Bullets emphasis

1. Premium quality sources (Boar's Head, Wisconsin artisans)
2. Pairing suggestions (wine, fruit)
3. Refrigerated cold-chain shipping
4. Includes presentation board (если actual board в bundle)
5. Perfect gift for {occasion: housewarming, holiday, anniversary}

### Image strategy

Main: cheese board styled photo on white background, "GIFT SET" branded box visible behind.
Secondary: individual cheese close-ups, pairing suggestions, cooler+gel packs shipping visual.

---

## Compliance check (Stage 6)

```typescript
function validateCheeseBundleCompliance(bundle: BundleDraft): ComplianceResult {
  const issues: string[] = [];

  // Browse node
  if (bundle.attributes?.recommended_browse_nodes !== '2255573011') {
    issues.push('Browse node should be 2255573011 (Cheese & Charcuterie Gifts)');
  }

  // Storage
  if (bundle.components.some(c => c.storage_temp !== 'Refrigerated')) {
    issues.push('All cheese components must be Refrigerated');
  }

  // Allergens
  const allergens = aggregateAllergens(bundle.components);
  if (!allergens.includes('Milk')) {
    issues.push('Milk allergen must be present for cheese bundle');
  }

  // Pasteurization
  if (bundle.components.some(c => c.metadata?.pasteurized === false)) {
    issues.push('Unpasteurized cheese requires separate FDA approval');
  }

  // Cooler packaging
  if (!bundle.packaging_spec?.cooler_size || bundle.packaging_spec.cooler_size === 'none') {
    issues.push('Cheese bundle requires cooler packaging');
  }

  return { passed: issues.length === 0, issues };
}
```

---

## Cost overhead

- Cooler (medium): $2.50
- Gel packs (3): $1.50
- Insulation: $0.50
- **Total packaging: ~$4.50 per bundle**

Component cost typically high ($4-$8 per artisan cheese × 3-4 = $15-30 components).
Suggested retail: $45-$85.

---

## Walmart compatibility

❌ **Not for MVP** — Walmart Refrigerated category закрыта для Vladimir.

---

## References

- Browse node: https://www.amazon.com/Cheese-Charcuterie-Gifts/b?node=2255573011
- FDA cheese pasteurization: https://www.fda.gov/food/buy-store-serve-safe-food/raw-milk-cheeses
- Internal: [`browse-nodes-grocery.md`](browse-nodes-grocery.md), [`category-refrigerated.md`](category-refrigerated.md), [`compliance-grocery.md`](compliance-grocery.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
