# Amazon Fee Schedule (Grocery + Bundle context)

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/G201074400
> **Last verified:** 2026-05-17
> **Priority:** P1

---

## TL;DR

Amazon fees per sale = Referral Fee (% от sale price) + Variable Closing Fee (для some categories) + FBA fees (если FBA, не Vladimir's case). Для Grocery bundle: **referral fee = 8% если sale price ≤ $15, 15% если > $15**.

---

## Fee structure (FBM scenarios — Vladimir's model)

### 1. Referral Fee (per category)

| Category | Referral Fee | Min Fee |
|---|---|---|
| **Grocery & Gourmet Food** | 8% если ≤$15, 15% если >$15 | $0.30 |
| Pet Food & Supplies | 15% | $0.30 |
| Health & Personal Care | 15% (≤$10), 8% (>$10) ❄️ | $0.30 |
| Beauty | 15% (≤$10), 8% (>$10) ❄️ | $0.30 |
| Baby Products (food) | 8% если ≤$10, 15% если >$10 | $0.30 |

❄️ = inverted scale (cheaper items get higher % cut to protect Amazon minimum fee).

### 2. Variable Closing Fee

Не применяется для Grocery / Pet Food / Beauty.

Применяется только для:
- Media (Books, DVD): $1.80
- Видеоигры: $1.80

Vladimir's scope = no variable closing fee.

### 3. Refund Administration Fee

Если refund issued (return): minimum of $5.00 или 20% от refund amount.

---

## Per-bundle profitability example

**Sample bundle:** Lunchables Pizza Gift Set, Pack of 12, $61.51 sale price

**Costs:**

| Item | Amount |
|---|---|
| Sale price | $61.51 |
| Referral fee (15% if >$15) | -$9.23 |
| Components cost (12 × Lunchables ~$1.50) | -$18.00 |
| Packaging (cooler + box + labels) | -$5.00 |
| Shipping label (FBM, frozen, ~12 oz/pack × 12 = 9 lbs, FedEx 2-day ground) | -$15.00 |
| Sourcing overhead (Walmart+ included, time cost) | -$2.00 |
| **Total costs** | **-$49.23** |
| **Gross margin** | **$12.28 (20%)** |

Это до Amazon ads, returns, etc. Margin tight but достаточен — main goal scaling volume.

### 4. Subscribe & Save (S&S)

S&S customers получают 5-15% discount, который Amazon шарит:
- 5% discount: Amazon eats it
- 10% discount: split (Amazon 5%, seller 5%)
- 15% discount: split (Amazon 5%, seller 10%)

Vladimir's gift sets — probably **not S&S eligible** (одноразовые покупки). Но если есть recurring buyer pattern — рассмотреть.

---

## Specific Vladimir scenario costs

Среднее bundle Vladimir-а:
- Sale: $45-$75 (most frequent range from existing listings)
- Referral: 15% × $60 ≈ $9
- Components: $15-$25
- Packaging: $4-$5 (frozen)
- Shipping: $12-$18 (frozen, 5-10 lbs)
- **Gross margin:** $13-$28 (20-40%)

Bundle Factory cost calculator должен использовать these defaults в Brief stage для приоритизации высокомаржинальных bundles.

---

## Storage fees (если FBA used)

Не Vladimir's case в MVP (он FBM). Но reference для Phase 3:

- Standard storage fee (Jan-Sep): $0.87/cubic foot/month
- Standard storage fee (Oct-Dec): $2.40/cubic foot/month (peak)
- Frozen fulfillment fees: significant premium

Phase 3 — calculate FBA viability per bundle type.

---

## References

- https://sellercentral.amazon.com/help/hub/reference/external/G201074400
- Fee calculator: https://sellercentral.amazon.com/hz/fba/profitabilitycalculator
- Internal: [`category-frozen-grocery.md`](category-frozen-grocery.md), [`BUNDLE_FACTORY_CONCEPT_v1_0.md`](../../BUNDLE_FACTORY_CONCEPT_v1_0.md) (cost calculator section)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
