# Amazon Title Policy

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/G50R34A8WJ58JAYK (Title Style Guide)
> **Last verified:** 2026-05-17
> **Last updated:** 2026-05-17 (HARD BLOCK rule after Retailer Distributor account suspension)
> **Applies to:** All Amazon listings
> **Priority:** P0 (нарушение = suppression / SEO penalty / account suspension)

---

## TL;DR

Title — главное место для keyword visibility и compliance. Max **200 chars** (включая пробелы) для большинства категорий, **80-150** для Pet Food и некоторых others. Должен включать brand + product type + key descriptors + size/count. Не должен включать promotional text, emoji, special chars (кроме `-` `&` `,` `()` `:`).

🚨 **HARD RULE (added 2026-05-17):** Если brand field = Salutem Vita или Starfit — **НИКАКИХ** чужих брендов в title. Этот pattern привёл к блокировке 5 ASINs.

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
Salutem Vita – {Generic Product Description}, {Size/Weight}, Gift Set – Pack of {N}
```

Примеры из его existing каталога:
- `Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12`
- `Salutem Vita – Three Cheese Omelets, Gourmet Breakfast Gift Set – Pack of 4`
- `Salutem Vita - Sweet Italian Style Chicken Dinner Sausage, 32 oz. - Pack of 6`

### 3. Запрещённые элементы

- ❌ **Foreign brand names** под own brand (Salutem Vita / Starfit) → HARD BLOCK (см. секцию ниже)
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

### 6. 🚨 NO FOREIGN BRANDS RULE (HARD BLOCK)

**Добавлено 2026-05-17 после блокировки Retailer Distributor аккаунта.**

Если **brand field** = Salutem Vita или Starfit (т.е. это листинг под нашим брендом), то title **НЕ ДОЛЖЕН** содержать **ЛЮБОЙ** из этих foreign brand names:

**5 brands из блокированных ASINs (permanent blocklist):**
- Goya
- Kraft
- Ore-Ida (and "Ore Ida")
- El Monterey
- Oh Snap! (and "Oh Snap")

**High-risk consumable brands (typical sourcing pool):**
- Lunchables, Uncrustables, Jimmy Dean, Smucker's, Eggland's
- Hormel, Tyson, Stouffer, Healthy Choice, Marie Callender
- Hot Pockets, Lean Cuisine, Eggo, Bagel Bites, TGI Friday
- Pillsbury, Quaker, Kellogg, Cheerios, Pop-Tarts, Frito-Lay
- Doritos, Lay's, Pringles, Cheez-It, Goldfish, Cheetos

**Common gift basket components:**
- Ghirardelli, Hershey, Hershey's, Lindt, Godiva, Ferrero
- Coca-Cola, Coke, Pepsi, Sprite, Dr Pepper, Mountain Dew
- Starbucks, Folgers, Maxwell House, Nescafe, Keurig

Если bundle factory детектирует ЛЮБОЙ из этих brand names в title под Salutem Vita / Starfit — **листинг блокируется**. Не warning, не review queue, а hard block. AI должен переписать title без brand reference.

См. также: `prohibited-keywords.md` — полный consolidated list.

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
- Product description clear (generic terms, no foreign brand) ✓
- Size (4.3 oz) указан ✓
- "Gift Set" присутствует ✓
- Pack count (12) указан ✓
- Нет emojis / caps / promotional language ✓
- Нет foreign brand names ✓

### ❌ Incorrect — multiple violations

```
🎁 BEST Salutem Vita Lunchables Pizza Gift Set!! - Pack of 12 *FREE SHIPPING*
```

Ошибки:
- Emoji 🎁 в title (forbidden)
- CAPS "BEST" (subjective claim в caps)
- "Lunchables" (foreign brand → HARD BLOCK)
- Восклицательные знаки `!!`
- "FREE SHIPPING" promotional phrase
- `*` special character

### 🚨 BLOCKED — каузальный паттерн от 2026-05-17 блокировки

```
Salutem Vita – Kraft Spongebob Mac & Cheese Microwavable Cups, 4ct Gift Set – Pack of 6
Salutem Vita – Goya Baked Ripe Plantains, Sweet and Ready-to-Eat, Gift Set, 11 oz – Pack of 5
Salutem Vita – El Monterey Burritos Variety Pack, 32 oz, 8 count, Gift Set – Pack of 3
Salutem Vita – Ore-Ida Gluten-Free Extra Crispy Tater Tots, 28 oz – Pack of 6
Salutem Vita – Oh Snap! Dill Pickle Snacking Cuts, 3.25 oz Gift Set – Pack of 3
```

Эти 5 листингов были HARD BLOCKED Amazon-ом 2026-05-17 за **Trademark Logo Misuse**.
Каузальный паттерн: `[Own Brand] – [Foreign Brand] [Product]` — implies co-branding/endorsement
без trademark authorization. Compliance gate **никогда** не позволит создать листинг с этим паттерном.

**Safe rewrites (Bundle Factory будет автоматически предлагать):**
```
Salutem Vita – Microwavable Mac & Cheese Cups Gift Set, 4 oz, Pack of 6
Salutem Vita – Ripe Plantains Snack Gift Set, Sweet & Ready-to-Eat, 11 oz – Pack of 5
Salutem Vita – Frozen Burrito Variety Gift Pack, Classic Mexican Flavors, 32 oz – Pack of 3
Salutem Vita – Extra Crispy Tater Tots Family Gift Set, Gluten-Free, 28 oz – Pack of 6
Salutem Vita – Dill Pickle Snacking Gift Set, Spicy & Sweet Pickle Bites, 3.25 oz – Pack of 3
```

Generic product description вместо brand name. Bundle Factory pipeline создаёт title через AI
с этим constraint built-in (см. compliance-gate module).

---

## Compliance checks для Stage 6

```typescript
function validateTitle(title: string, brand: string, channel: SalesChannel): ComplianceResult {
  const issues: string[] = [];
  let blocked = false;

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

  // HARD BLOCK: foreign brand anywhere в title под нашим брендом
  // ОБНОВЛЕНО 2026-05-17 после блокировки Retailer Distributor аккаунта.
  // 5 ASINs были заблокированы за паттерн "Salutem Vita – [Foreign Brand] Product":
  //   B0FRG1Y6SN (Goya), B0FLWN3KZ9 (El Monterey), B0FNKR2P3Y (Ore-Ida),
  //   B0FJQK4S45 (Oh Snap!), B0FBML98G3 (Kraft).
  // Policy: НИКАКИХ чужих брендов в title если brand field = Salutem Vita / Starfit.

  const OWN_BRANDS = ['Salutem Vita', 'Starfit'];
  const isOwnBrand = OWN_BRANDS.some(b => brand.toLowerCase().includes(b.toLowerCase()));

  const FORBIDDEN_FOREIGN_BRANDS_IN_TITLE = [
    // Brands which led to 2026-05-17 blocking (HARD BLOCK — permanent blocklist)
    'Goya', 'Kraft', 'Ore-Ida', 'Ore Ida', 'El Monterey', 'Oh Snap', 'Oh Snap!',
    // High-risk consumable brands (Vladimir's typical sourcing pool)
    'Lunchables', 'Uncrustables', 'Jimmy Dean', "Smucker's", "Eggland's",
    'Hormel', 'Tyson', 'Stouffer', 'Healthy Choice', 'Marie Callender',
    'Hot Pockets', 'Lean Cuisine', 'Eggo', 'Bagel Bites', 'TGI Friday',
    'Pillsbury', 'Quaker', 'Kellogg', 'Cheerios', 'Pop-Tarts', 'Frito-Lay',
    'Doritos', "Lay's", 'Pringles', 'Cheez-It', 'Goldfish', 'Cheetos',
    // Common gift basket components
    'Ghirardelli', 'Hershey', "Hershey's", 'Lindt', 'Godiva', 'Ferrero',
    'Coca-Cola', 'Coke', 'Pepsi', 'Sprite', 'Dr Pepper', 'Mountain Dew',
    'Starbucks', 'Folgers', 'Maxwell House', 'Nescafe', 'Keurig',
  ];

  if (isOwnBrand) {
    for (const fb of FORBIDDEN_FOREIGN_BRANDS_IN_TITLE) {
      // Escape special regex characters from brand name
      const escaped = fb.replace(/[.*+?^${}()|[\]\\]/g, c => `\\${c}`);
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(title)) {
        issues.push(
          `[BLOCKED] Foreign brand "${fb}" detected in title under own brand "${brand}". ` +
          `Pattern caused 5 ASIN blocks on 2026-05-17. Reword title to remove brand reference.`
        );
        blocked = true;
      }
    }
  }

  // Pack info
  if (!/Pack of \d+|\d+ Count/i.test(title))
    issues.push('[warning] Pack size/count не указан в title');

  return { passed: !blocked && issues.length === 0, blocked, issues };
}
```

---

## References

- **Style guide:** https://sellercentral.amazon.com/help/hub/reference/external/G50R34A8WJ58JAYK
- **Title length per category:** https://sellercentral.amazon.com/help/hub/reference/external/GYTR6SYGFA5E3EQC
- **Trademark policy:** https://sellercentral.amazon.com/help/hub/reference/external/GZUQ6GBBXQVHQKF2
- **Internal:** [`gift-set-policy.md`](gift-set-policy.md), [`bundle-policy.md`](bundle-policy.md), [`prohibited-keywords.md`](prohibited-keywords.md)

---

**Maintained by:** Vladimir + Claude
**Last reviewed:** 2026-05-17
