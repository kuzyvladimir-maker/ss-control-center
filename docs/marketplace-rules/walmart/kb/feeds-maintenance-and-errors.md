# Walmart Marketplace KB — Feeds, Item Maintenance, Item Status & Error Handling

> **Purpose:** Engineer-facing reference for updating listings via the Walmart
> Marketplace API using **partial `MP_MAINTENANCE` feeds** — feed types, feed
> lifecycle, per-item ingestion status, error codes, and rate limits.
> Distilled from Walmart developer + Marketplace Learn docs (see per-section source URLs).
>
> **Compiled:** 2026-07-01. Spec versions drift — re-verify version strings and
> numeric rate limits against live docs before relying on them.

## ⚠️ Fetch failures / gaps (read first)

- **`QARTH` is NOT a documented public term.** No Walmart developer or Marketplace
  Learn page surfaces "QARTH" as an item-status value or error code. In our codebase
  memory ("Walmart locked cards backlog") we call certain multipack cards
  "QARTH-locked" — that is our internal shorthand for Walmart's **compliance / item
  review lock** state, which the public docs express as **"In Review"**, **"Action
  Needed"**, **"Prohibited"** (Items on Hold API) or **System Problem** (unpublished
  items). Treat "QARTH" as an internal alias, not an API-returned string.
- **MP_MAINTENANCE vs MP_ITEM attribute-level diff:** the spec-versioning page
  confirms both feed types share the same spec version but does **not** enumerate
  which attributes become optional in the maintenance spec. That detail lives in the
  downloadable per-feed-type spec workbook (`MP Maintenance Spec` / diff report),
  which is an XLSX behind the portal and could not be parsed via WebFetch. Download
  it from the portal to get the authoritative required-vs-optional column list.
- **Full `error-codes` catalog is larger than fetched.** The codes below
  (`ERR_PDI_*`, `ERR_EXT_DATA_*`, `INVALID_REQUEST_*`, `REQUEST_THRESHOLD_VIOLATED`,
  etc.) are the load-bearing ones; the live page has more per-endpoint variants.
- **`SUCCESS / DATA_ERROR / SYSTEM_ERROR / TIMEOUT_ERROR`** item-level codes came
  from the Feeds overview page; the `monitor-my-item` page only exposed the coarser
  `PROCESSED / ERROR` pair. Both are documented; the coarse pair is what the
  standard item-status response returns, the granular set appears in ingestion detail.

---

## 1. Feed types — what each touches & the partial-update model

Sources:
- https://developer.walmart.com/doc/us/mp/us-mp-feeds/
- https://developer.walmart.com/doc/us/mp/us-mp-items/
- https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting

| Feed type | Purpose | Update model | Notes |
|-----------|---------|--------------|-------|
| **`MP_ITEM`** | **Full item setup** — create a new listing (seller-fulfilled) | Full spec; must supply all required attributes for the product type | Use when Walmart is not already selling the item / you are establishing the offer + content. |
| **`MP_MAINTENANCE`** | **Partial update** of an *existing* item (works for seller-fulfilled **and** WFS) | **Partial** — send only the fields you want to change against the Item Maintenance Spec; you do **not** re-supply the whole full-item payload | The primary lever for our listing-content edits (titles, bullets, descriptions, images, attributes). |
| **`MP_WFS_ITEM`** | Create **new** WFS items | Full spec (WFS variant) | New WFS setup only; ongoing edits go through `MP_MAINTENANCE`. |
| **`OMNI_WFS`** | Omni / WFS setup variant | Full spec | Referenced as a supported feed type in current spec version. |
| **`price` / `MP_ITEM_PRICE_UPDATE`** | Price-only update | Partial (price fields) | Cheaper/faster than a maintenance feed for price. |
| **`PRICE_AND_PROMOTION` / `PROMO_PRICE`** | Price + promotional/comparison price | Partial | Shares an hourly limit with the other pricing feeds (see §5). |
| **`inventory`** | Inventory/quantity-only update | Partial | Per-node quantity; separate limit. |
| **`LAGTIME`** | Fulfillment lag time | Partial | |
| **`CPT_SELLER_ELIGIBILITY`** | Program eligibility | — | |

**Partial-update model (key mental model):**
> "Bulk updates using the **Item Maintenance Spec** allow you to make very specific
> updates **without providing as much information as required in the Full Item Spec**."

So `MP_MAINTENANCE` = surgical field patch keyed on the item's product ID / SKU.
Only the attributes present in the payload are touched; omitted attributes are left
as-is. This is why we prefer it for content edits over a full `MP_ITEM` re-setup.

**Hard restriction — Country of Origin (COO):**
> COO **cannot** be updated via `MP_MAINTENANCE` on an existing item. To change COO
> you must **delete the item in Seller Center UI, wait 48 hours, then re-create it**
> (new `MP_ITEM` setup). Plan around this — it is not patchable.

**Spec versioning** (source: item-spec-versioning-and-diff-reporting):
- Version string pattern: **`5.0.YYYYMMDD-HH_MM_SS-api`**
  (e.g. `5.0.20260501-19_21_29-api`; an earlier example was `5.0.20250612-15_17_48`).
- Same recommended version applies across `MP_ITEM`, `MP_MAINTENANCE`, `MP_WFS_ITEM`.
- ~**6,700 product types** covered.
- Migration aid: **4.X→5.X Diff Report** (per-feed-type XLSX, e.g.
  `MP Setup_Diff_Report.xlsx`) enumerates major/minor changes. `Food` product type
  covers ~all our food bundles.

---

## 2. Feed lifecycle: SUBMITTED → PROCESSED

Sources:
- https://developer.walmart.com/doc/us/mp/us-mp-feeds/
- https://developer.walmart.com/us-marketplace/docs/monitor-my-item
- https://developer.walmart.com/us-marketplace/docs/list-all-feed-statuses

**Workflow (5 steps):**
1. Submit the feed file to the bulk endpoint → **response returns a `Feed ID`**.
2. Poll status with the **All Feed Statuses API** (by `Feed ID`).
3. On `PROCESSED`, read **per-item results** in the detailed response.
4. Download the **error report** (zipped `.csv`) for failed items where available.
5. Fix and **resubmit only the failed items**.

**Feed-level status (`feedStatus`)** — one of:

| Status | Meaning |
|--------|---------|
| **`RECEIVED`** | System accepted + queued; processing not started. |
| **`INPROGRESS`** | System is processing the feed. |
| **`PROCESSED`** | Finished processing. **Check per-item results** — `PROCESSED` at the feed level does NOT mean every item succeeded. |
| **`ERROR`** | Feed failed **as a whole**; **no items processed** (e.g. malformed file, XSD failure). |

**Polling cadence (documented):** 15 min → 1 hr → 2 hr → then every 4 hr while
`INPROGRESS`. Do not tight-loop.

**Correlation:** keep the **same correlation ID across retries**; log HTTP status +
error detail for support escalation.

---

## 3. Per-item ingestion status & reading errors

Sources:
- https://developer.walmart.com/doc/us/mp/us-mp-feeds/
- https://developer.walmart.com/us-marketplace/docs/monitor-my-item
- https://developer.walmart.com/us-marketplace/docs/feed-item-status-api-for-tracking-fitment-files

**Coarse item status (`ingestionStatus` field):**
- **`PROCESSED`** — item successfully submitted.
- **`ERROR`** — item not submitted due to errors.

**Granular per-object ingestion status (Feeds overview):**

| Status | Meaning | Action |
|--------|---------|--------|
| **`SUCCESS`** | Object ingested. | none |
| **`INPROGRESS`** | Still processing. | keep polling |
| **`DATA_ERROR`** | Invalid or missing data. | fix the payload, resubmit item |
| **`SYSTEM_ERROR`** | Downstream system failure. | **retry after ~1 hour** |
| **`TIMEOUT_ERROR`** | System unavailability. | **retry after ~1 hour** |

**Where the error text lives:**
- **All Item Status API** — feed status + per-item status for a `Feed ID`.
- **Feed Item Status API** — feed + item-level ingestion status for a feed
  (supports ACES/PIES fitment feeds and other feed types returning item details).
- **Feed Error Report:** if a feed processed **with ingestion errors**, the API
  returns **HTTP 200** plus a **zipped `.csv`** containing detailed per-item error
  messages. (Per `monitor-my-item`, the downloadable error report is explicitly
  documented for `FITMENT_ACES`/`FITMENT_PIES`; for standard item feeds read the
  per-item error strings from the item-status response.)

**Practical rule for our pipeline:** treat `feedStatus=PROCESSED` as
"processing done," then iterate item results — count `SUCCESS` vs `ERROR`, surface
`DATA_ERROR` messages to the operator, auto-retry `SYSTEM_ERROR`/`TIMEOUT_ERROR`
after a delay.

---

## 4. Error codes — meanings & resolutions

Sources:
- https://developer.walmart.com/us-marketplace/docs/error-codes
- https://developer.walmart.com/doc/us/mp/us-mp-errors/
- https://marketplacelearn.walmart.com/guides/Item%20setup/Troubleshooting/troubleshoot-item-setup-errors
- https://marketplacelearn.walmart.com/guides/Catalog%20management/Troubleshooting/Troubleshoot-unpublished-items

### 4a. API request / transport errors

| Code | HTTP | Category | Meaning | Resolution |
|------|------|----------|---------|-----------|
| `INVALID_REQUEST_PARAM` | 400 | DATA | Invalid query/path parameter | Verify param names, types, allowed values |
| `INVALID_REQUEST_CONTENT` | 400 | DATA | Invalid body content | Check schema + field constraints |
| `MALFORMED_REQUEST_CONTENT` | 400 | DATA | JSON/XML not parseable | Fix formatting, resend |
| `SYSTEM_ERROR` | 500 | SYSTEM | Internal issue or payload↔Content-Type mismatch | Confirm `Content-Type`; retry w/ backoff |
| `INVALID_SYSTEM_STATE` | 500 | SYSTEM | Inconsistent backend state | Retry w/ jitter; escalate if persistent |
| `DOWNSTREAM_SYSTEM_TIME_OUT` | 504 | SYSTEM | Dependent service didn't respond | Exponential backoff retry |
| `REQUEST_THRESHOLD_VIOLATED` | 429 | RATE_LIMIT | Rate limit exceeded | Respect rate-limit headers, back off (see §5) |

Auth note: current auth is **OAuth 2.0**; access token goes in header
**`WM_SEC.ACCESS_TOKEN`**. 401s usually = expired token / insufficient scopes →
refresh token, grant scopes. (Legacy signature headers are deprecated.)

### 4b. Feed / item data-validation errors (`ERR_*` family)

| Code | Meaning | Fix |
|------|---------|-----|
| `ERR_PDI_0001` | Malformed data in the **entire feed file** | Clean special chars; revalidate against the XSD/spec |
| `ERR_PDI_0034` | Required fields missing or invalid values | Validate all mandatory fields + correct types |
| `ERR_EXT_DATA_0101116` | **Title or price mismatch with existing catalog** (product-ID conflict) | Confirm product ID; **align your data with the existing catalog item** |

`ERR_EXT_DATA_*` = your submitted data conflicts with what Walmart already has for
that product ID. This is the classic "you're trying to attach to an existing catalog
item but your title/price/attributes don't match" case — the fix is to match the
catalog, not to fight it, or to correct the product ID if you attached to the wrong
one.

### 4c. Item-setup content / authorization errors (Seller Center labels)

| Label | Meaning | Resolution |
|-------|---------|-----------|
| `Invalid product ID` | Product ID wrong/unrecognized | Correct in file, resave, re-upload |
| `Missing attribute metadata` | Template header rows damaged | Use a **fresh template**; keep rows 1–6 intact; complete rows 4–6 for multi-select attrs |
| `Main Image URL does not meet our image URL requirements` | Image URL non-compliant | Fix per image guidelines, re-upload via Full Item Setup |
| `You are not authorized to set up 'CUSTOM' Product IDs for UPC exemptions` | No GTIN/UPC exemption | Request GTIN/UPC exemption via Support **or** buy a valid GS1 product ID |
| `The item must have a Variant Group ID, Variant Attribute Name, and 'Is Primary Variant' value` | Variant config incomplete | Fill variant columns per variant rules |

### 4d. Compliance / review holds ("in review" ≈ our internal "QARTH lock")

Source: https://marketplacelearn.walmart.com/guides/Item%20setup/Troubleshooting/Troubleshoot-items-on-hold

- **Items on Hold API** status values: **`In Review`**, **`Action Needed`**,
  **`Prohibited`**. `Action Needed` items carry an error description telling you what
  to fix.
- Triggers include **hazmat / hazardous-material review** (up to **3 business days**),
  battery declaration (WFS), chemical/aerosol/pesticide declarations, and general
  trust-and-safety review of self-fulfilled items (Trust & Safety tab).
- **`System Problem`** (unpublished-items context): item cannot be published and
  **requires Walmart Marketplace support** to resolve — not self-serviceable.

---

## 4e. Why items go UNPUBLISHED (and how to auto-remediate)

Source: https://marketplacelearn.walmart.com/guides/Catalog%20management/Troubleshooting/Troubleshoot-unpublished-items

| Reason label | Meaning | Fix | Auto-republish? |
|--------------|---------|-----|-----------------|
| **Primary image missing** | No required primary image | Add a new Primary Image | on update |
| **Price missing** | No list price | Set List Price | on update |
| **Egregious shipping cost** | Shipping fee too high vs item price | Lower shipping template fee | Walmart auto-republishes ~within 48 h |
| **Reasonable Price Not Satisfied** | Offer price ≫ current/recent market price (Pricing Rule) | Lower price toward the **Reference price** benchmark | auto ~48 h once competitive |
| **Pricing Error** | Priced unintentionally **too low** | Raise price via Reference price **or** contact Support with proof the low price is intentional/compliant | on correction |
| **UPC mismatch** | Product ID ≠ actual item | Update product ID + resubmit, or appeal | on resubmit |

`Reasonable Price Not Satisfied` + `Pricing Error` are **auto-unpublish by the
Pricing Rule** — watch for them on our repriced items. Both self-heal ~48 h once the
price is in range; `System Problem` does not (needs support).

---

## 5. Rate limits & throttling

Sources:
- https://developer.walmart.com/doc/us/mp/us-mp-throttling/
- https://developer.walmart.com/us-marketplace/docs/error-codes

**Mechanism:** token-bucket, **allotted at the seller level** (separate allocations
for direct integrations vs Solution-Provider apps). A request consumes a token;
empty bucket → request denied → **`429 Too Many Requests`** with
`REQUEST_THRESHOLD_VIOLATED`.

**Response headers to honor:**
- **`x-current-token-count`** — tokens available now (your remaining request budget for that API).
- **`X-Next-Replenishment-Time`** (aka `x-next-replenish-time`) — when the count next increases.
- **`413 Payload Too Large`** — file/body exceeds size limits (distinct from 429).

**On 429:** pause requests **for that specific API**, read the headers, **sleep
until `X-Next-Replenishment-Time`, then resume at a lower rate.** Use exponential
backoff **with jitter** (e.g. 2, 4, 8, 16, 32 s), cap at ~5 attempts, keep the same
correlation ID.

**Documented per-API limits (verify live — these drift):**

| API / feed | Limit | Max file size |
|------------|-------|---------------|
| **Feeds — `inventory`** | 10 / hour | 10 MB |
| **Feeds — `mp_item`** (full setup) | 10 / hour | 25 MB |
| **Feeds — `mp_item_price_update`** | 20 / hour | 25 MB |
| **Feeds — `PRICE_AND_PROMOTION`** | 10 / hour (shared across the 3 pricing feed endpoints) | — |
| **Generic "10 feeds per hour"** guidance also cited | ~10 feeds / hour baseline | — |
| **Items — All items** | 300 / min (60/min *with* query params) | — |
| **Items — Single item** | 900 / min (60/min *with* query params) | — |
| **Inventory — update** | 200 / min | — |
| **Price — update single item** | 100 / hour | — |
| **Price — bulk update** | 10 / hour (shared) | — |
| **Orders — All orders** | 5000 / min | — |
| **Orders — ship / cancel / refund** | 60 / min each | — |

**Design implications for our `MP_MAINTENANCE` pipeline:**
- Feed submissions are the scarce resource (~**10 feeds/hour** for setup/maintenance-class
  feeds). **Batch many item updates into one feed file** rather than one-item-per-feed.
- Poll status via the item-status APIs (higher per-minute budgets), not by
  re-submitting feeds.
- Keep price/inventory churn on their **own** feed types (higher/ separate limits)
  instead of bundling into content maintenance feeds.

---

## 6. Quick decision guide

- **New listing, Walmart not selling it** → `MP_ITEM` (full spec).
- **New WFS listing** → `MP_WFS_ITEM`.
- **Edit title/bullets/description/images/attributes on an existing item** →
  `MP_MAINTENANCE` (partial; send only changed fields).
- **Change COO** → NOT possible via maintenance; delete + 48h wait + re-setup.
- **Change only price** → `price` / `MP_ITEM_PRICE_UPDATE` (don't burn a maintenance-feed slot).
- **Change only quantity** → `inventory` feed.
- **After any feed** → get `Feed ID` → poll All Feed Statuses → on `PROCESSED`,
  read per-item `ingestionStatus` → retry `SYSTEM_ERROR`/`TIMEOUT_ERROR` after ~1 h,
  fix + resubmit `DATA_ERROR` items only.
- **Item stuck "In Review" / `System Problem`** → compliance/support path, not a code
  fix (our internal "QARTH-locked").

---

### Primary source index
- Feeds overview — https://developer.walmart.com/doc/us/mp/us-mp-feeds/
- Item Management overview — https://developer.walmart.com/doc/us/mp/us-mp-items/
- Monitor my item — https://developer.walmart.com/us-marketplace/docs/monitor-my-item
- List all feed statuses — https://developer.walmart.com/us-marketplace/docs/list-all-feed-statuses
- Feed item status API — https://developer.walmart.com/us-marketplace/docs/feed-item-status-api-for-tracking-fitment-files
- Error codes — https://developer.walmart.com/us-marketplace/docs/error-codes  ·  https://developer.walmart.com/doc/us/mp/us-mp-errors/
- Rate limiting / throttling — https://developer.walmart.com/doc/us/mp/us-mp-throttling/
- Item spec versioning & diff — https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting
- Item spec version update & new features — https://developer.walmart.com/us-marketplace/page/item-spec-version-update-and-new-features
- Troubleshoot unpublished items — https://marketplacelearn.walmart.com/guides/Catalog%20management/Troubleshooting/Troubleshoot-unpublished-items
- Troubleshoot item setup errors — https://marketplacelearn.walmart.com/guides/Item%20setup/Troubleshooting/troubleshoot-item-setup-errors
- Troubleshoot items on hold — https://marketplacelearn.walmart.com/guides/Item%20setup/Troubleshooting/Troubleshoot-items-on-hold
