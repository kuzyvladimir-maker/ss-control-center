# Walmart Marketplace — Prohibited Items

> **Source:** https://sellercentral.walmart.com/help
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Walmart Marketplace prohibits various product types. Vladimir's relevant prohibitions: alcohol, tobacco, certain supplements, food expired/near-expired, recalled products.

---

## Prohibited categories (Vladimir's scope)

### Food-related

- **Alcohol** (beer, wine, liquor) — never sell
- **Tobacco** (cigarettes, e-cigs, vape supplies) — never sell
- **Hemp / CBD products** — restricted; не для Vladimir
- **Raw meat / unpasteurized dairy** — must be pasteurized
- **Expired food** — auto-removal по expiration tracking
- **Food не FDA-approved для US distribution** — international imports without FDA approval

### Pet-related

- **Live animals** — never sell
- **Pet medications** — restricted
- **Foods recalled by FDA / AAFCO** — auto-removal

### General

- **Counterfeit / fake brand items** — auto-removal + account warning
- **Used food** — never sell
- **Mislabeled products** — warning + removal

---

## Bundle Factory check

Stage 6 (Validation) выполняет:

```typescript
const PROHIBITED_KEYWORDS = [
  'alcohol', 'wine', 'beer', 'liquor', 'spirits',
  'tobacco', 'cigarette', 'vape', 'nicotine',
  'cbd', 'hemp', 'cannabis', 'marijuana',
  'raw milk', 'unpasteurized'
];

function validateProhibitedContent(draft: BundleDraft): ComplianceResult {
  const issues: string[] = [];
  
  for (const comp of draft.draft_components) {
    const text = `${comp.product_name} ${comp.ingredients}`.toLowerCase();
    for (const kw of PROHIBITED_KEYWORDS) {
      if (text.includes(kw)) {
        issues.push(`Component ${comp.product_name}: prohibited keyword "${kw}"`);
      }
    }
  }
  
  return { passed: issues.length === 0, issues };
}
```

---

## Expiration date enforcement

Если bundle expiration < 30 дней от current date → не публиковать на Walmart.

```typescript
function validateExpiration(bundle: MasterBundle): ComplianceResult {
  const earliestExpiration = Math.min(...bundle.components.map(c => c.expiration_days || 365));
  if (earliestExpiration < 30) {
    return { passed: false, issues: ['Bundle expiration < 30 days, не listing on Walmart'] };
  }
  return { passed: true, issues: [] };
}
```

---

## References

- https://sellercentral.walmart.com/help
- Internal: [`category-grocery.md`](category-grocery.md), [`multipack-policy.md`](multipack-policy.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
