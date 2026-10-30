# Chilled in manual classification — every path (2026-10-30)

**Owner's request (topic 135).** The "Set product type" dialog on `/shipping`
offered only Frozen and Dry. The chilled class already existed in the
[rate engine](temp-class-rate-engine-implementation-2026-10-23.md): the
strictest class wins, chilled gets +1 day, the cap is 5 days, and chilled is
forbidden on Walmart. The owner asked for a Chilled button, and for every
manual-classification path to accept and save chilled.

## What was wrong

| Path | Problem |
|---|---|
| Set product type dialog | Only Frozen/Dry. It saved to the legacy `ProductTypeOverride`, but the card, the plan and the rate engine read the SKU's manual class (`SkuTemperatureClass`) first. After a SKU was set to Chilled from the chip, picking Dry in the dialog was **silently ignored**. Save errors weren't shown. |
| AI classification dialog | The override buttons offered only the other one of Frozen/Dry. |
| Class chip on the card | It saved the class for `items[0]` only. On a multi-SKU order the other lines kept their old class. A failed save went to the console only. On a Walmart card it could save Frozen/Chilled for the SKU. |
| `POST /api/shipping/product-type` | Rejected anything but Frozen/Dry (400). |
| `POST /api/shipping/fix-tag` (external) | Rejected anything but Frozen/Dry (400). |

There is no bulk class assignment in the code.

## Now

- **One rule for every path** ([manual-class.ts](../../ss-control-center/src/lib/shipping/temp-class/manual-class.ts)):
  - Frozen, Chilled and Dry are accepted in any letter case.
  - Junk is refused with the three valid names.
  - On a Walmart order only Dry is allowed. Frozen and Chilled are refused with
    the reason "Frozen and chilled are forbidden on Walmart — Walmart orders
    always ship Dry."
- **Every pick sets the SKU's manual class**
  ([save-manual.ts](../../ss-control-center/src/lib/shipping/temp-class/save-manual.ts),
  with an audit row). That is what the chip, the plan and the rate engine read
  first, so the pick always takes effect.
- **Frozen/Dry** keep the legacy row and the Veeqo tag mirror, as before.
- **Chilled** is saved per SKU only. It never writes a legacy "Frozen" row or a
  Veeqo tag, so nothing silently becomes Frozen. Mirroring the tag into Veeqo
  is a separate owner step (topic 135, point 3).
- **Dialogs:**
  - Set product type: Frozen / Chilled / Dry on each line, independently. Save
    errors appear on the row.
  - AI dialog: "Override to" either other class, Chilled included.
  - Walmart order: the cold buttons are disabled, with the reason shown.
- **Chip:** an order with several different SKUs opens the per-line dialog.
  Walmart shows the reason in a toast; a failed save shows a toast.
- **Card after a pick:** a manual CHILLED maps to the cold chain plus a
  "Chilled" label. The order leaves "no type", and the plan re-quotes under
  the chilled rules.

## Tests

- `src/lib/shipping/__tests__/temp-class-manual-class.test.ts` covers
  validation, the Walmart refusal, the card label and the plan class. All 115
  shipping tests pass.
- Prod: every refusal checked (Walmart, Chilled without SKU, junk type,
  fix-tag). One save went to the fake SKU `ZZ-PROBE-CHILLED-20261030` and read
  back as CHILLED/manual. No real products, orders or Veeqo tags were changed.

## Related

- [Temperature-class rate engine](temp-class-rate-engine-implementation-2026-10-23.md)
- [Frozen weather rate selection plan](frozen-weather-rate-selection-plan-2026-10-23.md)
