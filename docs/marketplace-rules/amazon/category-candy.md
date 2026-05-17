# Amazon Category: Candy & Chocolate Gifts

> **Browse Node ID:** `2255572011`
> **Last verified:** 2026-05-17
> **Priority:** P1 (high seasonal demand Q4 + Feb/Easter)

---

## TL;DR

Candy & Chocolate Gifts — shelf-stable category, но **heat-sensitive** (chocolate melts >85°F / 29°C). Vladimir's Florida warehouse в Clearwater — climate warning ~6 months in year. Spring-Summer shipping (May-September) требует **special insulated packaging** OR seasonal pause.

---

## Hard rules

### 1. Browse node

`2255572011` Candy & Chocolate Gifts.

Alternative: `12011207011` Food Assortments & Variety Gifts если bundle = mixed (candy + cookies + другое).

### 2. Storage temperature

`storage_temperature: Ambient` (≤75°F / 24°C ideal). Но **heat-sensitive**:
- Chocolate melts >85°F
- Gummies sticky >90°F
- Hard candies OK even at high temp

### 3. Allergens

Очень частые в candy/chocolate:
- `Milk` — почти всё chocolate (milk chocolate)
- `Soybeans` — soy lecithin как emulsifier
- `Tree nuts` — almonds, hazelnuts
- `Peanuts` — peanut butter cups
- `Wheat` — chocolate-covered pretzels, biscuits

Aggregator должен **тщательно** проверить каждый component.

### 4. Component composition

| Bundle type | Components | Pack count |
|---|---|---|
| Premium chocolate box | Lindt + Ghirardelli + Russell Stover assortment | 4-8 |
| Candy variety pack | M&Ms + Skittles + Twix + Snickers | 8-15 |
| Valentine's gift box | Heart-shaped chocolates + flowers + card | 3-5 |
| Easter basket (без actual basket) | Chocolate eggs + jelly beans + Cadbury | 6-10 |
| Halloween treat box | Trick-or-treat assortment | 20-50 (small candies) |
| Christmas candy gift | Stockings + advent + traditional candies | 10-20 |

### 5. Sourcing

| Source | What to buy |
|---|---|
| Walmart | Hershey's, M&Ms, Russell Stover — commodity |
| Target | Lindt, Ghirardelli, Reese's |
| BJ's | Bulk multi-packs (Halloween mix, holiday) |
| Sam's Club | Costco-style bulk candy |
| Publix | Specialty / European chocolates |

### 6. Heat-sensitive shipping (CRITICAL)

**Florida warehouse + summer shipping = melted chocolate disaster.**

Strategy:
- **November-April:** standard cardboard box, no insulation
- **May-October:** add ice pack (small) + insulated liner для chocolate-heavy bundles
- **June-August:** consider seasonal pause или mandatory cold-pack shipping

Cost overhead summer:
- Insulation liner: $0.50
- Small gel pack (1): $0.50
- Total summer surcharge: ~$1.00

### 7. Seasonal demand peaks

| Period | Demand | Strategy |
|---|---|---|
| Sep 1 - Oct 31 | Halloween 🎃 | Trick-or-treat themed mixes |
| Nov 1 - Dec 24 | Christmas/holiday 🎄 | Premium gift boxes, advent calendars |
| Jan 25 - Feb 14 | Valentine's ❤️ | Heart-shaped, romantic |
| Mar 1 - Apr 30 | Easter 🐰 | Egg-shaped, Cadbury |
| May 1 - Sep 30 | Summer (low demand) | Reduce inventory, focus на other categories |

Bundle Factory Phase 4+ — seasonal scheduler в `GenerationJob` triggers.

---

## Soft rules

### Title patterns

```
Salutem Vita – Chocolate Gift Box, {variant}, {Pack Size}
Salutem Vita – Candy Variety Gift Set, {Pack Size}
```

Examples:
- `Salutem Vita – Premium Chocolate Gift Box, Variety Pack of 8`
- `Salutem Vita – Halloween Candy Gift Set, 25 Pieces`
- `Salutem Vita – Valentine's Chocolate Heart Gift Box, 12 Count`

### Bullets emphasis

1. Premium brands (Lindt, Ghirardelli)
2. Variety / assortment
3. Heat-protected packaging (если summer)
4. Perfect gift for {occasion}
5. Allergen warning

### Allergen warning bullet (recommended)

Финальный bullet:
> "🍫 Contains milk, soy. May contain tree nuts and peanuts. Please check individual product labels for specific allergen information."

---

## Cost overhead

Year-round:
- Cardboard outer box: $1.00
- Tissue / shred: $0.30
- Labels: $0.20
- **Base packaging: ~$1.50 per bundle**

Summer surcharge (May-Oct):
- Insulation liner: $0.50
- Small gel pack: $0.50
- **Summer total: ~$2.50 per bundle**

Component cost typically: $10-30 (premium chocolates).
Suggested retail: $30-$75.

---

## Walmart compatibility

✅ **Walmart-compatible** — shelf-stable. Sync as parallel ChannelSKU.

⚠️ Heat-sensitive — Vladimir может paused чтобы avoid customer complaints.

---

## Compliance check (Stage 6)

```typescript
function validateCandyBundle(bundle: BundleDraft, currentMonth: number): ComplianceResult {
  const issues: string[] = [];

  // Browse node
  if (!['2255572011', '12011207011'].includes(bundle.attributes?.recommended_browse_nodes)) {
    issues.push('Browse node should be 2255572011 or 12011207011');
  }

  // Allergens check
  const allergens = aggregateAllergens(bundle.components);
  const expectedCommonAllergens = ['Milk', 'Soybeans'];
  for (const expected of expectedCommonAllergens) {
    if (!allergens.includes(expected) && bundle.components.some(c => c.product_name.toLowerCase().includes('chocolate'))) {
      issues.push(`[warning] Chocolate bundle ожидает allergen "${expected}" — verify`);
    }
  }

  // Summer shipping
  const isSummer = currentMonth >= 5 && currentMonth <= 9; // May-Sep
  if (isSummer && bundle.components.some(c => c.product_name.toLowerCase().includes('chocolate'))) {
    if (!bundle.packaging_spec?.has_insulation || !bundle.packaging_spec?.has_gel_pack) {
      issues.push('[warning] Summer chocolate shipping без insulation/gel pack — high melt risk');
    }
  }

  return { passed: issues.length === 0, issues };
}
```

---

## References

- Browse node: https://www.amazon.com/Candy-Chocolate-Gifts/b?node=2255572011
- Internal: [`browse-nodes-grocery.md`](browse-nodes-grocery.md), [`category-shelf-stable.md`](category-shelf-stable.md), [`compliance-grocery.md`](compliance-grocery.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
