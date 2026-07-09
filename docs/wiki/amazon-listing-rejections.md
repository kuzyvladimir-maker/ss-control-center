# Amazon listing rejections — diagnosing SP-API publish failures

**Added 2026-07-09** after four Bundle Factory listings sat at `listing_status=FAILED`
with no recorded reason.

## The problem

`runDistribution` stores `listing_status=FAILED` but **not Amazon's reason**. The
SP-API `PUT` response carries an `issues[]` array; we don't persist it. So a failed
listing is a dead end until you ask Amazon again.

## The tool: VALIDATION_PREVIEW (non-mutating)

`PUT /listings/2021-08-01/items/{sellerId}/{sku}?mode=VALIDATION_PREVIEW` validates
the exact payload and returns `status` + `issues[]` **without writing the listing**.
Safe to run against live SKUs.

```bash
SKUS=EW-ASWP-PMZX,HU-ASMI-DN3X npx tsx scripts/_amz_preview.ts
```

> Note: `submitToAmazon({ dryRun: true })` will NOT give you this — `dryRun`
> short-circuits and returns a simulated payload before the preview call.
> Also make sure you pass the real product type (`GROCERY`, via
> `productTypeForBundle()`); a stray `"PRODUCT"` produces a misleading
> `4000004` error that has nothing to do with the real failure.

## Codes seen on this catalog

| Code | Meaning | Real cause we hit |
|------|---------|-------------------|
| `8572` | Product ID doesn't match Amazon's **brand records** | `brand` attribute said `Smucker's` while the UPC is ours. Publishing as `Uncrustables` cleared it. |
| `8566` | SKU matches no ASIN and one can't be created | Appeared together with 8572; same root cause. |
| `99300` | Bullets/description contain **promotional claims OR sale/shipping claims** | The bullet `"…each 2.8 oz, sold and shipped frozen."` |
| `90000900` (WARNING) | `recommended_browse_nodes` ignored for this product type | Harmless; Amazon drops the attribute. |

## Lesson 1 — brand must be canonicalized at the publish boundary

`resolveListingBrand()` maps `Smucker's`/`Smuckers` → `Uncrustables`, but
`buildAmazonAttributes()` used to take `MasterBundle.brand` **raw**. One stale row
leaked `Smucker's` to Amazon and the listing was rejected with 8572 — Amazon
cross-checks the UPC against the brand's records.

Fixed in `distribution/amazon-publish.ts`: the brand is now canonicalized inside
`buildAmazonAttributes`, so upstream data can never leak the wrong brand again.
Regression test in `__tests__/distribution-payloads.test.ts`.

## Lesson 2 — 99300 has TWO halves, and the classifier is inconsistent

99300 is "false/promotional claims **or external links**". We only guarded the
*promotional adjective* half (`PROMOTIONAL_BANNED`). The other half is **sale /
shipping / availability claims**.

To find the exact offending bullet, use leave-one-out preview:

```bash
SKU=HU-ASMI-DN3X npx tsx scripts/_bisect_99300.ts
```

It drops one bullet at a time and re-previews; the bullet whose removal flips the
listing to `VALID` is the culprit. For HU it was bullet[0] — specifically the
phrase **`sold and shipped frozen`**.

**The classifier is not deterministic across listings:** sibling listings with
`"Ships frozen…"` were accepted. So we ban the phrasing proactively rather than
trusting Amazon to catch it every time — see `SALE_SHIPPING_CLAIM_BANNED` in
`compliance/banned-words.ts`, now scanned by Rule 8.

**Write storage instructions, not shipping claims:** `"Keep frozen"` ✅ /
`"Ships frozen"` ❌.

## Audit existing listings

```bash
npx tsx scripts/_scan_claims.ts     # read-only
```

As of 2026-07-09 this flags **9 already-LIVE listings** whose bullets/description
still contain such phrases (`Ships frozen…`, `available for a limited time`).
Amazon accepted them, but they violate PDP policy and are a latent suppression
risk. They were left untouched — editing live copy re-triggers review, so it is a
deliberate decision, not an oversight.

⚠️ Because Rule 8 now blocks these phrases, re-validating one of those 9 drafts
(the FINISH path in `scripts/_img_replace.ts`) will fail Rule 8 until its copy is
cleaned. The REPLACE path does not re-validate and is unaffected.
