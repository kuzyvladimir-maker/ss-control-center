# Veeqo line item title: the name lives in TWO fields

**Date:** 2026-09-15
**Files:**
- `src/lib/veeqo/item-title.ts` — `buildVeeqoItemTitle` (new)
- `src/lib/veeqo/__tests__/item-title.test.ts` — cases
- `src/app/api/shipping/dashboard/route.ts` — `productTitle` of every order line
- `src/app/api/shipping/search/route.ts` — `title` of every archive-hit line
- `src/app/api/shipping/plan/route.ts` — the joined `product` string of a plan row

## The bug

Store **NAN health**, orders `#1307`–`#1309`. Veeqo's own order list and the
Command Center's Shipping Labels page showed different names for the same line:

| | Veeqo | Command Center (before) |
|---|---|---|
| #1308 | Omega 3 Krill Oil Dietary Supplement Softgels **2-Pack Bundle** | Omega 3 Krill Oil Dietary Supplement Softgels |
| #1308 | Liposomal Vitamin C Dietary Supplement Capsules **2-Pack Bundle** | Liposomal Vitamin C Dietary Supplement Capsules |
| #1309 | Omega 3 Krill Oil Dietary Supplement Softgels **60 Softgels Bottle** | Omega 3 Krill Oil Dietary Supplement Softgels |

The half we dropped is the operationally important half: it says **how many
units go in the box**. A picker reading our page packs one bottle where the
customer bought two.

## Root cause

Veeqo splits a line item's name across two fields on `sellable`:

- `sellable.product_title` — the PRODUCT master name
  (`"Omega 3 Krill Oil Dietary Supplement Softgels"`)
- `sellable.title` — the VARIANT actually bought (`"2-Pack Bundle"`,
  `"60 Softgels Bottle"`)

Veeqo's UI renders the two joined. Every one of our shipping readers took
`product_title` alone (`product_title ?? product.title ?? sku`), so any channel
that keeps the pack size in the variant half lost it. Channels that put the
pack size in the master title — most Amazon listings — looked fine, which is
why this went unnoticed until a store modelled with real variants showed up.

## The fix

`buildVeeqoItemTitle(sellable)` composes the two halves the way Veeqo does,
and is deliberately conservative — it appends the variant ONLY when the variant
adds words that are not already in the master name:

- variant empty, or a placeholder (`Default Title`, `One Size`, …), or an echo
  of the SKU → master name unchanged;
- master already contains the variant as a run of words → unchanged;
- variant contains the whole master name (channels that put the full name in
  the variant field) → use the variant;
- otherwise → `"<master> <variant>"`.

So on channels where the master title was already complete, output is
byte-identical to before; only the lines that were losing information change.

## Not changed (deliberately)

`src/lib/veeqo/orders-procurement.ts` still builds its own title. It feeds
`parsePackSize`, which decides **how many units to buy** — the same missing
"2-Pack" means Procurement under-buys these NAN health lines. Correct, but it
moves money, so it is a separate owner-gated change rather than a side effect
of a display fix. See `procurement-live-listing-anchor.md` for how Amazon cards
dodge this via the live-listing anchor (NAN health has no such anchor).

## Verification note

The local `VEEQO_API_KEY` in `.env.local` is stale (401 on `/current_user`),
and Vercel returns the production value blank because it is marked sensitive,
so the field layout above could not be re-probed live from this workspace —
it is read off the Veeqo/Command Center screenshot pair and the existing field
model in `src/lib/frozen-analytics/pipeline.ts`. The composition is safe under
a wrong guess: if `sellable.title` turns out to be empty or duplicate, titles
render exactly as they did before.
