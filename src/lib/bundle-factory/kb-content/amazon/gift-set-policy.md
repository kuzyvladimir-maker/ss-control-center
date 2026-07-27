# Amazon Gift Set Policy ⭐

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/G200442350
> **Update:** Effective October 14, 2024 (Product Bundling Policy update for consumables)
> **Last verified:** 2026-05-17
> **Applies to:** All Amazon accounts. Critical for consumables (grocery, pet, baby, health & beauty)
> **Priority:** **P0** — нарушение = listing rejection / account risk

---

## TL;DR

Amazon с 14 октября 2024 запрещает создавать bundles из продуктов разных брендов в консумабельных категориях (grocery, pet, baby, health & beauty), **КРОМЕ** одного исключения: **Gift Basket Exception**. Bundles в "gift basket" категориях (главная — "Food Assortments & Variety Gifts") **МОГУТ** содержать продукты от разных производителей, если они physically bundled together for gifting. Это и есть юридический фундамент стратегии Salutem Vita.

Если bundle делается **не** в gift basket browse node — он должен быть **single-brand** (все products одного manufacturer'а, либо single multipack того же SKU). Иначе listing будет suppressed.

---

## Hard rules (must)

### 1. Только gift basket browse node для multi-brand

Multi-brand bundles разрешены **исключительно** в "gift basket" категории. Конкретные browse nodes — см. [`browse-nodes-grocery.md`](browse-nodes-grocery.md). Главный для Vladimir: **Food Assortments & Variety Gifts**.

Если bundle классифицируется в любую другую категорию (e.g. "Frozen Sandwiches", "Pet Treats", "Granola Bars") — это **must be single-brand**.

### 2. Physically packaged for gifting

Bundle должен быть **physically** упакован для подарочного назначения. Это означает:

- ✅ Единая внешняя коробка / box / basket
- ✅ Все компоненты находятся внутри этой упаковки
- ✅ Упаковка имеет presentation value (бренд на коробке, "Gift Set" текст, тематический дизайн)
- ❌ Просто скоч/пленка вокруг нескольких продуктов — **не считается** gift set

Стратегия Vladimir: коричневая картонная коробка с надписью "GIFT SET N COUNT" + Salutem Solutions logo + "100% FRESHNESS GUARANTEED" badge — это полностью соответствует требованию physical packaging.

### 3. Brand Registry для своего brand на коробке

Если на упаковке появляется собственный brand name (Salutem Vita) — этот brand **должен быть зарегистрирован в Amazon Brand Registry**. У Vladimir это уже есть:
- Salutem Vita → registered на Salutem Solutions account
- Starfit → registered на Sirius International account

### 4. Title не может содержать non-manufacturer brand intellectual property

В title листинга **запрещено** использовать брендовые названия продуктов внутри как часть **своего** бренда. Конкретно:

- ✅ `Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12`
- ❌ `Salutem Vita Lunchables Pizza Gift Set` (использует чужой trademark "Lunchables" в позиции собственного бренда)
- ❌ `Uncrustables Gift Set by Salutem Vita` (та же ошибка)

Чужие торговые марки могут упоминаться в **bullets** и **description** как описание содержимого:
- ✅ В bullets: `Includes 12 Lunchables Pizza with Pepperoni meals — convenient and ready to enjoy`
- ✅ В description: `This gift set contains Smucker's Uncrustables sandwiches, perfect for...`

### 5. Не rebranding продукта

Bundle не может скрывать оригинальный продукт. Внутри коробки оригинальная упаковка Jimmy Dean / Uncrustables / Lunchables **должна оставаться нетронутой** (это и так обязательно по FDA — нельзя удалить allergen/expiration labels).

Главная изображение листинга может (и должно) показывать:
- Оригинальные продукты в их упаковке
- Внешняя коробка Salutem Vita с надписью "GIFT SET"
- Все вместе как presentation

### 6. Single GTIN/UPC per bundle

Каждый bundle = новый **уникальный** SKU/UPC. Нельзя использовать UPC одного из компонентов как UPC всего bundle. Vladimir использует UPC из pool 742259xxx / 789232xxx / 617261xxx.

### 7. Brand Registry gives exemption from GTIN-by-manufacturer match

Без Brand Registry — Amazon требует, чтобы UPC принадлежал manufacturer'у того бренда, который указан как brand в листинге. Это блокирует custom UPC из third-party pool.

Vladimir имеет Brand Registry на Salutem Vita и Starfit → может либо использовать UPC из pool (с риском в некоторых категориях), либо **запросить GTIN exemption** (см. [`gtin-exemption-process.md`](gtin-exemption-process.md)). Exemption — preferred path, делает использование любого валидного UPC absolutely safe.

---

## Soft rules (should)

### 1. Include "Gift Set" в title

Хотя не обязательно — наличие фразы "Gift Set" в title:
- Помогает Amazon classifier правильно определить gift basket browse node
- Усиливает sale appeal для Q4 gifting season
- Pattern Vladimir: `Salutem Vita – {product description}, ..., Gift Set – Pack of {N}`

### 2. Visual gift cues в main image

В главном изображении должны быть **визуальные cues** что это gift set:
- Bow / ribbon (опционально)
- Текст "GIFT SET" на коробке (обязательно у Vladimir)
- Подарочная упаковка явно видна

### 3. Bullets обязательно включают gift-context финальный пункт

Стандарт Vladimir: финальный (5-й) bullet содержит "Makes a delightful gift set for {audience}". Это помогает classifier + buyer expectation.

### 4. Сохранять оригинальные allergen / nutrition info

В description рекомендуется указать source manufacturer того, что содержит bundle — для compliance с FDA labeling в случае allergen claims. Например: `Manufactured by Kraft Foods (Lunchables Pizza)` в описании.

---

## Examples

### ✅ Correct — реальный листинг Vladimir

**ASIN:** B0FH2NX7J9
**Title:** `Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12`
**Brand:** Salutem Vita (Brand Registry on Salutem Solutions)
**UPC:** 743269733851 (из pool)
**Main image:** Картонная коробка с "GIFT SET 12 COUNT" + Salutem Solutions logo + 12 Lunchables units visible
**Bullets** (выдержка):
- Includes Lunchables Pizza with Pepperoni, a fun and easy meal option 🍕
- Comes with a ready-to-assemble pizza kit for interactive meal prep ✅
- ...
- Individually wrapped components for freshness and safety 🛡️ — Makes a delightful gift set for pizza lovers 🎁

**Browse node:** Food Assortments & Variety Gifts

**Почему correct:**
- ✅ Brand owner (Salutem Vita) registered in Brand Registry
- ✅ Title не использует "Lunchables" как brand
- ✅ Physical packaging (коробка с "GIFT SET")
- ✅ Multi-brand allowed (Kraft Lunchables + Salutem Vita packaging) в gift basket category
- ✅ Final bullet содержит "gift set for {audience}"

### ❌ Incorrect — гипотетические нарушения

**Нарушение #1:** `Lunchables Pizza Variety Pack of 12 - Sausage, Pepperoni, Cheese - Bulk Pack` (без "gift set", в категории "Frozen Sandwiches", без своего бренда). Multi-brand из 3 разных Lunchables вариантов разрешено как single-brand (Lunchables = Kraft) — но только если Vladimir = authorized Kraft seller. В противном случае — listing rejected.

**Нарушение #2:** `Salutem Vita Uncrustables Gift Set – 24 Sandwiches Pack` (использует Smucker's brand "Uncrustables" как часть title brand identity). Рекомендация: переименовать на `Salutem Vita – Peanut Butter & Jelly Sandwich Gift Set, 24 Count – Frozen Pack`.

**Нарушение #3:** Gift set без physical packaging (просто несколько Uncrustables в bag без брендированной коробки). Не qualifies для gift basket exception → должен быть в стандартной категории → должен быть single-brand → если Vladimir не Smucker's authorized seller → rejected.

---

## Edge cases

### Edge case 1: Single-brand multipack без gift basket

Пример: 12 одинаковых Uncrustables PB&J packages в коробке "GIFT SET 12 COUNT". Single brand (Uncrustables = Smucker's).

**Решение:** Если Vladimir = Brand Registry owner на Salutem Vita и упаковывает в Salutem Vita gift set → можно в **gift basket category** (multi-brand exception relaxed: single-brand тоже разрешён здесь). Так же можно в стандартной "Frozen Sandwiches" category — но тогда Vladimir = brand owner of Salutem Vita, а оригинал продукт — Smucker's brand. Это сложнее: Vladimir = manufacturer of his branded gift set, который содержит Smucker's products. Здесь нужна **gift basket category** как safe choice.

**Recommendation:** Всегда листить в gift basket category. Это безопаснее всего.

### Edge case 2: Holiday gift sets (тематические)

Christmas / Valentine / Easter themed bundles — полностью одобрены exception (это и есть классический use case "gift basket"). Главное — physical packaging должна быть тематической.

### Edge case 3: Cross-category bundles (food + non-food)

Например, Uncrustables + plush toy. Это **смешанная категория** — формально gift basket exception применим, но Amazon может classify в другую browse node. **Рекомендация:** не делать cross-category в MVP. Только food gift sets.

### Edge case 4: Generic brand на коробке

Если Vladimir хочет создать gift set без брендирования Salutem Vita / Starfit — это **запрещено**. Generic brand на bundle = violation. Всегда использовать registered brand.

### Edge case 5: Amazon classifier mismatched

Иногда Amazon автоматически classify в неправильный browse node даже если мы указали "Food Assortments & Variety Gifts". В таком случае:

1. После публикации в Manage Inventory проверяем browse node
2. Если не gift basket — через Support открыть case с reference на Product Bundling Policy
3. Включить screenshot главного изображения (с "GIFT SET" текстом) как evidence

Эта ситуация встречается, но обычно решается за 24-48 часов.

---

## Compliance checks для Stage 6 (Validation)

Перед публикацией Bundle Factory должен проверить:

```typescript
function validateGiftSetCompliance(draft: BundleDraft): ComplianceResult {
  const issues: string[] = [];

  // Check 1: Brand registered
  if (!isBrandRegistered(draft.brand, draft.target_channel)) {
    issues.push(`Brand "${draft.brand}" не зарегистрирован на канале ${draft.target_channel}`);
  }

  // Check 2: Title pattern
  if (containsForeignBrandAsOwnBrand(draft.draft_title, draft.brand)) {
    issues.push(`Title использует non-manufacturer brand IP как brand`);
  }

  // Check 3: "Gift Set" в title (soft warning)
  if (!draft.draft_title.toLowerCase().includes('gift set')) {
    issues.push(`[warning] Title не содержит "Gift Set" — рекомендуется`);
  }

  // Check 4: Browse node
  if (!isGiftBasketBrowseNode(draft.attributes?.browse_node)) {
    if (isCrossBrandComposition(draft.draft_components)) {
      issues.push(`Multi-brand bundle ВНЕ gift basket browse node — нарушение Oct 2024 policy`);
    }
  }

  // Check 5: Physical packaging указано
  if (!draft.packaging_spec?.outer_box?.includes('GIFT SET')) {
    issues.push(`[warning] Packaging spec не указывает "GIFT SET" на коробке`);
  }

  return { passed: issues.length === 0, issues };
}
```

---

## References

- **Official policy:** https://sellercentral.amazon.com/help/hub/reference/external/G200442350
- **Oct 14, 2024 announcement:** Amazon Seller Forum discussion of Product Bundling Policy update
- **Brand Registry:** https://brandservices.amazon.com/
- **Internal:** [`bundle-policy.md`](bundle-policy.md), [`browse-nodes-grocery.md`](browse-nodes-grocery.md), [`gtin-exemption-process.md`](gtin-exemption-process.md)
- **Related:** Vladimir's existing 1028 Salutem Vita gift set listings on Salutem Solutions account (proof of concept)

---

**Maintained by:** Vladimir + Claude
**Last reviewed:** 2026-05-17
