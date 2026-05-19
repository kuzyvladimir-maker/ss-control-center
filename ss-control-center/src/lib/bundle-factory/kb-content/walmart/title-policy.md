# Walmart Marketplace — Title Policy

> **Source:** https://sellercentral.walmart.com/help/grocery-listing-quality (Walmart Help Center)
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Walmart titles strict: **max 75 chars** (vs 200 на Amazon). Pattern: `Brand + Description + Variant + Size + Pack`. No emoji, no promotional language. Walmart's search algorithm focuses на keyword positions, поэтому important keywords — front-loaded.

---

## Hard rules

### 1. Length

**Max 75 chars** (включая пробелы). Это строже чем Amazon (200).

Truncation на mobile = 50 chars. Front-load critical info.

### 2. Structure

```
[Brand] [Product Type] [Variant] [Size] [Pack Size]
```

Пример adaptation:
- Amazon: `Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12` (79 chars)
- Walmart: `Salutem Vita Pizza Lunch Gift Set 12 Pack` (~42 chars)

### 3. Запрещённые элементы

Те же что Amazon, плюс:
- No `–` em-dash (Walmart prefers `-` hyphen)
- No emoji в title
- No CAPS abuse
- No promotional language

### 4. Brand первым словом

Same as Amazon. Brand = Salutem Vita.

---

## Examples

### ✅ Correct

```
Salutem Vita Pizza Lunch Gift Set 12 Pack
Salutem Vita Breakfast Gift Set Pack of 12
Salutem Vita Snack Variety Gift Set 24 Count
```

### ❌ Incorrect

```
🎁 BEST Salutem Vita Lunchables Gift Set!!! - Pack of 12 (тоже длинный, эмодзи, foreign brand)
```

---

## Bundle Factory adaptation

Stage 4 (Content Generation) генерирует Amazon-style title (200 chars), затем создаёт Walmart-shorter version для Walmart ChannelSKU:

```typescript
function adaptTitleForWalmart(amazonTitle: string): string {
  // Strip em-dashes
  let title = amazonTitle.replace(/–/g, '-');
  
  // Remove parenthetical details
  title = title.replace(/\s*\([^)]*\)\s*/g, ' ');
  
  // Truncate to 75 chars on word boundary
  if (title.length > 75) {
    title = title.slice(0, 72) + '...';
    const lastSpace = title.lastIndexOf(' ', 70);
    title = title.slice(0, lastSpace);
  }
  
  return title.trim();
}
```

Or — AI prompt с two outputs (Amazon long + Walmart short) на основе same brief.

---

## References

- https://sellercentral.walmart.com/help/grocery-listing-quality
- Internal: [`../amazon/title-policy.md`](../amazon/title-policy.md) (для сравнения)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
