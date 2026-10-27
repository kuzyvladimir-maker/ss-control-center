# Discard label from search / Archive — guarded cancel (2026-10-27)

**Owner's request.** Vladimir searches an order on `/shipping` (smart search,
"Archive · every status" block) precisely to cancel the label he already
bought. Cards there were read-only. The task asked for a "Discard label"
button on them.

## No second implementation

The queue already had a Discard Label button and the server route
`/api/shipping/discard-label` ([earlier fix](discard-label-and-toasts.md)).
The archive uses the same route, which was extended:

| Field in body | Meaning |
|---|---|
| `trackingNumber` | Cancel exactly this label. Without it the route works as before: the order's Walmart label(s), else the latest Veeqo shipment. |
| `orderNumber` | Archive rows may have no Veeqo id. The route finds the order in Veeqo by its number. |
| `dryRun` | Run every check, cancel nothing. The dialog calls this when it opens. |
| `source` | `queue` or `archive`, written to the log. |

## How a cancel goes through each channel

- **Amazon and anything else bought through Veeqo.** `DELETE /shipments/{id}`
  ([refund.ts](../../ss-control-center/src/lib/veeqo/refund.ts), verified live
  2026-06-09). Veeqo removes the shipment, puts the order back to
  `awaiting_fulfillment` and requests the carrier refund. The refund comes only
  for an unused label, usually in 24–72 h. The order reappears in the queue.
- **Walmart (Ship with Walmart).**
  `DELETE /v3/shipping/labels/carriers/{carrier}/trackings/{tracking}`.
  Success is `{"data":"true"}`. The transport's automatic retry is now off for
  this call (`noRetry`).
- **NAN Health (Shopify).** Shopify's Admin API has **no** label void or refund
  mutation. This was checked by introspecting the 2026-10 schema: the only
  label mutation is `shippingLabelPurchase`, and `ShippingLabel` only exposes a
  `cancellable` flag. NAN cards therefore get "Void label in Shopify ↗", which
  opens the order in Shopify admin. NAN labels bought in Shopify never appear
  as Veeqo shipments (order #1378 is shipped in Veeqo with no tracking), so the
  server answers `action: "shopify"` for them too.

## Guard rails ([label-discard.ts](../../ss-control-center/src/lib/shipping/label-discard.ts))

1. **Carrier pre-check.** UPS / USPS / FedEx tracking goes through the shared
   lookup [carriers/track.ts](../../ss-control-center/src/lib/carriers/track.ts),
   also used by Jackie's `carrier_track`. The cancel is refused, with the reason
   shown, when the package is:
   - delivered;
   - scanned: any event beyond "label created", meaning FedEx `OC`, UPS `M` or
     USPS pre-shipment;
   - already cancelled at the carrier.

   A used label isn't refunded, and in Veeqo the cancel would still put a
   shipped order back into the queue. If the lookup fails, the dialog shows a
   warning only.
2. **Other refusals:**
   - a Veeqo shipment that isn't a label Veeqo sold. A sold label carries
     `label_url` and `outbound_label_charges`, as seen on Freshpet
     113-0990536-6033819. NAN #1378 had a synced shipment with no tracking,
     which the first dry run would have "cancelled";
   - a shipment without a tracking number;
   - any NAN order, which always goes through Shopify;
   - a merged-shipment label, because it covers several orders;
   - a label that is already discarded. A label older than 14 days only gets a
   warning that the refund may not come. Neither Veeqo nor Walmart documents
   the window, so it is not a hard block.
3. **One call per label.** A lock row (Setting `label_discard:<TRACKING>`) is
   written before the call. A `failed` attempt may be replaced deliberately; a
   `sending`, `done` or `unknown` one blocks. The dialog also guards against a
   double click.
4. **An unclear answer is never re-sent.** A network error, 5xx, 408 or 429 is
   settled by reading the Veeqo order back: shipment gone → `done`, still there
   → `unknown`. `GET ?tracking=` re-checks later: gone → `done`; still there
   after 30 s → `failed`, so a deliberate new attempt becomes possible. Walmart
   unclear → "check Seller Center".
5. **After success:**
   - the plan row (`ShippingPlanItem` with that tracking, status `bought`)
     becomes `discarded` and gets a note;
   - a Walmart record gets `discardedAt`;
   - the lock row stays as the log: order, tracking, carrier, via, source,
     times, and the answer as plain text.

Search results carry each label's discard state, so the card shows
"Discarded · refund requested" or "Discard: re-check" instead of the button.

## Testing

- Unit tests: `src/lib/shipping/__tests__/label-discard.test.ts` cover scan
  classification, error text without HTML, and which answers count as a
  definite refusal.
- Live: **dry run only**. No real cancel without Vladimir's direct command on a
  specific order.

## Not verified yet

- A real Veeqo cancel of a label bought days earlier on an Amazon order that
  is already shipped. The 2026-06-09 live check was right after purchase.
- The exact refund windows of Amazon Buy Shipping and Walmart. No official
  source was found.

## Related

- [Discard Label fix + toasts](discard-label-and-toasts.md)
- [Shipping Labels — module](shipping-labels.md)
- [NAN Health rates and purchase](shipping-nan-health-rate-snapshots.md)
