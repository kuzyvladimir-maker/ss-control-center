# Merge Orders — Phase A1 (deep-link to Veeqo)

## What it does

On the Shipping Labels page, when two or more awaiting-fulfillment orders share a normalised delivery signature (same channel + store + recipient + address), a warn-tint banner appears at the top:

> ⚠ **3 mergeable groups** (6 orders) — same address across multiple orders, combine in Veeqo to buy one label   [**Open Veeqo Mergeable ↗**]

Clicking the banner expands a list showing every group's recipient, address, store, and order numbers. Clicking **Open Veeqo Mergeable** deep-links to Veeqo's own Mergeable view (`?status=awaiting_fulfillment&mergeable=true&pick_status=unpicked`). The operator does the actual merge click in Veeqo, then comes back — the merged order has one `allocationId`, our existing buy flow handles it unchanged.

## Why deep-link, not automated

Veeqo's public API has no merge endpoint. Their Merge button is backed by an internal (un-documented) API. Reverse-engineering it is fragile, and the safe play is to surface the candidates and let Veeqo's UI handle the actual merge. Design rationale lives in [`merge-orders-design.md`](merge-orders-design.md).

## Match rules

We only flag a pair when **all** of these match (case-insensitive, whitespace-collapsed, light punctuation strip):

- Channel type (`Amazon` with `Amazon`, `Walmart` with `Walmart`)
- Store name (Salutem Solutions + Salutem Solutions, not Salutem + AMZ Commerce)
- Recipient full name
- Address line 1 (with `#`, `.`, `,` stripped — so `Apt #2` matches `Apt 2`)
- City
- State
- Zip (first 5 digits — `91387-1234` matches `91387`)

We intentionally do NOT do fuzzy abbreviation matching (`St` vs `Street`) — Vladimir's rule was "match what Veeqo shows". If Veeqo's list has pairs ours misses, tighten this list (`src/lib/shipping/mergeable.ts` → `normaliseLine`).

## Where the code lives

- [`src/lib/shipping/mergeable.ts`](../../ss-control-center/src/lib/shipping/mergeable.ts) — signature + grouping
- [`src/app/api/shipping/mergeable/route.ts`](../../ss-control-center/src/app/api/shipping/mergeable/route.ts) — GET endpoint
- [`src/app/shipping/page.tsx`](../../ss-control-center/src/app/shipping/page.tsx) — `MergeableBanner` component + `loadMergeable()` fetch

## Phase A2 (future)

If Vladimir asks Veeqo support and they expose a merge API endpoint (or hands one we can replay from our backend), swap the deep-link in [`mergeable.ts → veeqoMergeableUrl()`](../../ss-control-center/src/lib/shipping/mergeable.ts) for a real "Merge" button that POSTs to Veeqo and refreshes the page. The grouping logic stays exactly the same.
