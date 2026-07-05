# Retail Data-Source Capability Matrix

**Purpose:** an OBJECTIVE map of what each paid/available data source gives us, per
online retailer, per data-type (price / 1P / photos / nutrition / ingredients / UPC).
The sourcing engine routes by this so we never fan out to paid services blindly.

Built **2026-07-05** from LIVE probes (Oxylabs) + code/docs (Unwrangle — account was
out of credits, so documented not live-probed). Code config: `src/lib/sourcing/source-capabilities.ts`.

## The matrix

| Retailer | Price | 1P? | Photo gallery | Nutrition | Ingredients | UPC | Source(s) |
|---|---|---|---|---|---|---|---|
| **Walmart** | ✅ | ✅ | ✅ (Oxy 7 / UW all) | UW only (Oxy = label-img) | UW only (Oxy = label-img) | **UW only** | Price+photos **Oxylabs**; UPC+nutrition **Unwrangle detail** (2.5cr) |
| **Amazon** | ✅ | ✅ | ✅ 8 imgs | ❌ (neither) | ✅ **text** | ✅ | **Oxylabs amazon_product** — COMPLETE, no Unwrangle |
| **Target** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | **Unwrangle** target_detail (1cr) — only structured path |
| **Sam's Club** | ✅ | ✅ | ✅ | ? | ✅ | ✅+gtin | **Unwrangle** (10cr — expensive) |
| **Costco** | ⚠️ often missing | ✅ | ✅ | ❌ | ❌ | ✅ | **Unwrangle** (10cr, price gaps) |
| **Publix** | ✅ | ✅ | main-only | ❌ | ❌ | ❌ | **OpenClaw browser ONLY** |
| **Aldi** | ✅ | ✅ | main-only | ❌ | ❌ | ❌ | **OpenClaw browser ONLY** |
| **BJ's** | ✅ | ✅ | main-only | ❌ | ❌ | ❌ | **OpenClaw browser ONLY** |
| **Google Shopping** | ✅ | ⚠️ MIX 1P+3P | ❌ | ❌ | ❌ | ❌ | **Oxylabs** — last-resort estimate, first-party merchant only |

## What each service is UNIQUELY good for

- **Oxylabs** (~$49/mo, live): structured parsers for **walmart, amazon, google_shopping** only.
  - Amazon `amazon_product` is the RICHEST source of all: 8-image gallery + bullets +
    description + **UPC** + **text ingredients** + buybox 1P/3P. → **Amazon fully covered, no Unwrangle.**
  - Walmart `walmart_search`/`walmart_product`: clean 1P price + gallery + desc, but
    **no UPC** and nutrition/ingredients only as label-image URLs.
  - `google_shopping_search`: cross-retailer price discovery, **mixes 1P + 3P resellers** →
    take the first-party merchant only.
  - NO structured parser for Target/Publix/Sam's/Costco/BJ's (universal-scrape only, unreliable).

- **Unwrangle** ($99/mo, credit-based): 50+ retailers via `platform=` param.
  - **Walmart detail** = the only structured **nutrition + ingredients + UPC** for Walmart grocery (2.5cr).
  - **Target/Sam's/Costco** = the only structured path (Sam's/Costco = 10cr each → sparingly).
  - **NO Instacart / Kroger / Albertsons** → cannot reach Publix/Aldi/BJ's.

- **OpenClaw browser** (self-hosted box, ~free compute): logged-in browser — the ONLY
  path to **Publix / Aldi / BJ's** (SPA/member/store-gated, no paid API). Main image + price.

- **Google Shopping** (via Oxylabs): universal last-resort estimate. 1P+3P mix.

- **BlueCart**: DEACTIVATED PERMANENTLY — never revive.

## Routing (cheapest-first, no waste)

**Price (COGS) — stop at first hit:**
`Walmart (Oxylabs)` → miss → `Target (Unwrangle 1cr)` → `Publix/Aldi/BJ's (browser)` →
`Sam's/Costco (Unwrangle 10cr)` → `Google first-party (last resort)`.

**Content (all info) — once per unique product:**
- Amazon product → **Oxylabs** (complete).
- Walmart product → **Oxylabs** (photos+desc) + **Unwrangle detail** only when we need UPC/structured nutrition.
- Target/Sam's/Costco → **Unwrangle detail**.
- Publix/Aldi/BJ's → **browser** (main image only).

**Cost implications:**
- Our ~1,540 Amazon SKUs: price + full content from Oxylabs (already paid) — **$0 extra**.
- Walmart: price from Oxylabs; Unwrangle detail (2.5cr) only where UPC/nutrition needed, deduped per product.
- Avoid Sam's/Costco (10cr) unless the item is club-specific.
- **Publix/Aldi/BJ's have NO paid path — browser or unsourceable.** (Answers the "no browser" question objectively: for those retailers there is no alternative.)

## Efficiency rules the engine must follow
1. Walmart-first, **stop on hit** (don't call Target/Sam's/Costco when Walmart already priced it).
2. Content detail fetched **once per unique donor product** (dedup), not per SKU.
3. Google only as last resort, **first-party merchant only**, flagged as estimate.
4. Never fan out to every service — consult `source-capabilities.ts` and escalate by tier.
5. Paid-service credits are monitored (`service-health.ts`) → loud alert before a provider runs dry.
