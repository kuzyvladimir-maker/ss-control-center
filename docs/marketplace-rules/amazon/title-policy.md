# Amazon Title Policy

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/G50R34A8WJ58JAYK (Title Style Guide)
> **Last verified:** 2026-05-17
> **Applies to:** All Amazon listings
> **Priority:** P0 (нарушение = suppression / SEO penalty)

---

## TL;DR

Title — главное место для keyword visibility и compliance. Max **200 chars** (включая пробелы) для большинства категорий, **80-150** для Pet Food и некоторых others. Должен включать brand + product type + key descriptors + size/count. Не должен включать promotional text, emoji, special chars (кроме `-` `&` `,` `()` `:`).

---

## Hard rules (must)

### 1. Length limits

| Категория | Max chars |
|---|---|
| Grocery (большинство) | 200 |
| Pet Food | 200 |
| Health & Beauty | 200 |
| Baby | 200 |
| Apparel (для reference) | 80 |

Точная категория Vladimir = Grocery → **200 chars max**.

Bundle Factory check: `title.length <= 200`. Если экспорт показывает >200 — Amazon truncate / reject.

### 2. Structure (recommended pattern)

```
[Brand] – [Product Name], [Size/Weight], [Variant/Flavor], [Pack Info]
```

Дашз (`–`) или (`-`) как separator между brand и product description работает хорошо.

**Pattern Vladimir для gift sets:**
```
Salutem Vita – {Product Description}, {Size/Weight}, Gift Set – Pack of {N}
```

Примеры из его existing каталога:
- `Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12`
- `Salutem Vita – Three Cheese Omelets, Gourmet Breakfast Gift Set – Pack of 4`
- `Salutem Vita - Sweet Italian Style Chicken Dinner Sausage, 32 oz. - Pack of 6`

### 3. Запрещённые элементы

- ❌ **Emoji** — Amazon strict on emojis in titles. Хотя Vladimir использует эмодзи в bullets (это OK), в title — категорически нет.
- ❌ **CAPS LOCK** — кроме acronyms ("USB", "BBQ", "FDA")
- ❌ **Promotional phrases:** "Best Seller", "Buy Now", "100% Authentic", "Sale", "On Sale", "Free Shipping", "Limited Time"
- ❌ **Subjective claims без proof:** "Best", "Amazing", "Top Quality"
- ❌ **HTML / special chars:** `<>`, `™`, `®`, `©`, `*`, `?`, `!` (только для emergency punctuation)
- ❌ **Цена в title:** "$10", "10 USD"
- ❌ **Дублирование brand name:** "Salutem Vita Salutem Vita Pizza" — повторяющиеся terms

### 4. Brand первым словом

Title должен **начинаться** с brand name (Salutem Vita / Starfit). Это:
- Помогает Amazon classifier
- Brand Registry recognizing
- Customer brand awareness

### 5. Specific count/size required

Bundle title обязан включать:
- **Pack size** (e.g. "Pack of 12", "12 Count")
- **Total weight** или **per-unit weight** (e.g. "4.3 oz", "3.6 pounds")

Без этого Amazon classifier не сможет правильно categorize.

---

## Soft rules (should)

### 1. Front-load important keywords

Первые 60-80 chars видны в search results truncated view. Главные keywords (brand, product type, size) — в начале.

### 2. Include "Gift Set" для gift basket category

См. [`gift-set-policy.md`](gift-set-policy.md). Слово "Gift Set" в title помогает classifier.

### 3. Не повторять слова

Search ignore repeating words. `Salutem Vita Pizza Pizza Lunch Kit Pizza` = same SEO weight as `Salutem Vita Pizza Lunch Kit`. Просто захламляет title.

### 4. Размер шрифта в head image для duplication

Если на упаковке написано "GIFT SET 12 COUNT" — повторение этого в title (`Gift Set – Pack of 12`) — двойная гарантия classifier.

---

## Examples

### ✅ Correct

```
Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12
```

Анализ:
- 79 chars (well под limit)
- Brand первым словом ✓
- Product description clear ✓
- Size (4.3 oz) указан ✓
- "Gift Set" присутствует ✓
- Pack count (12) указан ✓
- Нет emojis / caps / promotional language ✓

### ❌ Incorrect — несколько ошибок

```
🎁 BEST Salutem Vita Lunchables Pizza Gift Set!! - Pack of 12 *FREE SHIPPING*
```

Ошибки:
- Emoji 🎁 в title (forbidden)
- CAPS "BEST" (subjective claim в caps)
- "Lunchables" (chужой brand IP)
- Восклицательные знаки `!!`
- "FREE SHIPPING" promotional phrase
- `*` special character

### ⚠️ Edge case

```
Salutem Vita Jimmy Dean Breakfast Gift Set, Pack of 12
```

Это **на грани**. Amazon может classify это как:
- ✅ Allowed (если Jimmy Dean указано как content description, не brand)
- ❌ Violation (если interpret как using "Jimmy Dean" в brand position)

**Safer rewrite:**
```
Salutem Vita – Breakfast Sandwich Gift Set, 4.9 oz, Pack of 12
```

Or include Jimmy Dean в description / bullets, not title.

---

## Compliance checks для Stage 6

```typescript
function validateTitle(title: string, brand: string, channel: SalesChannel): ComplianceResult {
  const issues: string[] = [];

  // Length
  if (title.length > 200) issues.push('Title > 200 chars');

  // Forbidden patterns
  if (/\p{Emoji}/u.test(title)) issues.push('Emoji в title запрещено');
  if (/\b(BEST|AMAZING|TOP|FREE|SALE|BUY NOW|LIMITED)\b/i.test(title))
    issues.push('Promotional language в title');

  // Brand первым словом
  if (!title.startsWith(brand)) issues.push('Brand не первое слово в title');

  // Special chars (allowed: - – & , ( ) :)
  const forbidden = title.match(/[<>™®©*?!]/g);
  if (forbidden) issues.push(`Special chars: ${forbidden.join(', ')}`);

  // Foreign brand в позиции brand
  const FOREIGN_BRANDS = ['Lunchables', 'Uncrustables', 'Jimmy Dean', 'Smucker\'s', 'Eggland\'s', 'Hormel'];
  for (const fb of FOREIGN_BRANDS) {
    const idx = title.indexOf(fb);
    if (idx > 0 && idx < 30) {
      // Foreign brand в первых 30 chars = подозрительно
      issues.push(`[warning] Foreign brand "${fb}" в начале title — может быть policy violation`);
    }
  }

  // Pack info
  if (!/Pack of \d+|\d+ Count|Pack of \d+/i.test(title))
    issues.push('[warning] Pack size/count не указан в title');

  return { passed: issues.length === 0, issues };
}
```

---

## References

- **Style guide:** https://sellercentral.amazon.com/help/hub/reference/external/G50R34A8WJ58JAYK
- **Title length per category:** https://sellercentral.amazon.com/help/hub/reference/external/GYTR6SYGFA5E3EQC
- **Internal:** [`gift-set-policy.md`](gift-set-policy.md), [`bundle-policy.md`](bundle-policy.md)

---

**Maintained by:** Vladimir + Claude
**Last reviewed:** 2026-05-17
