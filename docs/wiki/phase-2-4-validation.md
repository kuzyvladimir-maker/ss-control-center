# 🔍 Phase 2.4 — Validation Pipeline

> **Started:** 2026-05-20 · **Status:** Shipped (Stage 6 — 15-validator pre-flight + promote-draft to ChannelSKU)
> **Spec:** continuation of Phase 2.3 — picks up `BundleDraft.status=IMAGE_GENERATED`

---

## TL;DR

Final pre-flight before any marketplace write. The pipeline runs **15 independent validators** over the (BundleDraft, GeneratedContent[per-channel], main_image_url) bundle. Each validator returns its own `severity: 'error' | 'warning' | 'info'`; one validator throwing does **not** abort the pipeline (post-fix improvement — every validator is wrapped in try/catch and a thrown error degrades to a `severity: 'warning'` record). Aggregated outcome:

* **PASSED** — zero `severity: 'error'` issues. Draft is promoted to `ChannelSKU` rows via `promote-draft.ts`, with UPCs reserved from `UPCPool` and SKUs minted in `XX-XXXX-XXXX` format.
* **NEEDS_REVIEW** — only `warning` and `info` issues. Operator approval required; promote is gated.
* **FAILED** — at least one `error`. No promotion; operator must fix and re-validate.

This is the last stage that runs locally / against internal data. Phase 2.5 (Distribution) is the first stage that writes to Amazon / Walmart.

## Pipeline shape

```
IMAGE_GENERATED draft  →  validation-pipeline.runValidation(draftId)
   ↓ for each validator in REGISTERED_VALIDATORS (15):
   ↓   try { validator(ctx) } catch (e) { record as 'warning' }
   ↓ aggregate: errors? warnings? infos?
   ↓ outcome = errors>0 ? FAILED : warnings>0 ? NEEDS_REVIEW : PASSED
   ↓ persist ValidationCheck row + per-validator issue rows
   ↓ on PASSED  →  promote-draft.ts builds ChannelSKU per CAN_PUBLISH content
   ↓ on NEEDS_REVIEW / FAILED  →  draft stays, operator alerted
```

## 15 Validators

Per `src/lib/bundle-factory/validation/validation-pipeline.ts:63-79` (in registration order):

| # | Validator | Category | Notes |
|---|-----------|----------|-------|
| 1 | `validator-title` | Pure text | Channel char limits, banned words from Phase 2.0 |
| 2 | `validator-bullets` | Pure text | Bullet count + char limits + manual-marker check |
| 3 | `validator-description` | Pure text | Char limit + HTML check (grocery → plain text) |
| 4 | `validator-brand-field` | Pure text | Brand must be Salutem Vita / Starfit (no Walmart "Generic") |
| 5 | `validator-compliance-rerun` | **External fail-CLOSED** | Re-runs `runComplianceGate` with image. Throws → ABORT. |
| 6 | `validator-image-dimensions` | Image inspection | 1024×1024 minimum, square ratio |
| 7 | `validator-image-format` | Image inspection | PNG/JPEG only, RGB colour space |
| 8 | `validator-amazon-browse-node` | Marketplace-aware | Gift Basket Exception node required for multi-brand |
| 9 | `validator-walmart-item-type` | Marketplace-aware | Walmart taxonomy classifier ID present |
| 10 | `validator-upc-format` | DB-touching | GS1 check digit + uniqueness against existing ChannelSKU + UPCPool availability |
| 11 | `validator-sku-pattern` | Pure text | Format `XX-XXXX-XXXX`, channel prefix matches store |
| 12 | `validator-inventory` | **External fail-soft** | Veeqo stock check — Veeqo down → warning, not error |
| 13 | `validator-packaging-dims` | Pure text | length/width/height_in present and positive |
| 14 | `validator-weight` | Pure text | weight_oz present and > 0 |
| 15 | `validator-country-of-origin` | Pure text | Required for FDA-regulated grocery |

**Fail modes:**
* **Pure text & DB-touching** — deterministic; reproducible runs.
* **Image inspection** — requires R2 URL fetchable; if the fetch fails it degrades to warning (post-fix).
* **External fail-soft (Veeqo)** — network failure → warning. Vladimir's call to publish anyway.
* **External fail-CLOSED (compliance-rerun)** — vision check / banned-words drift since Phase 2.3 → error. Cannot promote.

## DB schema additions

`ChannelSKU` gains 12 columns (Phase 2.4 additions vs Phase 1 baseline). Validation cluster:

* `main_image_url` (text) — copy of the R2 URL from Phase 2.3
* `validation_status` (text, default `"PENDING"`) — `PENDING | PASSED | NEEDS_REVIEW | FAILED`
* `validation_errors` (text, JSON) — array of issues with severity + validator name + payload
* `validated_at` (datetime)
* `validation_check_id` (text, FK to ValidationCheck row)
* `validation_attempt_count` (int)

Packaging cluster (carried forward to distribution as listing attributes):

* `package_length_in`, `package_width_in`, `package_height_in` (float)
* `package_weight_oz` (float)
* `country_of_origin` (text)
* `item_type` (text — Walmart classifier ID / Amazon product_type)

## promote-draft helper

`src/lib/bundle-factory/validation/promote-draft.ts` — runs **only when** validation outcome is `PASSED`. Per-channel `GeneratedContent` row with `compliance_status='CAN_PUBLISH'`:

1. **UPC reservation** — calls `reserveUpc()` against `UPCPool.status='AVAILABLE'`, atomically flips to `ASSIGNED` + records `assigned_to_channel_sku_id` once the row is created.
2. **SKU minting** — `buildSku()` returns format `XX-XXXX-XXXX` (channel prefix + bundle slug + variant index). Confirms uniqueness against existing `ChannelSKU`.
3. **Browse-node resolution** — calls `resolveAmazonBrowseNode()` from `browse-node-resolver.ts`. Multi-brand bundles (`distinct_brands > 1`) auto-receive the Gift Basket Exception node (`12011207011`). Single-brand currently gets the same node pending per-category Amazon ID mapping from Brand Registry (TODO).
4. **ChannelSKU INSERT** — wired up with all 12 validation/packaging columns + the 5 distribution columns (initially `listing_status='PENDING'`).

## Per-validator isolation (post-fix)

Originally the pipeline aborted on the first validator that threw. The post-fix wraps every call:

```typescript
for (const v of REGISTERED_VALIDATORS) {
  try {
    const issues = await v.run(ctx);
    issues.forEach((i) => allIssues.push({ ...i, validator: v.name }));
  } catch (e) {
    allIssues.push({
      severity: 'warning',
      validator: v.name,
      code: 'VALIDATOR_THREW',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
```

Practical effect: a transient Veeqo 502 no longer blocks the whole validation pass. The exception is `validator-compliance-rerun` — it's *designed* to error rather than degrade (fail-CLOSED on the vision rule). All other validators degrade to warnings.

## API surface

| Method + URL | Purpose |
|---|---|
| `POST /api/bundle-factory/drafts/[id]/validate` | Run full 15-validator pass + promote if PASSED. `maxDuration=120`. |
| `POST /api/bundle-factory/skus/[id]/validate` | Re-validate a single already-promoted ChannelSKU (e.g. after content edit). |
| `GET  /api/bundle-factory/drafts/[id]/validation-status` | Read-only check; returns last ValidationCheck + per-validator issue rows. |

## What this phase does NOT do

* No marketplace API calls — every check runs locally or against internal DB / R2.
* No image *editing* — only inspection; out-of-spec images fail back to Phase 2.3.
* No retry on its own — operator-driven; failed validations don't auto-fix.
* No Brand Registry sync — single-brand browse-node fallback to GBE is a known gap.

## Operator runbook

1. From the draft page (IMAGE_GENERATED), click **Validate**.
2. ~30–60s. Per-validator badges land in the validation panel.
3. **PASSED** → promote happens automatically; ChannelSKU rows appear; next stage is "Publish" (Phase 2.5).
4. **NEEDS_REVIEW** → review warnings, click **Promote anyway** if acceptable.
5. **FAILED** → fix the offending field (title, description, dims, etc.), re-validate. If `validator-compliance-rerun` errored on vision check, go back to Phase 2.3 (regenerate image).

## Vladimir's to-do list after merge

1. **Veeqo availability** — `validator-inventory` will warn on Veeqo 5xx; if you see a lot of these, check the Veeqo status page before assuming bundle is unstockable.
2. **UPC pool depth** — `validator-upc-format` fails when `UPCPool.AVAILABLE` is empty for the prefix. Top up via `scripts/seed-upc-pool-available.ts` (see Bundle Factory Fixes 2026-05-21).
3. **Single-brand browse-node** — pending per-category mapping; current single-brand bundles get the multi-brand GBE node. Works for Amazon but not optimal for organic discoverability.
