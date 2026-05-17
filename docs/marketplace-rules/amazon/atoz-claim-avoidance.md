# Amazon A-to-Z Claim Avoidance (Listing-time prevention)

> **Last verified:** 2026-05-17
> **Priority:** P1 (claims рост дороже than upfront listing quality)

---

## TL;DR

A-to-Z claims = customer-initiated dispute через Amazon (заменяет seller refund). Each claim = hit к Order Defect Rate (ODR). 90% claims **могут быть предотвращены** правильным listing setup — clear expectations, accurate shipping promises, transparent component disclosure. Bundle Factory должна embed best practices в каждый ChannelSKU.

---

## 🎯 5 главных причин A-to-Z claims (food/grocery)

| Причина | % of total | Listing-time mitigation |
|---|---|---|
| **Item not received** | 35% | Accurate shipping promise + tracking |
| **Item different from description** | 25% | Detailed component list в bullets/description |
| **Item damaged/melted** | 20% | Clear shipping/storage instructions |
| **Item arrived late** | 12% | Realistic handling time |
| **Quality issues (expired/poor)** | 8% | Expiration disclosure |

---

## ✅ Listing-time prevention checklist

### 1. Accurate shipping promise (item not received)

`shipping_options` в SP-API listings:
```json
{
  "fulfillment_availability": [
    {
      "fulfillment_channel_code": "DEFAULT", // FBM
      "quantity": 100,
      "lead_time_to_ship_max_days": 2  // Vladimir's JIT = 2 days max
    }
  ]
}
```

**Critical:** `lead_time_to_ship_max_days: 2` — это promise. Если Veeqo не успеет за 2 дня → late ship rate (LSR) hit + A-to-Z risk. Bundle Factory должна automatically set 3 days для frozen (Mon-Wed ship restriction) и 2 days для shelf-stable.

### 2. Detailed component list (item different)

В bullets (предотвращает "не то что ожидал"):
> "📦 Bundle contains exactly:
>  - 6 × Jimmy Dean Sausage Egg Cheese Croissants (4.9 oz each)
>  - 6 × Eggland's Three Cheese Omelets (4.3 oz each)
>  - Total: 12 frozen breakfast items in branded gift box"

В description — full transparency. Если bundle contains specific brand component, **clearly state it** в description.

### 3. Shipping/storage instructions (damaged/melted)

В bullets and description (для frozen/chocolate):
> "🚚 Ships Monday-Wednesday only with insulated packaging and gel ice packs. Please refrigerate or freeze immediately upon arrival. Do not leave on porch for extended period in warm weather."

Это устанавливает **buyer responsibility**. Если buyer leaves package в hot porch и item melts — Amazon видит disclosure и более likely deny claim.

### 4. Realistic handling time

Vladimir's JIT model: 2 days handling (order → source → pack → ship). Account for:
- Weekend orders → Monday handling start
- Frozen orders → handling pause until Mon-Wed ship window
- Out-of-stock components → potential delay

В listings:
```
lead_time_to_ship_max_days: {
  "shelf-stable": 2,
  "frozen": 3,  // accounts для Mon-Wed restriction
  "refrigerated": 3
}
```

### 5. Expiration disclosure

В description:
> "🗓 Best by: minimum 3 months from receipt for frozen items, minimum 2 weeks for refrigerated."

Bundle Factory aggregates expiration из components (MIN logic) — see [`compliance-grocery.md`](compliance-grocery.md).

---

## 🛡️ Buy Shipping Protection — A-to-Z safety net

Если Vladimir uses **Buy Shipping через Amazon** (или Amazon-integrated carriers like UPS/USPS через Veeqo) — automatic A-to-Z protection:

- Если tracking shows delivered → claim auto-denied
- Если tracking shows lost → Amazon eats refund (не Vladimir)

Bundle Factory + Veeqo integration:
- Always purchase shipping label через Veeqo с Amazon-Buy Shipping protection enabled
- Sync tracking back to Amazon order within 24h

См. [`shipping-labels.md`](../../wiki/shipping-labels.md) для Veeqo integration.

---

## 📋 Bullets template (anti-claim version)

```
🎁 [Hero benefit / use case]
   – [What's in the box: exact components]

📦 [Specific components list — что и сколько]
   – [Brand mentions allowed в bullets, не title]

🚚 [Shipping promise + buyer responsibility]
   – Ships Mon-Wed in insulated packaging with gel ice packs
   – Refrigerate immediately upon arrival

🗓 [Quality / freshness disclosure]
   – Best within X months frozen, X weeks refrigerated
   – Items are freshly sourced and packed within 2 business days

🛡️ [Final gift context + allergen warning]
   – Contains: milk, wheat, soy. Check individual product labels for specific allergen info.
   – Makes a delightful gift set for {audience}
```

---

## 🔧 Bundle Factory Stage 4 enforcement

AI prompt instructions:
1. Always include "shipping promise" bullet (#3)
2. Always include "expiration disclosure" bullet (#4 or в description)
3. Always include "allergen warning" в final bullet (#5)
4. Component list — exact quantities, exact brands в bullets (не title)
5. Никаких overpromises ("guaranteed fresh") — use "minimum X months" instead

Stage 6 validator check:
```typescript
function validateAntiClaimPatterns(bundle: BundleDraft): ComplianceResult {
  const issues: string[] = [];

  const allBulletText = bundle.draft_bullets.join(' ').toLowerCase();
  
  // Check shipping disclosure
  const shippingKeywords = ['ships', 'shipping', 'delivery', 'transit'];
  if (!shippingKeywords.some(kw => allBulletText.includes(kw))) {
    issues.push('[warning] Нет shipping/transit disclosure в bullets');
  }

  // Check expiration disclosure
  const freshnessKeywords = ['fresh', 'best by', 'best within', 'expiration', 'months', 'weeks'];
  if (!freshnessKeywords.some(kw => allBulletText.includes(kw))) {
    issues.push('[warning] Нет freshness/expiration disclosure');
  }

  // Check allergen warning
  if (bundle.category === 'FROZEN_GROCERY' || bundle.category === 'REFRIGERATED') {
    const allergenKeywords = ['allergen', 'contains', 'milk', 'wheat', 'soy', 'check label'];
    if (!allergenKeywords.some(kw => allBulletText.includes(kw))) {
      issues.push('[warning] Нет allergen warning для food bundle');
    }
  }

  return { passed: issues.length === 0, issues };
}
```

---

## 🚨 What NOT to do

❌ "Guaranteed freshest" — subjective claim → if customer disputes → claim wins
❌ "Free returns within 30 days" — Vladimir's policy ≠ Amazon's; misleading
❌ "100% authentic" — implies counterfeit exists в other listings → defamatory
❌ Vague pack count ("approximately 12 items") — buyer expects exactly 12
❌ Lifestyle-only main image без showing actual gift box

---

## 📊 Tracking & optimization

Phase 2+:
- Bundle Factory должна track A-to-Z rate per ChannelSKU
- Sales Cards dashboard widget — A-to-Z trend по MasterBundle
- High-claim bundles flagged → review listing + improve template

См. [`atoz-chargeback.md`](../../wiki/atoz-chargeback.md) (Customer Hub side — handles incoming claims).

---

## References

- A-to-Z Guarantee Policy: https://sellercentral.amazon.com/help/hub/reference/external/G201868840
- Buy Shipping Protection: https://sellercentral.amazon.com/help/hub/reference/external/G201541410
- Internal: [`bullet-points-policy.md`](bullet-points-policy.md), [`compliance-grocery.md`](compliance-grocery.md), [`atoz-chargeback.md`](../../wiki/atoz-chargeback.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
