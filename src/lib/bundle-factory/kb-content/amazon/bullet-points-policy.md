# Amazon Bullet Points Policy

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/GX5L8BF8GLMML6CX
> **Last verified:** 2026-05-17
> **Applies to:** All Amazon listings
> **Priority:** P1 (нарушение = SEO penalty, иногда suppression)

---

## TL;DR

5 bullets max в продуктовых listings. Each bullet ≤ 500 chars (recommended ≤ 250). Bullets — главное место для key product features, benefits и USPs. Не должны содержать promotional language, contact info, или URL. Vladimir pattern: эмодзи в начале каждого + финальный с "gift set for {audience}".

---

## Hard rules (must)

### 1. Max 5 bullets

Amazon позволяет до 5 bullet points в product detail page. Для Brand Registry sellers иногда до 10 (с A+ Content). **MVP target: 5 bullets**.

### 2. Length per bullet

| Категория | Max chars per bullet |
|---|---|
| Grocery / Pet | 500 |
| Beauty | 1000 |
| Most others | 500 |

**Recommended:** 200-300 chars per bullet (better readability + mobile rendering).

### 3. Запрещённые элементы в bullets

- ❌ Contact info (phone, email, address)
- ❌ URLs / website links
- ❌ Pricing / promotional offers ("save $5", "30% off")
- ❌ Shipping info ("free shipping", "delivers in 2 days")
- ❌ Time-bound claims ("Christmas Special", "Limited Time")
- ❌ Subjective superlatives без proof ("Best in market", "World's #1")
- ❌ Anti-competitor language ("Better than {competitor}")
- ❌ HTML tags
- ❌ Дублирование bullet content
- ❌ ALL CAPS phrases (кроме acronyms)

### 4. Truthful claims

Каждое claim в bullets должно быть verifiable. Например:
- ✅ "13g protein per serving" — verifiable on nutrition label
- ❌ "Best taste ever" — subjective, unverifiable
- ❌ "Doctor recommended" — без proof = false claim

### 5. Один benefit per bullet (clarity)

Каждый bullet фокусируется на **одной** key feature или benefit. Не комбинировать 5 things в один bullet — это пропадает в search ranking.

---

## Soft rules (should)

### 1. Structure паттерн (Vladimir's approach)

Каждый bullet:
- Начинается с эмодзи (визуальная якорь для scanning)
- 2-3 sentence (~50-150 chars)
- Заканчивается dash или period

Пример из листинга B0FH2NX7J9 (Salutem Vita Pizza Lunchables Gift Set):

```
🍕 Includes Lunchables Pizza with Pepperoni, a fun and easy meal option
   – Perfect for on-the-go lunches or quick snacks 🍽️

✅ Comes with a ready-to-assemble pizza kit for interactive meal prep
   – Includes pizza crust, sauce, cheese, and pepperoni for a complete meal 🍅

📦 Conveniently packaged for easy storage and transport
   – Ideal for kids' lunchboxes or family picnics 🧺

🎉 No need for cooking, just assemble and enjoy!
   – Great source of protein and calcium 💪

🛡️ Individually wrapped components for freshness and safety
   – Makes a delightful gift set for pizza lovers 🎁
```

### 2. Финальный bullet — gift context

**Стандарт Vladimir:** 5-й bullet всегда содержит фразу `Makes a delightful gift set for {audience}` или эквивалент. Это:
- Усиливает classifier signal для gift basket category
- Conversion booster для Q4 holiday season
- Customer expectation alignment

### 3. Keyword density без stuffing

Бuллеты — место для long-tail keywords. Но не keyword-stuffing:
- ✅ "Frozen breakfast sandwich gift set for school lunches and quick mornings"
- ❌ "Frozen breakfast sandwich frozen breakfast frozen sandwich gift set frozen pack frozen morning"

### 4. Эмодзи (Vladimir's signature)

Хотя Amazon не запрещает эмодзи в bullets (только в title), есть нюансы:
- ⚠️ Use sparingly — 1-2 emoji per bullet max
- ✅ Use for visual hierarchy (first emoji = bullet topic marker)
- ❌ Не использовать emoji взамен слов
- ⚠️ Some categories (Health, Medical) — emoji discouraged

Для Grocery/Pet — Vladimir's pattern с эмодзи работает.

---

## Examples

### ✅ Correct — pattern Vladimir

```
🍕 Includes Lunchables Pizza with Pepperoni, a fun and easy meal option
   – Perfect for on-the-go lunches or quick snacks 🍽️

✅ Comes with ready-to-assemble pizza kit for interactive meal prep
   – Includes pizza crust, sauce, cheese, and pepperoni 🍅

📦 Conveniently packaged for easy storage and transport
   – Ideal for kids' lunchboxes or family picnics 🧺

🎉 No need for cooking, just assemble and enjoy!
   – Great source of protein and calcium 💪

🛡️ Individually wrapped components for freshness and safety
   – Makes a delightful gift set for pizza lovers 🎁
```

Каждый bullet ≤ 200 chars, четкая структура, нет нарушений.

### ❌ Incorrect — multiple violations

```
🎁🎁🎁 BEST GIFT SET EVER!!! Save 30% TODAY ONLY!!!
   Call us at 555-1234 for bulk orders! www.example.com

★★★★★ THE #1 BREAKFAST BUNDLE
   Better than Walmart's brand. Guaranteed satisfaction!
```

Ошибки:
- ALL CAPS abuse
- Promotional language ("Save 30%", "TODAY ONLY")
- Phone number и URL
- "BEST", "#1" — subjective superlatives без proof
- Anti-competitor ("Better than Walmart's brand")
- ★ stars symbol

---

## Compliance checks для Stage 6

```typescript
function validateBullets(bullets: string[]): ComplianceResult {
  const issues: string[] = [];

  if (bullets.length > 5) issues.push(`Too many bullets: ${bullets.length} > 5`);
  if (bullets.length < 3) issues.push(`[warning] Recommend 5 bullets, only ${bullets.length}`);

  bullets.forEach((bullet, i) => {
    if (bullet.length > 500) issues.push(`Bullet ${i+1} > 500 chars`);
    if (bullet.length < 30) issues.push(`[warning] Bullet ${i+1} short (${bullet.length} chars)`);

    // Promotional language
    if (/\b(BEST|AMAZING|FREE SHIPPING|SAVE \$|\d+% OFF|LIMITED TIME|TODAY ONLY)\b/i.test(bullet))
      issues.push(`Bullet ${i+1}: promotional language`);

    // URL / phone
    if (/https?:\/\/|\bwww\./.test(bullet)) issues.push(`Bullet ${i+1}: contains URL`);
    if (/\b\d{3}[-\s]\d{3}[-\s]\d{4}\b/.test(bullet)) issues.push(`Bullet ${i+1}: contains phone`);

    // CAPS abuse (>30% caps)
    const capsRatio = (bullet.match(/[A-Z]/g) || []).length / bullet.length;
    if (capsRatio > 0.3) issues.push(`Bullet ${i+1}: too many CAPS`);

    // HTML tags
    if (/<[^>]+>/.test(bullet)) issues.push(`Bullet ${i+1}: contains HTML`);
  });

  // Final bullet gift context check (warning)
  const lastBullet = bullets[bullets.length - 1] || '';
  if (!/gift\s*set|gift\s*for|delightful/i.test(lastBullet)) {
    issues.push(`[warning] Final bullet не содержит gift context (рекомендация Vladimir's pattern)`);
  }

  return { passed: issues.filter(i => !i.startsWith('[warning]')).length === 0, issues };
}
```

---

## References

- **Official:** https://sellercentral.amazon.com/help/hub/reference/external/GX5L8BF8GLMML6CX
- **Brand Registry guidelines:** https://brandservices.amazon.com/
- **Internal:** [`title-policy.md`](title-policy.md), [`description-policy.md`](description-policy.md)

---

**Maintained by:** Vladimir + Claude
**Last reviewed:** 2026-05-17
