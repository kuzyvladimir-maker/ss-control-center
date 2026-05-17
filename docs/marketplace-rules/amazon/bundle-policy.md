# Amazon Product Bundling Policy (общая)

> **Source:** https://m.media-amazon.com/images/G/65/rainier/help./Product_Bundling_Policy.pdf
> **Update:** Effective October 14, 2024 (consumables update)
> **Last verified:** 2026-05-17
> **Applies to:** All bundle listings на Amazon, кроме virtual bundles
> **Priority:** P0
> **See also:** [`gift-set-policy.md`](gift-set-policy.md) — критическое исключение

---

## TL;DR

Bundle = multiple products sold as single ASIN/UPC. Amazon's Product Bundling Policy в 2024 году ужесточена для consumables. Для Vladimir основной use case — **gift basket exception** (см. [`gift-set-policy.md`](gift-set-policy.md)). Этот файл — общие правила, применимые ко всем bundle-листингам.

---

## Hard rules (must)

### 1. Bundle vs Multipack vs Variety Pack

| Тип | Что это | UPC | Allowed категории |
|---|---|---|---|
| **Multipack** | Несколько единиц одного product (например, 12 одинаковых) | Новый UPC (отличный от single unit) | Все, если manufacturer = bundle creator |
| **Variety Pack** | Разные variants одного brand'а (e.g. 4 flavors of Uncrustables) | Новый UPC | Все, если manufacturer-authorized |
| **Bundle** | Разные products from разных brands | Новый UPC | Только в gift basket category (после Oct 2024) |
| **Virtual Bundle** | Бренд-owner показывает в одном listing-е 2-5 существующих ASIN | НЕ требует нового UPC | Brand Registry only |

Vladimir фокусируется на **Bundle** через Gift Basket Exception.

### 2. Каждый bundle = новый unique product

Bundle получает **собственный ASIN/UPC**, отличный от любого из компонентов. Нельзя:
- Использовать UPC одного из компонентов как UPC bundle
- Listing'овать bundle через offer (offer) на ASIN отдельного компонента

### 3. Title должен включать слово "Bundle" (когда применимо)

Для bundle-листингов **рекомендуется** включить:
- Слово "Bundle" в title
- Количество items в bundle ("Pack of 12", "Bundle of 4 items")

Для gift sets — допускается "Gift Set" вместо "Bundle" (см. [`gift-set-policy.md`](gift-set-policy.md)).

Если bundle содержит мало items — рекомендуется перечислить их в title:
- ✅ `Salutem Vita – Breakfast Gift Set, 12 Count — 6 Jimmy Dean Sandwiches + 6 Egg Muffins`

### 4. Title length: max 200 chars (Amazon)

Включая пробелы и пунктуацию. Подробности — в [`title-policy.md`](title-policy.md).

### 5. Bullet points и description должны быть consistent

Описание содержимого в bullets и description должно совпадать с фактическим content of bundle. Несоответствие — это listing violation.

### 6. Все компоненты должны удовлетворять Selling Policies

Каждый product внутри bundle должен соответствовать Amazon Selling Policies. Например:
- Нет hazardous materials
- Нет restricted products (для конкретного аккаунта)
- Нет expired products
- Нет recalled products

Bundle = bundle-creator несёт ответственность за каждый компонент.

### 7. Bundle images, features, descriptions follow listing policies

Главное изображение bundle: white background, продукт занимает ≥85% кадра, нет watermarks, нет text overlays (кроме того, что физически на упаковке). См. [`image-requirements.md`](image-requirements.md).

---

## Soft rules (should)

### 1. Bundle позиционирование как value

Bundle обычно продаётся как convenience / value-add:
- "Save money buying together"
- "Convenient for school lunches"
- "Perfect gift for {audience}"

Это улучшает conversion.

### 2. Один main component определяет primary search

При создании bundle Amazon ask "Pick one ASIN as the main component". Это ASIN, который определяет search categorization. Vladimir для gift set должен указывать **главный** продукт (тот, который наиболее ценен / brand-recognizable):
- Pizza Lunchables gift set → main component = Lunchables Pizza
- Jimmy Dean Breakfast → main = Jimmy Dean Sausage Egg Cheese Biscuit

### 3. Component photos дополнительно к bundle photo

Помимо главного gift set image (с коробкой), рекомендуется secondary images показать:
- Crystal-clear close-up каждого component
- Размер сравнения (рука / линейка)
- Storage / cooking instructions

---

## Restricted categories для bundles

В этих категориях bundles **запрещены** полностью (даже single-brand):
- Video Games
- Books, Music, Video, DVD (BMVD)
- Gift Cards
- Digital products
- Used products

Это не касается Vladimir — он работает в Grocery + Pet, где bundles разрешены.

---

## Examples

### ✅ Correct — multi-component gift set

```
Title: Salutem Vita – Breakfast Sandwich Variety Gift Set, 12 Count
        – 6 Jimmy Dean Sausage + 6 Eggland's Three Cheese Omelets
Brand: Salutem Vita
Browse node: Food Assortments & Variety Gifts
UPC: 742259726114 (new, from pool)
Pack count: 12 (6+6)
Main component: Jimmy Dean Sausage Sandwich (the primary brand-recognizable item)
```

### ❌ Incorrect — попытка bundle через existing ASIN

Если Vladimir создаёт offer на ASIN B00B0049PUQ (Jimmy Dean Sausage 12 Count) — это просто **resell** существующего product как single-brand multipack. Это не bundle. Цена и условия конкурируют с другими sellers на том же ASIN.

Для bundle Vladimir должен создать **новый** ASIN с собственным UPC.

### ❌ Incorrect — bundle вне gift basket после Oct 2024

```
Title: Frozen Snack Bundle - Uncrustables + Lunchables + Eggland's
Browse node: Frozen Sandwiches (не gift basket!)
Brand: Generic
```

Multi-brand, не в gift basket → violation Oct 2024 policy → listing suppressed.

---

## Edge cases

### Edge case 1: Virtual Bundles vs Physical Bundles

Vladimir может использовать **Virtual Bundles** (Brand Registry feature) на Salutem Vita ASINs:
- Не требуется новый UPC
- Combines 2-5 существующих Salutem Vita ASINs в один display listing
- Каждый ASIN sold individually (FBM или FBA), virtual bundle = marketing artifact

**Vladimir does NOT do physical packaging для virtual bundles** — Amazon handles it logically.

Virtual bundles полезны для:
- Cross-sell ASIN already in каталог
- Тестирование bundle reception до investment в physical packaging
- Holiday gift bundles на основе existing inventory

В MVP Bundle Factory **virtual bundles не приоритет** — focus на physical bundle с уникальным ASIN/UPC.

### Edge case 2: 2-5 ASIN limit для bundles

Amazon ограничивает bundle composition до 2-5 уникальных ASINs (component products). У Vladimir большинство gift sets — это **multipack одного product** (e.g. 12 Lunchables Pizza, all the same SKU), что **не считается** bundle. Это просто multipack — без ограничения 2-5.

Но если gift set содержит, например, 6 Pizza Lunchables + 6 Eggland's omelets → это **2 distinct ASINs** в bundle → попадает в ограничение → **разрешено** (2 ≤ 5).

Если gift set содержит 7+ разных products — нарушение лимита → нужно сократить или сделать multipack.

### Edge case 3: Bundle с FBA component, который stock out

Если bundle = virtual bundle и один из компонентов has zero FBA stock — bundle listing **становится unbuyable**. Component inventory management critical.

Для physical bundles Vladimir — FBM (sourcing per order), поэтому stockout не блокирует listing напрямую, но влияет на ability to fulfill. См. JIT-модель.

---

## References

- **Official:** https://sellercentral.amazon.com/help/hub/reference/external/G200442350
- **PDF:** https://m.media-amazon.com/images/G/65/rainier/help./Product_Bundling_Policy.pdf
- **Internal:** [`gift-set-policy.md`](gift-set-policy.md), [`title-policy.md`](title-policy.md), [`image-requirements.md`](image-requirements.md)

---

**Maintained by:** Vladimir + Claude
**Last reviewed:** 2026-05-17
