# Amazon Restricted Products

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/G200164330
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Restricted products — категории, требующие per-ASIN или per-brand approval. Vladimir's relevance: Frozen Grocery, Refrigerated, Pet Food, Health & Beauty. Каждый product check ASIN restrictions before bundle creation.

---

## Hard rules

### 1. Pre-bundle check

Перед созданием bundle:
- Check каждый component ASIN на restrictions
- Если есть ungating requirement — verify account approval
- Если component приватного brand с trademark protection — verify authorization

### 2. Категории relevant для Vladimir

| Category | Restriction level | Vladimir's status |
|---|---|---|
| Frozen Grocery | Approval required | Salutem Solutions ✓ |
| Refrigerated | Approval required | TBD verify |
| Pet Food | Approval required | Salutem Solutions ✓ (existing Freshpet listings) |
| Health & Beauty | Approval required | TBD verify |
| Baby (food) | Approval required | TBD verify |
| Cosmetics | Brand restrictions | Phase 2 |
| Supplements | Brand restrictions | Phase 2 |

### 3. Brand-protected ASINs

Некоторые brands ограничивают third-party sellers (brand gating). Vladimir's strategy через **gift basket exception** обходит это — bundle = new ASIN, не reselling existing brand ASIN.

Но компоненты внутри bundle должны быть legally obtained (proof of purchase = receipt из Walmart/Target/etc).

### 4. ASIN-level restrictions

Некоторые ASINs полностью closed для third-party sellers:
- Apple electronics
- Beats headphones
- Sony PlayStation
- Nike apparel (некоторые)

Vladimir's grocery scope obvious в этом не пересекается, но bundles могут включать **branded gift cards** — это особый case (gift cards restricted).

---

## Bundle Factory validation

Stage 6 проверяет:

```typescript
async function validateComponentRestrictions(components: BundleComponent[]): Promise<ComplianceResult> {
  for (const comp of components) {
    // Check via SP-API listings restrictions endpoint
    const restrictions = await spApi.listings.getListingsRestrictions({
      asin: comp.source_asin,
      sellerId: vladimir.merchantId,
      conditionType: 'new_new'
    });

    if (restrictions.restrictions.length > 0) {
      return {
        passed: false,
        issues: [`Component ${comp.product_name}: ${restrictions.restrictions.map(r => r.message).join(', ')}`]
      };
    }
  }
  return { passed: true, issues: [] };
}
```

---

## References

- https://sellercentral.amazon.com/help/hub/reference/external/G200164330
- SP-API Listings Restrictions: https://developer-docs.amazon.com/sp-api/docs/listings-restrictions-api-v2021-08-01-reference
- Internal: [`gift-set-policy.md`](gift-set-policy.md), [`category-frozen-grocery.md`](category-frozen-grocery.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
