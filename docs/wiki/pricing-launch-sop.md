# 🚀 Amazon Pricing & New-Listing Launch SOP

**Adopted by Vladimir 2026-07-13** (authored with agent Jackie). This is the
canonical procedure for **every new Amazon listing** (frozen/refrigerated resale
arbitrage; solo offer on our own listing). Two layers applied together:
- **Layer A** — the fundamental pricing formula that sets the TARGET price (see also
  [[uncrustables-pricing-model]] for the validated cost model).
- **Layer B** — the coupon-based launch strategy that brings a NEW listing to life.

---

## LAYER A — Fundamental pricing formula (70% net ROI)

Price frozen/refrigerated resale listings to earn **~70% net ROI after Amazon's 15%
referral fee**.

1. **COUNT** — read the Total unit count from the TITLE. This is the ONLY price
   driver; number of flavors / single vs mix does NOT matter.
2. **COOLER** (by count): 1–30 → S | 31–60 → M | 61–72 → L | 73–135 → XL
3. **LANDED = product + packaging + shipping label**
   - product = count × **$1.00** (avg per sandwich)
   - packaging = S **$7.50** | M **$10.90** | L **$14.10** | XL **$18.90** (cooler + ice + $1 box)
   - label = S **$20** | M **$32** | L **$45** | XL **$60** (real avg shipping label)
4. **PRICE**
   - **ITEM PRICE (list) = LANDED × 1.5**, rounded to nearest .99 at/below.
   - Customer pays shipping (~LANDED × 0.5) separately → total revenue ≈ **LANDED × 2.0**
     → ~70% net ROI. Mnemonic: **revenue ≈ 2× landed**.
   - **Floor = LANDED × 1.3** (never below). **Ceiling = LANDED × 1.53** (never above).
5. **Quick item-price table:** 24→$76.99 · 30→$85.99 · 45→$130.99 · 60→$153.99 · 90→$252.99 · 120→$297.99

Dry / shelf-stable: same 70%-ROI logic, but NO cooler/ice + cheap mailer → landed
much lower → price much lower for the same margin.

> The Layer A ITEM PRICE is the **PERMANENT list price** (target/ceiling). It is NOT
> a starting point you raise from. **It never moves once set.**

---

## LAYER B — New-listing launch strategy

**GOLDEN RULE:** the base list price ALWAYS equals the Layer A ITEM PRICE and NEVER
moves. All launch "cheapness" comes from a **COUPON applied DOWNWARD**, which you then
**narrow over time back to zero**. Clean price history, no suppression.

**Why (do not violate):**
- **Never list low-and-raise** — Amazon paints a "was $X" strikethrough from REAL
  price history; raising later makes the target look inflated and kills conversion.
- **Never inflate-then-drop to fake a strikethrough** — fake discounts don't exist
  (strikethrough comes from real sales history) and trigger Fair Pricing suppression
  (Buy button → "See All Buying Options").

**Rules:**
1. Set list price = Layer A ITEM PRICE. Set once, keep it.
2. **Launch coupon:** a % coupon that lowers the EFFECTIVE price toward the floor
   (LANDED × 1.3), NEVER below. Since item = landed×1.5 and floor = landed×1.3, the
   **max launch discount is always ≈13%** regardless of count. → Start ~10–13% off.
3. **Honeymoon (day 0–30):** keep the launch coupon ON. Goal = velocity + reviews,
   NOT margin. Request a review on every order (within ToS). **Zero sales in 3–5 days
   = CONTENT problem (images/title/bullets), NOT price** — you're already near floor;
   fix content, don't cut further.
4. **Margin ramp (after ~10 sales OR 2–3 weeks):** NARROW the coupon in steps
   (13% → 10% → 7% → 4% → 0), one step every 3–5 days AS LONG AS velocity holds. Roll
   back one step if sales drop. End state = full Layer A ITEM PRICE, no coupon.
5. **Never change the base list price** during any of this. ONLY the coupon moves.
6. Keep the target within **market range** (check Keepa/Amazon comps) to avoid Fair
   Pricing / Competitive Price Threshold suppression.
7. **Repricer:** min = LANDED × 1.3 (floor), max = Layer A ITEM PRICE. Never below
   floor, never above ITEM PRICE.

---

## Per-listing output (log for each ASIN)
`count | cooler | landed | ITEM PRICE (list) | launch coupon % | floor (×1.3) | ceiling (×1.53) | market reference`

## Red flags — NEVER do
- ✗ Inflate price to fake a strikethrough discount.
- ✗ List at a low base price planning to raise it.
- ✗ Let effective price (after coupon) go below LANDED × 1.3.
- ✗ Exceed LANDED × 1.53 on the base list price.
- ✗ Price above market range (suppression risk).
- ✗ Change the base list price to create "cheapness" — use a coupon.

## Связано с
- [[uncrustables-pricing-model]] — validated cost model behind Layer A
- [[pricing-module]] · [[channelmax-guide]] · [[amazon-shipping-suppression]]
