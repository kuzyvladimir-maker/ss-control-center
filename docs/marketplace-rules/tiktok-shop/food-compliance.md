# TikTok Shop — Food Compliance

> **Source:** TikTok Shop seller policies + FDA food labeling
> **Last verified:** 2026-05-17
> **Priority:** P0 для food category sellers

---

## TL;DR

TikTok Shop food compliance — combination of FDA standard rules (как Amazon/Walmart) + TikTok-specific content restrictions. **Frozen / refrigerated food limited support** — TikTok's logistics network primarily set up для shelf-stable. Vladimir's MVP TikTok scope = shelf-stable Salutem Vita bundles only.

---

## ✅ Required compliance disclosures

### 1. Allergens (FDA Big 9)

Аналогично Amazon. Required в:
- Product description (text)
- Video overlay (если food bundle prominently featured)
- Product details section

### 2. Expiration / Best By date

- Disclose "Best within X months" в description
- TikTok auto-flags products где expiration <30 days

### 3. Storage instructions

```
Storage: Refrigerate or freeze upon arrival. Best stored at 0°F or below.
```

### 4. Country of origin

`countryOfManufacture: US` для всех Vladimir's products.

### 5. Manufacturer info

`manufacturer: Salutem Solutions LLC, 1162 Kapp Dr, Clearwater, FL 33765` — required для food.

---

## ❌ Prohibited food products

| Category | Reason |
|---|---|
| Alcohol (всё) | TikTok Shop never |
| Tobacco / vape / nicotine | Prohibited |
| Cannabis / CBD / hemp | Federal + TikTok policy |
| Raw / unpasteurized dairy | FDA + TikTok |
| Untested supplements (high dose) | FDA |
| Weight loss / "miracle" products | TikTok scrutiny |
| Recalled items | Auto-removed |
| International food без US FDA approval | Prohibited |
| Pet food (Phase 2 для Vladimir) | Special category |

---

## ⚠️ Heightened-scrutiny categories

TikTok extra review для:
- **Frozen food** — Vladimir's MVP = avoid initially
- **Refrigerated food** — same logistics concerns
- **Specialty / international cuisine** — labeling compliance check
- **Health-claim foods** ("organic", "gluten-free", "vegan") — verification required
- **Baby food** — pediatric safety review

---

## 📋 Vladimir's TikTok-compatible bundles

✅ **Approved for MVP:**
- Coffee variety gift sets (shelf-stable)
- Tea sampler boxes
- Candy gift boxes (cool weather)
- Snack mix variety packs
- Pasta / pantry essentials kits

❌ **Hold for Phase 2+:**
- Frozen breakfast gift sets (Lunchables, Jimmy Dean)
- Refrigerated cheese boards
- Frozen meal bundles

---

## 🔧 Compliance check (Stage 6 для TikTok)

```typescript
function validateTikTokFoodCompliance(masterBundle: MasterBundle): ComplianceResult {
  const issues: string[] = [];

  // Storage temperature compatibility
  if (masterBundle.category === 'FROZEN_GROCERY' || masterBundle.category === 'REFRIGERATED') {
    issues.push('TikTok Shop MVP: frozen/refrigerated не supported. Skip TikTok channel.');
  }

  // Prohibited keywords (food-specific TikTok)
  const text = `${masterBundle.name} ${masterBundle.components.map(c => c.product_name).join(' ')}`.toLowerCase();
  const PROHIBITED = ['alcohol', 'wine', 'beer', 'cbd', 'hemp', 'cannabis', 'raw milk', 'unpasteurized'];
  for (const kw of PROHIBITED) {
    if (text.includes(kw)) {
      issues.push(`Prohibited keyword for TikTok: "${kw}"`);
    }
  }

  // Allergen disclosure check
  const allergens = aggregateAllergens(masterBundle.components);
  if (allergens.length > 0 && !masterBundle.lifecycle_logs.some(log => log.details?.tiktok_allergens_disclosed)) {
    issues.push('[warning] Аллергены не disclosed в video/description');
  }

  // Expiration check
  const minExpDays = Math.min(...masterBundle.components.map(c => c.expiration_days || 365));
  if (minExpDays < 60) {
    issues.push(`Expiration <60 days (${minExpDays} days) — TikTok auto-flag risk`);
  }

  // Components без compliance data
  for (const comp of masterBundle.components) {
    if (!comp.ingredients) {
      issues.push(`Component ${comp.product_name}: ingredients missing (required для food)`);
    }
    if (!comp.allergens) {
      issues.push(`Component ${comp.product_name}: allergen data missing`);
    }
  }

  return { passed: issues.filter(i => !i.startsWith('[warning]')).length === 0, issues };
}
```

---

## 📋 TikTok Shop product detail compliance fields

В TikTok Shop API payload:

```json
{
  "complianceInfo": {
    "fdaApproved": null,                       // null если не applicable (для GRAS food)
    "containsAllergens": ["Milk", "Wheat", "Soybeans"],
    "expirationDate": "2027-09-30",
    "storageRequirement": "Store in cool, dry place. Refrigerate or freeze after opening.",
    "countryOfManufacture": "US",
    "manufacturer": {
      "name": "Salutem Solutions LLC",
      "address": "1162 Kapp Dr, Clearwater, FL 33765",
      "contact": null                          // private; не expose
    },
    "ingredientList": "See individual component labels for full ingredient details.",
    "nutritionalInfo": null                    // optional unless health claim made
  }
}
```

---

## 🚨 Common TikTok food compliance violations

| Violation | Common cause | Fix |
|---|---|---|
| Missing allergen disclosure | Forgot to fill `containsAllergens` array | Aggregate из components |
| Misleading "natural" claim | Used "all-natural" без FDA documentation | Remove или substantiate |
| Health claim without backup | "Boosts immunity" в description | Remove или provide research |
| Expired product | Inventory старше than shelf life | Adjust expiration tracking |
| Recalled item still listed | Manual / automatic recall not synced | Subscribe to FDA recall feed |
| Cross-contamination claim issues | "Made в peanut-free facility" без proof | Remove specific claim |

---

## 🛡️ Vladimir's Phase 2 launch compliance checklist

Перед opening TikTok Shop:

- [ ] Verify Salutem Solutions LLC FDA food facility registration (если applicable)
- [ ] Document W-9, EIN ready
- [ ] Insurance liability coverage (general business + product liability)
- [ ] Recall response plan documented
- [ ] Customer service contact info ready (для TikTok dispute escalations)
- [ ] All shelf-stable bundles в Bundle Factory have:
  - [ ] Aggregated allergens
  - [ ] Expiration dates
  - [ ] Storage instructions
  - [ ] Manufacturer info
- [ ] Decided initial 10-20 bundles для TikTok launch

---

## References

- TikTok Seller University food category: https://seller-us.tiktok.com/university
- FDA Food Labeling Requirements: https://www.fda.gov/food/food-labeling-nutrition
- Internal: [`basics.md`](basics.md), [`content-rules.md`](content-rules.md), [`../amazon/compliance-grocery.md`](../amazon/compliance-grocery.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
