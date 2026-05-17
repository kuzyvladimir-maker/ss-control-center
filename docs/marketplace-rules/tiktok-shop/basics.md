# TikTok Shop — Basics

> **Source:** https://seller-us.tiktok.com/university
> **Last verified:** 2026-05-17
> **Priority:** P2 (Phase 2 channel, после approval)

---

## TL;DR

TikTok Shop = e-commerce platform integrated с TikTok app. Strong for impulse purchases, gift items, viral products. Vladimir's gift sets — natural fit. Approval timeline: 2-3 месяца. Stage 2 of Bundle Factory.

---

## TikTok Shop overview

### Why it matters для Vladimir

- **Audience:** 100M+ US users, heavily impulse-driven
- **Gift sets** — natural fit (visual presentation drives sales)
- **Affiliate marketing built-in** (creators promote products for commission)
- **Live shopping** — sell в real-time during livestreams
- **Vladimir's plan:** 2 TikTok Shop accounts (TIKTOK_1 + TIKTOK_2 в SalesChannel enum)

### Approval timeline

TikTok Shop requires approval (more strict than eBay):
1. Business verification (LLC docs)
2. Tax info submission (W-9 / EIN)
3. Initial product approval (vs platform rules)
4. Approval period: **2-3 months**

### Categories

TikTok Shop supports:
- Food & Beverage (Vladimir's main)
- Health & Wellness
- Beauty & Skincare
- Home & Kitchen

---

## Key differences

| Aspect | Amazon | TikTok Shop |
|---|---|---|
| Discovery | Search-driven | Algorithm-driven (For You feed) |
| Title length | 200 | **34 chars (mobile-truncated)** |
| Image format | Product photos | **Short-form video** (1-15s) преферирован |
| Conversion driver | Reviews + price | Creator endorsement + viral content |
| Selling format | Standard | Standard + Live + Affiliate |
| Returns | 30 days | 14 days (default) |

### Title

- Max ~60 chars, recommended **34 chars или less**
- Front-load benefit + brand
- Emoji allowed and recommended 🎁

Example:
- Amazon: `Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12`
- TikTok: `🎁 Pizza Lunch Gift Set 12-Pack 🍕`

### Images / video

TikTok strongly prefers **video** over static images:
- 1-3 short clips showing product unbox / use case
- Static images allowed but lower conversion

Vladimir's Phase 2 strategy:
- Use Higgsfield (уже в Vladimir's toolset) to generate AI videos showing gift set
- Each MasterBundle → optionally generate 1 TikTok video (Stage 5 extension)

---

## Fees

- **Referral fee:** 5% initial (promotional), increasing to **8% standard** after intro period
- **Payment processing:** included
- **Affiliate commission:** Vladimir sets % to share with creators (typical 10-30%)

Initial fees significantly lower than Amazon — TikTok bootstrapping aggressive growth.

---

## Bundle Factory integration

`ChannelSKU.channel` уже supports `TIKTOK_1` и `TIKTOK_2`:
- `tiktok_product_id` field
- `live_url` = tiktok.com/{shop_id}/product/{product_id}

Stage 4 (Content Generation) — special TikTok-shortened title prompt.
Stage 5 (Image Generation) — optional video generation через Higgsfield.

---

## References

- https://seller-us.tiktok.com/university
- https://shop.tiktok.com/
- Internal: [`approval-process.md`](approval-process.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
