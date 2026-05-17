# Amazon Description Policy

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/G1881
> **Last verified:** 2026-05-17
> **Priority:** P1

---

## TL;DR

Description = full product description (HTML supported для Brand Registry; plain text для others). Limit 2000 chars (recommended), 5500 chars max. Используется в A+ Content additional если Brand Registry.

---

## Hard rules

### 1. Length

- Recommended: ≤2000 chars
- Max: 5500 chars (truncated после)

### 2. HTML support

Без Brand Registry — only plain text. С Brand Registry — basic HTML allowed:
- `<p>`, `<br>`, `<ul>`, `<li>`, `<b>`, `<i>`
- НЕ allowed: `<script>`, `<iframe>`, inline CSS, external links

### 3. Запрещённое содержимое

Те же restrictions что bullets:
- No promotional language
- No URLs / phone numbers
- No prices / discounts
- No subjective superlatives
- No anti-competitor mentions

---

## Soft rules

### 1. Структура (Vladimir's recommended pattern)

```html
<p>Introduction paragraph — что это и для кого (2-3 sentences)</p>

<p><b>What's in the bundle:</b></p>
<ul>
  <li>Component 1 — qty, weight</li>
  <li>Component 2 — qty, weight</li>
  <li>...</li>
</ul>

<p><b>Perfect for:</b></p>
<ul>
  <li>Birthdays, holidays, surprise gifts</li>
  <li>Office snacking</li>
  <li>School lunch boxes</li>
</ul>

<p><b>Storage & handling:</b> Shipped frozen with insulated packaging and gel ice packs. Refrigerate or freeze upon arrival.</p>
```

### 2. A+ Content (для Brand Registry)

Если есть Brand Registry — можно создать A+ Content modules:
- Banner image (top)
- Product comparison chart
- Lifestyle imagery
- Brand story module

Vladimir's Salutem Vita = registered → eligible для A+ Content. Это значительно boost-ает conversion.

---

## Examples

### ✅ Correct

```html
<p>The Salutem Vita Breakfast Sandwich Gift Set delivers 12 satisfying frozen breakfast sandwiches in our signature presentation packaging — perfect for surprise gifts, holiday gatherings, or stocking up the freezer for busy mornings.</p>

<p><b>What's in this Pack of 12:</b></p>
<ul>
  <li>Jimmy Dean Sausage, Egg & Cheese Croissant — 4 sandwiches (4.9 oz each)</li>
  <li>Jimmy Dean Bacon, Egg & Cheese Biscuit — 4 sandwiches (4.4 oz each)</li>
  <li>Eggland's Three Cheese Omelet — 4 omelets (4.3 oz each)</li>
</ul>

<p><b>Why it makes a great gift:</b></p>
<ul>
  <li>Comes in a branded gift box with "GIFT SET 12 COUNT" presentation</li>
  <li>Individually wrapped components for easy storage</li>
  <li>Microwave-ready — under 2 minutes per sandwich</li>
</ul>

<p><b>Storage:</b> Shipped frozen with insulated packaging. Refrigerate or freeze immediately upon arrival. Best within 3 months of receipt.</p>
```

---

## References

- https://sellercentral.amazon.com/help/hub/reference/external/G1881
- Internal: [`title-policy.md`](title-policy.md), [`bullet-points-policy.md`](bullet-points-policy.md), [`brand-registry-benefits.md`](brand-registry-benefits.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
