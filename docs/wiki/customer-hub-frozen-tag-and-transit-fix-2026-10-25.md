# Customer Hub — Frozen tag lookup + fault/unverified-transit scrub (2026-10-25, topic 42)

Owner TZ (via Jackie, topic 42): the hub reported "у товара нет тега Frozen/Dry"
for an order whose product **does** carry the Frozen tag in Veeqo (Brenda, order
`114-2471869-1927461`; product "Salutem Vita – Premium Pork Sage Breakfast
Sausage Roll", Veeqo variant 398311377, SKU 742259725036, ASIN B0F4RKQCYX). Also:
the draft generator wrote "we understand something went wrong" (a soft fault
admission) and "посылка в пути" / an ETA with no verified carrier tracking.

## 1. Why M7 never found the tag

`case-data.ts` M7 read `li.sellable.product.tags` straight off the
`/orders?query=…` list payload. **Veeqo never populates product tags on the
orders-list response** — tags live on the product, returned only by
`/products/:id`. So the tag set was always empty → `productType = null` →
"у товара нет тега Frozen/Dry", regardless of what was set in Veeqo. The match
was also exact-cased (`tags.has("Frozen")`), so a lowercase `frozen` or a
`chilled`/`refrigerated` tag would have missed even if present.

The shipping card already does it right (`src/app/api/shipping/plan/route.ts`
→ `getProduct(productId)` → `product.tags`, matched with `parseTempClass`). The
product **id** *is* on the orders-list (`sellable.product.id`); only the tags
need the extra `/products/:id` GET.

## 2. The fix (M7, `case-data.ts`)

Resolve product id(s) + SKU(s) from the order lines, then classify with the same
precedence as the shipping card (`temp-class/resolve-class.ts`):

1. owner's manual `SkuTemperatureClass` (per SKU),
2. legacy `ProductTypeOverride` (per product id),
3. Veeqo product tag via `getProduct(id)`, matched with `parseTempClass`
   (case-insensitive; `frozen`/`chilled`/`refrigerated` → cold chain).

Strictest class across all lines wins (one frozen line ⇒ order is Frozen).
`FROZEN`/`CHILLED` → `"Frozen"`, `DRY` → `"Dry"`. **No guessing**: if no signal
exists anywhere, `productType` stays `null` and M7 is still flagged as a gap
(CLAUDE.md: classify only from Veeqo tags, never guess). The source-attempt note
now says whether tags were found and which ones, so the card shows the real
reason instead of a blanket "no tag".

## 3. Fault admission + unverified transit (generator level)

Owner tightened the 2026-10-20 rule: the buyer text must never **concede**
"something went wrong" either (it still admits a problem). And it must never say
the package is "in transit" / quote a carrier ETA unless carrier tracking shows a
**real acceptance scan** — the enricher sets `trackingStatus = "in_transit"` from
a Veeqo allocation status of `"shipped"` or the mere existence of a tracking
number (`message-enricher.ts:349`), neither of which proves the carrier took it.

Enforced at three layers so it never depends on the model obeying the prompt:

- **Prompt + fix-prompt** (`message-analyzer.ts`): removed the "we understand
  something went wrong" allowance; added the UNVERIFIED-TRACKING rule; the
  NOT-HANDED-OVER reply keeps the owner-approved resend ("~2 business days") but
  no longer concedes fault or claims the original package is in transit.
- **Hard scrubber** `scrubBuyerReply(text, trackingVerified)` runs on every buyer
  reply (AI first pass, auto-fix output, and the deterministic safe templates):
  drops the "something went wrong" clause; when tracking is unverified, strips
  "(currently) scheduled for delivery on <date>" and rewrites "is … in transit
  (with X)" → "has been shipped (with X)". `trackingVerified =
  hasVerifiedCarrierScan(trackingEvents)` (a real carrier scan, not label-only).
- **Autopilot gate** (`autosend-policy.ts`): `FAULT_CONCESSION_RE` flags
  "something went wrong" so an autopilot draft carrying it is never sent.

## Tests

- `src/lib/customer-hub/__tests__/scrub-buyer-reply.test.ts` — concession removal,
  unverified vs verified transit, label-only vs real scan, idempotency.
- `__tests__/autopilot.test.ts` updated: "something went wrong" is now a
  violation (was explicitly allowed under the old 2026-10-20 rule).

## Still owner/prod side

Rebuilding Brenda's card (v2) and confirming Diana's type
(`111-7501764-0683435`, B0FH2NVYFW) runs the live pipeline (`cs_case_process`
`force_card`) against production Veeqo — the local `VEEQO_API_KEY` is rotated
(401), so it can only be exercised after deploy.
