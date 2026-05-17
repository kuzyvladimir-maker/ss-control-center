# Amazon Category: Coffee & Tea Gifts

> **Coffee Browse Node:** `23900459011`
> **Tea Browse Node:** `23700435011` (canonical "Gourmet Tea Gifts", UI shows "Tea Gifts")
> **Last verified:** 2026-05-17
> **Priority:** P1 для coffee/tea gift bundles

---

## TL;DR

Coffee & Tea Gifts — самая простая категория из all sub-categories: shelf-stable, no cold-chain shipping, легко scalable bundles. Walmart-compatible. Vladimir's high-margin opportunity для Q4 holiday gift season.

---

## Hard rules

### 1. Browse node selection

- **Coffee-focused bundle** → `23900459011` Coffee Gifts
- **Tea-focused bundle** → `23700435011` Gourmet Tea Gifts
- **Mixed coffee + tea** → `12011207011` Food Assortments & Variety Gifts (главный gift basket node)

### 2. Storage temperature

`storage_temperature: Ambient` (shelf-stable).

### 3. Allergens

Coffee/tea sами — **no Big 9 allergens** обычно. Но проверяй:
- Tea blends с nut/herbal infusions могут содержать `Tree nuts`
- Coffee creamers — `Milk`, `Soybeans` (для non-dairy)
- Chocolate-covered espresso beans (если включены) — `Milk`, `Soy`

### 4. Caffeine disclosure

Не обязательно по FDA, но recommended:
- "Contains caffeine" в description
- Для decaf — clearly label "Decaffeinated"

### 5. Organic / Fair-trade labeling

Если bundle содержит organic products — указать `is_organic_product: true` в attributes. Если Fair-trade certified — `is_fair_trade_certified: true`.

### 6. Component composition

| Bundle type | Components | Pack count |
|---|---|---|
| Coffee Lover's Set | Ground coffee × 3 + creamer + mug | 5-7 |
| K-Cup Variety | K-Cups × 24-48 multiple brands | 24-48 |
| Coffee + Snacks | Coffee + biscotti + chocolate | 4-6 |
| Tea Sampler | Tea bags × 5-10 varieties + honey + strainer | 6-12 |
| Coffee & Tea Combo | 2 coffees + 3 teas + accessories | 6-8 |
| Morning Gift Box | Coffee + tea + creamer + mug + snacks | 5-7 |

### 7. Sourcing

| Source | What to buy |
|---|---|
| Walmart | Folgers, Maxwell House, Lipton, Bigelow — commodity |
| Target | Starbucks Reserve, premium brands |
| BJ's | Bulk K-Cups, multi-pack tea |
| Whole Foods | Organic, single-origin specialty |
| Trader Joe's | Unique blends (TJ's brand) |

### 8. Shipping requirements

- **Standard packaging** — cardboard outer box, нет cooler
- **No special temperature requirements**
- **Any day of week ship dates** (не frozen)
- Light весовая: typical bundle 1-3 lbs

---

## Soft rules

### Title patterns

Coffee: `Salutem Vita – Coffee Gift Set, {variant}, Pack of {N}`
Tea: `Salutem Vita – Tea Gift Set, {variant}, {N} Count`
Combo: `Salutem Vita – Coffee & Tea Lover's Gift Set, {N} Items`

Examples:
- `Salutem Vita – Coffee Gift Set, Variety Pack of 6 Ground Coffees`
- `Salutem Vita – Premium Tea Sampler Gift Set, 60 Tea Bags, 10 Varieties`
- `Salutem Vita – Morning Coffee Gift Box with Mug, 5 Items`

### Bullets emphasis

1. Variety of flavors / brands в одной gift
2. Convenience / ready-to-brew
3. Quality sourcing (если premium)
4. Includes accessories (mug, spoon, creamer)
5. Perfect gift for {occasion: birthday, work appreciation, holiday}

### Q4 seasonal opportunity

Q4 (Oct-Dec) — **peak demand** для coffee/tea gift sets. Holiday packaging variants (Christmas, Hanukkah, generic "Happy Holidays") могут увеличить sales 3-5x. Plan inventory + marketing соответственно.

---

## Cost overhead

- Cardboard outer box: $1.00
- Tissue paper / shred: $0.30
- Labels: $0.20
- **Total packaging: ~$1.50 per bundle**

Component cost typically: $8-25 (coffee blends + mug).
Suggested retail: $25-$65.

**High margin category** — ratio of selling price : COGS лучше чем frozen.

---

## Walmart compatibility

✅ **Walmart-compatible** — shelf-stable category открыта для Vladimir. Создать parallel ChannelSKU automatically.

---

## eBay / TikTok considerations

Также подходит для eBay и TikTok Shop — нет storage restrictions. TikTok особенно эффективен для visually-appealing tea sampler boxes (видео unboxing).

---

## Compliance check (Stage 6)

```typescript
function validateCoffeeTeaBundle(bundle: BundleDraft): ComplianceResult {
  const issues: string[] = [];

  // Browse node logic
  const hasCoffee = bundle.components.some(c => c.product_name.toLowerCase().includes('coffee'));
  const hasTea = bundle.components.some(c => c.product_name.toLowerCase().includes('tea'));
  
  const expectedNode = hasCoffee && hasTea
    ? '12011207011' // mixed
    : hasCoffee
      ? '23900459011' // coffee
      : '23700435011'; // tea

  if (bundle.attributes?.recommended_browse_nodes !== expectedNode) {
    issues.push(`Browse node should be ${expectedNode}`);
  }

  // Storage check
  if (bundle.components.some(c => c.storage_temp && c.storage_temp !== 'Ambient')) {
    issues.push('[warning] Coffee/tea bundles обычно shelf-stable; verify storage_temp');
  }

  return { passed: issues.length === 0, issues };
}
```

---

## References

- Coffee Gifts node: https://www.amazon.com/Coffee-Gifts/b?node=23900459011
- Gourmet Tea Gifts node: https://www.amazon.com/Gourmet-Tea-Gifts/b?node=23700435011
- Internal: [`browse-nodes-grocery.md`](browse-nodes-grocery.md), [`category-shelf-stable.md`](category-shelf-stable.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
