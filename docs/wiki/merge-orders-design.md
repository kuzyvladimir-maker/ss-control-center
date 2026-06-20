# Merge Orders — design notes

## What Vladimir wants

Veeqo has a "Mergeable" tab/filter (`?mergeable=true&pick_status=unpicked`) that surfaces awaiting-fulfillment orders sharing the same shipping address. The operator picks two+, clicks Merge, Veeqo creates one shipment for them, the operator buys one label, and Veeqo posts the same tracking number to both marketplace orders.

We want the same in our Shipping Labels module — surface mergeable pairs, let the operator merge them, then buy one label that covers both.

## Design decisions (Vladimir 2026-05-17)

- **Within-channel only.** Amazon-with-Amazon (across stores OK), Walmart-with-Walmart. No cross-channel mixing (e.g. Amazon + Walmart) — each marketplace's protections (A-to-Z, etc.) are tied to its own shipment, and crossing them complicates dispute handling.
- **Merge in Veeqo, buy through their API.** We don't try to invent our own "one label for many orders" plumbing — too many marketplace-side edge cases. Veeqo's merge produces one allocation, our existing `getShippingRates(allocationId)` + buy flow picks it up unchanged.
- **Match what Veeqo flags as mergeable.** We don't try to out-smart their address matcher.

## ⚠️ Blocker: public Veeqo API has no merge endpoint

Checked the Veeqo developer docs (https://developers.veeqo.com/docs). Their public API exposes order CRUD, allocations, shipping rates, and shipments — but no `merge orders` endpoint. The Merge button in Veeqo UI is backed by an **internal** (un-documented) API.

This means we have three viable paths, in order of risk:

### Path A — Deep-link to Veeqo (lowest risk, do this first)

1. Scan our awaiting orders, group by `normalize(name + street + city + zip + country)` within the same channel/store.
2. Surface "X mergeable pairs" badge on the Shipping Labels page.
3. New "Mergeable" filter/tab listing grouped pairs.
4. Each group shows order numbers, customer, address, products, and a single **"Open in Veeqo"** button that deep-links to Veeqo's mergeable view scoped to those order IDs.
5. Vladimir does the actual merge in Veeqo's UI → comes back to our service → the merged order now has one `allocationId` → existing buy flow works unchanged.

Pros: no Veeqo API dependency, no marketplace risk, ships in a day.
Cons: context switch to Veeqo for the actual merge click.

### Path B — Reverse-engineer Veeqo's internal merge call

1. Vladimir opens Veeqo, opens DevTools → Network, clicks Merge once. Capture the request.
2. We try to replay that request from our server using our `VEEQO_API_KEY`.
3. If their internal endpoint accepts our public API key → fully automated merge button on our side.
4. If it requires session cookies / CSRF tokens → we can't safely automate it from a backend.

Pros: full automation if it works.
Cons: undocumented = can break without warning; potential auth roadblocks.

### Path C — Our own one-label-for-many logic

Buy a single shipping label via UPS / USPS / FedEx direct, then post that tracking number to each marketplace order via SP-API / Walmart Orders API. Skip Amazon Shipping V2 entirely (it's per-order).

Pros: total control.
Cons: lose Amazon's Claims-Protected coverage on those labels; complex tracking-confirmation flow per marketplace; large surface area for new bugs.

## Recommended sequence

1. **Phase A1:** Path A above — surface mergeable groups, deep-link to Veeqo. ~2 days of work, zero marketplace risk. Ships value immediately.
2. **Phase A2:** Vladimir asks Veeqo support if their merge endpoint is exposed via API (or if they'd expose it for our account). If yes, swap the deep-link for a real merge button.
3. **Phase B:** Only if Veeqo refuses and Vladimir really needs full automation, look at Path C with a single marketplace as a pilot.

## What scanning looks like (Path A details)

Address-matching candidate signature, computed per order at plan time:

```
signature = [
  channelKind,                        // "Amazon" / "Walmart"
  storeIndex,                         // same Amazon account
  normalize(recipient_name),          // lowercase, trim
  normalize(address_line_1),          // collapse "Apt 2" / "#2" / "Unit 2"
  normalize(address_line_2),
  normalize(city),
  state,
  zip_first_5,
  country,
].join("|")
```

Two orders are a "merge candidate" iff they share `signature` AND both have status `awaiting_fulfillment` AND neither has been picked yet.

We start with strict matching (lowercase + trim only). If Veeqo's `mergeable=true` flag turns out to use looser matching that we miss, we add the normalisation rules they use. We don't try to out-fuzzy them — false positives here cost the operator more than they save.

## Where the work lives

- `src/lib/shipping/mergeable.ts` — new — signature + grouping logic
- `src/app/api/shipping/mergeable/route.ts` — new — GET endpoint returning groups
- `src/app/shipping/page.tsx` — new tab/filter, new group card UI
- `docs/wiki/merge-orders.md` — wiki note (after implementation)

## NOT in scope for Phase A1

- Auto-buying labels for merged groups (Veeqo handles after manual merge)
- Cross-channel merges
- Address fuzzy matching beyond lowercase/trim
- Merge undo (Veeqo's responsibility)

## Связано с
- [Merge Orders — Phase A1](merge-orders.md) — реализация по этому дизайну
- [Shipping Labels — Модуль](shipping-labels.md) — где появляется фильтр mergeable и покупка лейбла
