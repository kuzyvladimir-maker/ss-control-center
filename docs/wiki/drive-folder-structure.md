# Drive folder structure for shipping labels

## Layout

```
Shipping Labels /
  ├── 05 May /
  │   └── 18 /
  │       ├── Amazon /
  │       │   ├── (EDD May 21 | DL May 26) STARFIT … -- 1.pdf
  │       │   └── Printed /            ← empty on creation; warehouse moves printed PDFs here
  │       └── Walmart /
  │           ├── …pdf
  │           └── Printed /
```

## Channel bucketing

The leaf folder name uses the **marketplace bucket** (`Amazon`, `Walmart`, `eBay`, `TikTok`, …), not the per-store Veeqo channel name (`Retailer`, `Salutem`, `AMZ Commerce`). All Amazon stores collapse into one `Amazon` folder.

Normalisation lives in [`src/lib/shipping-label-files.ts`](../../ss-control-center/src/lib/shipping-label-files.ts) → `normalizeChannelKind()`, fed by Veeqo's `channel.type_code`.

## `channelKind` column

`ShippingPlanItem.channelKind` (nullable) stores the normalised bucket. Written by `plan/route.ts`, read by `buildFolderPath` in [`src/lib/shipping-label-files.ts`](../../ss-control-center/src/lib/shipping-label-files.ts). Legacy rows (NULL) fall back to the raw `channel` field, preserving the old per-store folder names for already-bought labels.

Turso migration: [`scripts/turso-migrate-channel-kind.mjs`](../../ss-control-center/scripts/turso-migrate-channel-kind.mjs).

## Printed subfolder

`uploadLabelPdf` ensures a `Printed/` subfolder exists in the channel folder after each upload, via `getOrCreateFolder` (idempotent — never overwrites or empties an existing `Printed/`).

The warehouse manually moves PDFs into `Printed/` after they come off the label printer. No automated move yet — see `feedback_drive_folder` if/when we add it.
