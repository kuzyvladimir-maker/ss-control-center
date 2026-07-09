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
| `90220` | A **required attribute is missing** | `contains_liquid_contents` + `is_heat_sensitive`. Amazon's LIVE GROCERY schema requires both; our cached `attributes/schemas/GROCERY.json` still says `"required": false`. Only bites listings that must CREATE an ASIN, which is why 161 published fine and one stale draft didn't. |
| `5665` | **Brand not approved** by Amazon | `Salutem Vita`. Its Brand Registry was revoked (tied to the blocked Starfit account) and the owner decided not to appeal — so Salutem-Vita-branded listings cannot publish at all. Not a code problem. |
| `90000900` (WARNING) | `recommended_browse_nodes` ignored for this product type | Harmless; Amazon drops the attribute. |
| `18367` (WARNING) | Amazon re-classified our `product_type` | Informational. |

> **Our cached Amazon schemas can be stale.** `90220` is the tell: Amazon's live
> requiredness moved ahead of `attributes/schemas/*.json`. Don't trust the local
> copy to decide what's required — trust `VALIDATION_PREVIEW`.

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

## Lesson 3 — required attributes: trust Amazon, not our cached schema

`contains_liquid_contents` and `is_heat_sensitive` are **required** by Amazon's
live GROCERY schema. `buildAmazonAttributes` now always emits them:

- `contains_liquid_contents` → `false` (our bundles are sandwiches/snacks)
- `is_heat_sensitive` → `isColdCategory(category)` — frozen/refrigerated goods ARE
  heat sensitive, shelf-stable ones are not. `MasterBundle.category` is threaded
  through `runDistribution → submitToAmazon → buildAmazonPayload`.

Both sit in the base attribute block, so a richer per-SKU value in
`sku.attributes` still overrides them in the merge.

---

# ✅ DO / ❌ DON'T — listing content

The rules that would have prevented every failure above. Also mirrored in the
project `CLAUDE.md` brand-voice section.

| ❌ DON'T write | ✅ DO write instead |
|---------------|--------------------|
| `Ships frozen` / `sold and shipped frozen` | `Keep frozen` / `Store in the freezer upon arrival` |
| `Ships frozen with insulated packaging and gel ice packs…` | *(nothing — shipping method is not PDP content)* |
| `available for a limited time`, `while supplies last` | *(drop the clause entirely)* |
| `free shipping`, `fast shipping`, `on sale`, `best price`, `buy now` | *(never; these are sale claims)* |
| Promo adjectives: `ultimate`, `perfect`, `premium`, `delicious`, `best`… | Factual: counts, sizes, storage, ingredients |
| Health claims: `boost`, `immune`, `detox`, `cure` | *(never — we sell food, not supplements)* |
| Emoji, `•` bullet chars, HTML in `product_description` | Plain factual text |
| Brand field `Smucker's` on an own-brand passthrough | Brand field `Uncrustables` (canonicalized automatically) |

**Nuance that trips people up:** an on-pack flavor name is a *fact*, an
availability statement is a *claim*.
`Limited-edition Berry Burst flavor` ✅ — `available for a limited time` ❌.

**And the reason we ban proactively:** Amazon's 99300 classifier is
**inconsistent**. Sibling listings carrying `Ships frozen…` were accepted while
one with `sold and shipped frozen` was rejected. Never conclude a phrase is safe
just because a listing went live with it.

## Audit existing listings

```bash
npx tsx scripts/_scan_claims.ts     # read-only, mutates nothing
```

**Status 2026-07-09: 0 of 167 SKUs carry claim phrases** — all cleaned. Each edit
was verified with `VALIDATION_PREVIEW` *before* being written, and only listings
that previewed `VALID` were re-published.

⚠️ Rule 8 now blocks these phrases, so any draft still carrying them would fail
the FINISH path (`scripts/_img_replace.ts`) at validation. The REPLACE path does
not re-validate and is unaffected.

## Known permanent blocker

`SV-AS9L-DRRH` (brand **Salutem Vita**) cannot publish: Amazon returns `5665`,
brand not approved. Its Brand Registry was revoked and the owner decided not to
appeal (protecting the working Salutem Solutions account). Its copy has been
cleaned in the DB so it is compliant if the brand situation ever changes, but no
`PUT` is attempted. See [[brand-registry-status]] context in memory.
