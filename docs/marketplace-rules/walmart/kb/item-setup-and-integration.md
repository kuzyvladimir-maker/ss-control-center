# Walmart Marketplace — Item Setup Methods & API Integration (KB)

Distilled engineering reference for setting up and (mainly) **updating existing
listings** on Walmart Marketplace US via the API. Focus: choosing a setup method,
the API integration model, feeds (esp. `MP_MAINTENANCE` partial updates), item
spec, item status, error handling, and rate limits.

Compiled 2026-07-01 from Walmart Marketplace Learn (seller-facing) and the Walmart
Developer Portal (technical). The Learn "Overview" pages are thin marketing shells;
all hard technical facts below come from `developer.walmart.com`.

## Fetch failures / gaps (read this first)

These URLs are JavaScript-rendered single-page apps and returned only nav/footer
shells to WebFetch (no body content). Their facts below were recovered via web
search of the same domain, so treat exact numbers as **verify-before-relying**:

- `https://developer.walmart.com/us-marketplace/reference` — returned empty shell.
- `https://developer.walmart.com/doc/us/us-mp/us-mp-feeds/` (and the
  `.../media/us-mp-feeds-overview/` variant) — returned nav only; feed facts
  reconstructed from search + the working `/doc/us/mp/us-mp-feeds/` page.
- The Learn `/guides` index and Overview pages render titles but emit generic
  `/guides` hrefs, so deep links had to be inferred.

Everything else (token flow, throttling numbers, error model) came back with real
content and is cited per-section.

---

## 1. Item setup methods — which to use

Walmart offers several ways to get items into the catalog. For an **existing-catalog
seller that bulk-updates listings**, the relevant ones are the bulk template and the API.

| Method | What it is | When to use |
|---|---|---|
| **Express setup** | List items already in Walmart's catalog | ≤ 50 items that match existing catalog entries |
| **Full Setup template** (bulk spreadsheet) | Excel/spec template to create brand-new items | New items not in catalog; no-code bulk |
| **Match Walmart's catalog** | Offer against thousands of existing catalog items | Large catalogs of already-listed products |
| **Import** | Import from external marketplaces or Supplier One | Migration from another channel |
| **Virtual packs** | Create multiple pack sizes with bulk discounts | Multipack/variant merchandising |
| **Convert to WFS / WFS multi-box** | Move seller-fulfilled → Walmart-fulfilled | Fulfillment switch |
| **Single item (Seller Center)** | Full setup UI for one item | A handful of items |
| **Solution Providers** | Approved 3rd parties do catalog import for you | No engineering capacity |
| **API** | Direct programmatic integration | **Large catalogs + technical capability (our case)** |

WFS items need extra required data: **country of origin, dimensions, trade item
configuration**; hazardous items require compliance screening. Some categories
(Lawn Chemicals, Live Plants) require legal compliance before listing.

Source: https://marketplacelearn.walmart.com/guides/Getting%20started/Getting%20ready%20to%20sell/Item-setup-methods:-Overview

---

## 2. Updating existing content — method selection

Three seller-facing ways to change content on already-live items:

1. **Single item** — Seller Center UI, best for a few items.
   `/guides/Catalog%20management/Item%20management/Update-item-content-individually-in-Seller-Center`
2. **Bulk (spreadsheet)** — template or GTIN-keyed sheet, many items at once.
   `/guides/Catalog%20management/Item%20management/Update-item-content-in-bulk-in-Seller-Center`
3. **API** — large catalogs with engineering support (this is our path; see §4).

Updatable content = **product name, site description, key features, images**, plus
item attributes (feature values).

**Content ownership gotcha (the Walmart analogue of our QARTH lock):** brand owners
and authorized resellers get priority. If you are **not** the brand owner / authorized
reseller you **cannot update some content fields — including blank ones**. Walmart:
*"if you don't have brand owner or authorized reseller privileges, you won't be able
to update some content fields."* Fix path is Brand Portal registration:
`/guides/Getting%20started/Brand%20Portal/Register-your-brand-on-Walmart-Marketplace`.

Source: https://marketplacelearn.walmart.com/guides/Getting%20started/Getting%20ready%20to%20sell/How-to-update-content:-Overview

---

## 3. Getting API keys

1. Seller Center → **API Integration** page → **API Key Management** (re-auth with
   Seller Center credentials).
2. Copy your **Client ID** and **Client Secret** (Secret shown behind a lock icon).

Credentials are seller-scoped. Direct-integration sellers and approved Solution
Providers get **separate** rate-limit allotments (see §8). Best practice per Walmart:
scope only the permissions you need; store access + refresh tokens securely.

Sources:
- https://developer.walmart.com/us-marketplace/docs/use-apis-as-a-marketplace-seller
- https://marketplacelearn.walmart.com/guides/Getting%20started/Getting%20ready%20to%20sell/Integration-methods-API

---

## 4. Auth — OAuth 2.0 token flow (concrete)

REST APIs, OAuth 2.0 (client-credentials).

**Token endpoint:** `POST https://marketplace.walmartapis.com/v3/token`

Request headers:
- `Authorization: Basic base64(clientId:clientSecret)`
- `Content-Type: application/x-www-form-urlencoded`
- `Accept: application/json`
- `WM_QOS.CORRELATION_ID: <uuid>` (traceability; send on every call)
- `WM_SVC.NAME: Walmart Marketplace`

Body: `grant_type=client_credentials`
(also supported: `authorization_code` for Solution Providers after seller consent;
`refresh_token` to renew.)

Response:
- `access_token` — JWT bearer
- `token_type` — `Bearer`
- `expires_in` — **900 seconds (15 min)** access-token TTL
- refresh token TTL — **31,536,000 s (365 days)**

**On every subsequent API call** attach the token via the Walmart-specific header,
not a standard `Authorization: Bearer`:

```
WM_SEC.ACCESS_TOKEN: <access_token>
WM_QOS.CORRELATION_ID: <uuid>
WM_SVC.NAME: Walmart Marketplace
Accept: application/json
```

Practical note: cache the access token and refresh a bit before the 15-min expiry;
do **not** mint a new token per request (token endpoint is itself rate-limited).

Sources:
- https://developer.walmart.com/us-marketplace/docs/get-an-access-token
- Related: `/us-marketplace/docs/oauth-20-authorization`,
  `/us-marketplace/docs/retrieve-access-token-details`,
  `/us-marketplace/docs/api-scope-walmart-marketplace`,
  `/us-marketplace/docs/delegated-access-authorization`

---

## 5. Feeds API — the bulk engine (this is how we push updates)

Bulk create/update = submit **one file describing many items** → Walmart returns a
**Feed ID** you poll for per-item results. This is the mechanism behind both full
item setup and partial maintenance.

**Endpoints:**
- `POST /v3/feeds?feedType={type}` — submit a feed (`multipart/form-data`, file part).
  Returns `{ feedId }`.
- `GET /v3/feeds` — list feeds submitted by the account.
- `GET /v3/feeds/{feedId}?includeDetails=true` — feed status + per-item results.
- Feed **item status** / **error report** endpoints exist for fitment/error drilldown.

**feedType values (seen across docs):**
`MP_ITEM` (full item setup), `MP_MAINTENANCE` (partial/maintenance — see §6),
`MP_WFS_ITEM` (WFS item setup), `OMNI_WFS` (convert existing item to WFS),
`price` / `MP_ITEM_PRICE_UPDATE`, `PROMO_PRICE`, `inventory` (`MP_INVENTORY`),
`LAGTIME`, `CPT_SELLER_ELIGIBILITY`, `MP_ITEM_MATCH`.

**Feed-level status lifecycle** (on `GET /v3/feeds/{feedId}`):
- `RECEIVED` — accepted and queued
- `INPROGRESS` — processing
- `PROCESSED` — finished (per-item results now populated)
- `ERROR` — feed failed as a whole; **no items processed**

**Per-item ingestion status** (inside a PROCESSED feed):
`SUCCESS`, `INPROGRESS`, `DATA_ERROR`, `SYSTEM_ERROR`, `TIMEOUT_ERROR`.

**Result counters:** `itemsReceived`, `itemsSucceeded`, `itemsFailed`
(plus per-item `ingestionErrors`).

**Polling guidance (Walmart):** poll at ~15 min, 1 h, 2 h, then every 4 h; use
exponential backoff + jitter. A `PROCESSED` feed can still contain failed items —
always read the per-item detail, not just feed status.

Sources:
- https://developer.walmart.com/doc/us/mp/us-mp-feeds/
- https://developer.walmart.com/doc/us/mp/us-mp-items/feed
- (shell-only, verify) https://developer.walmart.com/doc/us/us-mp/us-mp-feeds/

---

## 6. Item spec: Full (`MP_ITEM`) vs Maintenance (`MP_MAINTENANCE`)

- **Full Item Spec** (`MP_ITEM`) — complete attribute set required to create/replace
  an item. Use for new items.
- **Item Maintenance Spec** (`MP_MAINTENANCE`) — **partial update**: send only the
  fields you want to change; you do **not** resupply the full attribute set. This is
  the correct feed for editing existing live listings (price, inventory, lag time,
  content fields, etc. — subject to the §2 content-ownership lock). This is Walmart's
  analogue of an SP-API partial `PATCH`.

Spec versions: Item spec **4.0** and **5.0** both expose `MP_ITEM`, `MP_MAINTENANCE`,
`MP_WFS_ITEM` (5.0 adds `OMNI_WFS`). Pin a spec version; the Item spec has
"versioning and diff reporting." Fetch the live schema via the Get-Spec / Taxonomy
utility (`developer.walmart.com/api/us/mp/utilities`) rather than hardcoding — it
drives the required-attribute set per category.

Sources:
- https://developer.walmart.com/doc/us/mp/us-mp-items/
- https://marketplacelearn.walmart.com/ca/guides/Item%20setup/Item%20setup/make-item-updates
- https://developer.walmart.com/api/us/mp/utilities

---

## 7. Item status model

Query via `GET /v3/items` (and single-item `GET /v3/items/{sku}`) with
`lifecycleStatus` and `publishedStatus` parameters.

- **`lifecycleStatus`** — where the listing is overall: `ACTIVE`, `ARCHIVED`,
  `RETIRED`.
- **`publishedStatus`** — where it is in the submission pipeline: `PUBLISHED`,
  `UNPUBLISHED` (also seen: `IN_PROGRESS`, `STAGE`, `SYSTEM_PROBLEM`).

Status meanings that matter operationally:
- **PUBLISHED** — live and buyable.
- **UNPUBLISHED** — pulled by back-end rules: e.g. **no inventory for too long**,
  **image problems**, missing/failed content. Common target of "why did my item drop"
  triage. See troubleshoot guide below.
- **STAGE** — item won't publish until the seller **account itself is live**.
- **SYSTEM_PROBLEM** — cannot publish; requires Walmart support to resolve.
- **IN_PROGRESS** — mid-processing.

Sources:
- https://marketplacelearn.walmart.com/guides/Catalog%20management/Troubleshooting/Troubleshoot-unpublished-items
- https://developer.walmart.com/doc/us/mp/us-mp-items/

---

## 8. Rate limits & throttling

Walmart uses a **token-bucket** per API: each request consumes a token; buckets
refill at a fixed rate. Limits are **per seller**; direct integrations vs approved
Solution Providers get **separate** allotments. Exceeding a limit → **HTTP 429
Too Many Requests**.

**Rate-limit response headers to honor on 429:**
- `x-current-token-count` — tokens left for that API
- `x-next-replenish-time` / `X-Next-Replenishment-Time` — when the bucket refills
- (client action: sleep until the replenish time, then resume at a lower rate; run a
  client-side token bucket to stay under the cap.)

**Per-API limits (verify — reconstructed from search):**

| API | Limit |
|---|---|
| Get all feed statuses / feed item status | ~5,000/min (shared) |
| Get feed error report | ~60/hour |
| Get item spec | ~10/min |
| Catalog search | ~200/min |
| Get all items | ~300/min (~60/min with query params) |
| Get single item | ~900/min (~60/min with query params) |
| Get / update inventory | ~200/min each |
| Get all orders | ~5,000/min |
| Ship / refund / cancel order lines | ~60/min each |
| Update single item price | ~100/hour |

**Feed submission limits (bulk) — the real bottleneck for our workflow:**
- Most feeds (incl. `MP_ITEM`, `MP_MAINTENANCE`, price, inventory):
  **~10 feeds/hour** (some up to ~20/hour).
- `LAGTIME` feed and legacy `PROMO` feed: **~6/day**.
- Bulk price updates: **~10/hour**.

**File size / processing (per feed type):**
- Item feeds: **~25 MB max**, ~4 h processing.
- Price feeds: **~10 MB max**, ~30 min processing.
- Max file sizes range **~0.4 MB to 25 MB** depending on feed type.

**Design implication:** batch aggressively — with ~10 feeds/hour, prefer **many items
per `MP_MAINTENANCE` feed** over many small feeds. Watch the 25 MB item / 10 MB price
ceilings and chunk accordingly.

Sources:
- https://developer.walmart.com/doc/us/mp/us-mp-throttling/
- (shell-only, verify) https://developer.walmart.com/us-marketplace/reference

---

## 9. Error handling model

**HTTP status codes:** `400` bad request (bad params / missing headers), `401`
unauthorized (missing/expired token, insufficient scope), `403` forbidden, `404`
not found, `405` method not allowed, `406` not acceptable, `415` unsupported media
type, `423` locked (record/processing lock), `429` throttled, `500` server error,
`503` unavailable, `504` gateway timeout.

**Error JSON shape** (`errors` array):

```json
{
  "errors": [{
    "code": "INVALID_REQUEST_PARAM",
    "message": "Human-readable description",
    "category": "DATA | AUTH | SYSTEM",
    "severity": "ERROR | WARNING",
    "field": "fieldName"
  }]
}
```

Common codes: `INVALID_REQUEST_PARAM`, `UNAUTHORIZED`, `CONTENT_NOT_FOUND`,
`REQUEST_THRESHOLD_VIOLATED` (throttle), `SYSTEM_ERROR`, `DOWNSTREAM_SYSTEM_TIME_OUT`.

**Severity:** `ERROR` = blocking, `WARNING` = non-blocking. On a feed, `PROCESSED`
with per-item `DATA_ERROR`s is the normal partial-failure path — surface item-level
errors, don't treat feed-level `PROCESSED` as success.

Source: https://developer.walmart.com/doc/us/mp/us-mp-errors/

---

## 10. TL;DR for our updater

1. **Method:** direct **API** (large catalog, we have engineering).
2. **Auth:** client-credentials → `POST /v3/token`; cache the 15-min access token;
   send `WM_SEC.ACCESS_TOKEN` + `WM_QOS.CORRELATION_ID` + `WM_SVC.NAME` on every call.
3. **Update existing listings:** `POST /v3/feeds?feedType=MP_MAINTENANCE` with a
   **partial** spec (only changed fields), `multipart/form-data`.
4. **Track:** poll `GET /v3/feeds/{feedId}?includeDetails=true`; read per-item
   `ingestionStatus` / `ingestionErrors`, not just feed status.
5. **Content lock:** if not brand owner / authorized reseller, some content fields
   (even blank ones) will silently reject → Brand Portal registration.
6. **Budget:** ~10 feeds/hour → batch many SKUs per feed; item file ≤ 25 MB,
   price file ≤ 10 MB.
7. **Backoff:** on `429`, read `x-current-token-count` / `x-next-replenish-time`,
   sleep to replenish, resume slower.
