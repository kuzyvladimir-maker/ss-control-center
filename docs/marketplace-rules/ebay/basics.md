# eBay Marketplace — Basics

> **Source:** https://www.ebay.com/help/selling
> **Last verified:** 2026-05-17
> **Priority:** P2 (Phase 2 channel)

---

## TL;DR

eBay — secondary channel в Bundle Factory Phase 2 roadmap. Менее strict policy чем Amazon/Walmart, но lower traffic для grocery. Vladimir's strategy на eBay: dupe shelf-stable bundles с small modifications.

---

## Key differences vs Amazon/Walmart

| Aspect | Amazon | Walmart | eBay |
|---|---|---|---|
| Title length | 200 | 75 | 80 |
| UPC required | Yes (or exemption) | Yes (strict) | Recommended (not always required) |
| Brand verification | Brand Registry | Brand Verification | Simpler (User-level) |
| Gift basket exception | Yes | Yes (Food Gift Baskets) | N/A (no concept) |
| Auction format | No | No | Yes (alternative) |
| Best Offer | No | No | Yes |

---

## eBay specifics

### 1. Title

- **Max 80 chars** (slightly longer than Walmart)
- More flexible — buyers more keyword-driven
- Can include caps for emphasis (less strict)

### 2. Listing format

- **Buy It Now** = primary для grocery bundles (no auctions для perishables)
- **Best Offer** optional (allow buyers to negotiate)
- **Auction-style** — обычно не для grocery

### 3. UPC

- Recommended but **not always required**
- "Does Not Apply" UPC можно использовать для custom bundles
- Vladimir's UPC pool works

### 4. Categories

eBay's grocery hierarchy:
```
Home & Garden > Food & Beverages > 
  ├── Other Food & Beverages
  ├── Pantry
  ├── Snacks
  └── Gift Baskets ← Vladimir's target
```

### 5. Selling limits

eBay imposes seller limits — start small:
- New account: $500/month, 10 items
- After 90 days good performance: $2500/month, 100 items
- Eventually: unlimited (Top Rated Seller status)

Vladimir's strategy на eBay:
- Open new business account
- Start with 10 best-performing bundles from Amazon
- Scale gradually

### 6. Returns policy

eBay buyers expect returns policy. Recommended: 30-day returns, buyer pays return shipping.

### 7. Shipping

- Calculated shipping (using Veeqo для cost calc)
- Same shipping options как Walmart/Amazon FBM

---

## Fees

| Item | Fee |
|---|---|
| Insertion fee (per listing) | $0.35 (first 250 free per month) |
| Final value fee | 12.55% + $0.30 per order |
| Payment processing | Managed Payments included |
| Promoted listings | 2-12% (optional) |

vs Amazon 15%: eBay net **slightly cheaper** на per-item basis, no inventory commitment.

---

## Vladimir's eBay scope (Phase 2)

- Replicate top-20 shelf-stable Salutem Vita bundles from Amazon
- New eBay listings (own ASIN equivalents)
- Same UPC, slightly modified title (eBay 80 char optimization)
- Cross-channel Adjustments через Bundle Factory ChannelSKU

---

## Bundle Factory integration

`ChannelSKU` model уже supports `channel: EBAY`:
- `ebay_item_id` field
- `live_url` = ebay.com/itm/{id}

Stage 7 (Distribution) — eBay API integration через ebay-trading-api Node.js library или Sellbrite (already in Vladimir's toolkit).

---

## References

- https://www.ebay.com/help/selling
- eBay Trading API: https://developer.ebay.com/api-docs/sell/static/overview.html
- Internal: [`fee-schedule.md`](fee-schedule.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
