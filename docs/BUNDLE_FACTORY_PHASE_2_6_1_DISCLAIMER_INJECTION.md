# Bundle Factory Phase 2.6.1 — Bulk Disclaimer Injection

> **Created:** 2026-05-19
> **Trigger:** Audit scan `cmpaisoq80000wlfz4llxuo5k` showed `Missing curator/assembler disclaimer` as the top reason on 51%+ of all listings.
> **Goal:** Inject Option C "Defensive" disclaimer into bullets + description for every flagged listing via SP-API PATCH. Zero AI cost.

---

## Why this phase exists

After the 2026-05-17 Retailer Distributor ban for Trademark Logo Misuse, the largest single compliance gap on the remaining 4 active accounts (per audit) is the absence of a curator disclaimer. The disclaimer is the cheapest, fastest, and broadest defense:

- Aligns each listing with Amazon's **Gift Basket Exception** (node `12011207011`) positioning.
- Removes plausible deniability of "manufacturer pretending to be Salutem Vita."
- Costs nothing — no AI, no image regen, just text appended via SP-API PATCH.

This is the **first working scenario** of the 7-stage remediation skeleton already declared in `src/lib/bundle-factory/audit/remediation.ts`. Phases 2.6.2 (Title Rewrite) and 2.6.3 (Image Regen) reuse the same plan→execute→verify→rollback shape.

---

## Target

- **Scan:** `cmpaisoq80000wlfz4llxuo5k` (1585 listings, 1584/1585 vision coverage — high-confidence snapshot).
- **Bucket:** every `ListingAuditResult` whose `risk_reasons` contains `"Missing curator/assembler disclaimer"` — covers both `DISCLAIMER_ONLY` and `MULTI` strategies. The disclaimer fix is orthogonal to title/image fixes and stacks freely with them.
- **Skip:**
  - Listings whose current bullets/description already contain the disclaimer substring (`curated and packaged by salutem solutions`, case-insensitive).
  - Listings with empty `original_bullets` (nothing to merge into).
  - Rows whose `remediation_status` is not `PENDING` (already in some other flow).

---

## Disclaimer text — Option C (Defensive)

Selected by Vladimir 2026-05-19. Stored in `src/lib/bundle-factory/remediation/disclaimer-text.ts` as `DISCLAIMER_BULLET` and `DISCLAIMER_DESCRIPTION` constants.

### Bullet (one additional bullet appended)

```
Curated and packaged by Salutem Solutions LLC as a gift basket assembly. This
is not a manufacturer's product; individual items are sourced from authorized
retailers and assembled for buyer convenience.
```

### Description paragraph (appended to existing description with `\n\n`)

```
About this gift basket: This product is a curated assembly created by Salutem
Solutions LLC, a third-party curator. Salutem Solutions LLC is not affiliated
with, sponsored by, or endorsed by any of the brands included in this
collection. Each item is independently sourced from authorized retailers and
assembled into this gift basket for buyer convenience. All trademarks, brand
names, logos, and packaging visible in the product images are the property of
their respective owners. This product is intended as a gift basket; included
items are not modified, repackaged into branded materials, or altered in any
way.
```

---

## Pipeline

```
   ┌────────────────────────────────────────────────────────────────┐
   │  Phase 2.0a audit  ─→  ListingAuditResult.risk_reasons          │
   │                                                                  │
   │  scripts/disclaimer-injection-plan.ts   (DRY · no SP-API)        │
   │      ├─ filter rows with the missing-disclaimer reason           │
   │      ├─ build new_bullets = [...original, DISCLAIMER_BULLET]     │
   │      ├─ build new_description = original + "\n\n" + DESCRIPTION  │
   │      └─ upsert ListingRemediation { status: 'plan' }              │
   │                                                                  │
   │  scripts/disclaimer-injection-execute.ts   (--apply required)    │
   │      ├─ resolve sellerId per account (sellers.ts)                │
   │      ├─ batch loop, 4 req/sec (--sleep-ms=250 default)           │
   │      ├─ GET listing → extract productType                        │
   │      ├─ PATCH ?mode=VALIDATION_PREVIEW  (safety check)            │
   │      ├─ PATCH (real) — replace bullet_point + product_description│
   │      └─ status = 'completed' (or 'failed' / 'in_progress')        │
   │                                                                  │
   │  scripts/disclaimer-injection-verify.ts   (read-only SP-API)     │
   │      └─ GET each completed listing, confirm disclaimer present   │
   │         ├─ hit  → keep status='completed'                         │
   │         └─ miss → status='verification_failed'                    │
   │                                                                  │
   │  scripts/disclaimer-injection-rollback.ts   (--apply required)   │
   │      └─ PATCH original_* back into listing, status='rolled_back' │
   └────────────────────────────────────────────────────────────────┘
```

### Status transitions on `ListingRemediation`

```
plan ──(execute --apply)──► in_progress ──┬─► completed ──(verify)──► completed
                                          │                          └─► verification_failed
                                          └─► failed
                                          
completed / failed / verification_failed ──(rollback --apply)──► rolled_back
                                                                  │
ListingAuditResult.remediation_status ◄──────────────────────────  ◄── PENDING
```

---

## SP-API PATCH request shape

```http
PATCH /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=ATVPDKIKX0DER
Content-Type: application/json

{
  "productType": "<fetched from GET response>",
  "patches": [
    {
      "op": "replace",
      "path": "/attributes/bullet_point",
      "value": [
        { "value": "Original bullet 1", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" },
        { "value": "Original bullet 2", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" },
        { "value": "Curated and packaged by Salutem Solutions LLC ...", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" }
      ]
    },
    {
      "op": "replace",
      "path": "/attributes/product_description",
      "value": [
        { "value": "<original>\n\nAbout this gift basket: ...", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" }
      ]
    }
  ]
}
```

A `mode=VALIDATION_PREVIEW` request with the same body must return `status` ≠ `INVALID` before we issue the real PATCH.

---

## Safety mechanisms

1. **Dry run by default.** `--apply` is required for any real SP-API mutation. Without it, every script either skips SP-API entirely (plan) or runs VALIDATION_PREVIEW only (execute, rollback).
2. **VALIDATION_PREVIEW gate.** Execute and rollback both call `?mode=VALIDATION_PREVIEW` first. If Amazon rejects the body shape, the row is marked failed before the real PATCH is sent.
3. **Per-account rate limiting.** Each account uses its own SP-API credentials and we sleep `--sleep-ms` (default 250 ms = ~4 req/sec) between calls. Listings API ceiling is 5 req/sec, leaving headroom.
4. **429 + Retry-After.** Handled inside `spApiRequest` — auto-retry up to 3× honoring the header.
5. **Batch error-rate cutoff.** Execute aborts mid-run with a clear "STOP" message if the per-batch error rate exceeds `--max-error-rate` (default 10%). Last 3 errors are printed; resume command is suggested.
6. **Original content preserved.** Every `ListingRemediation` row stores `original_bullets` + `original_description`. Rollback reuses them — no risk of forgetting what the listing looked like before.
7. **Idempotent plan.** Re-running the plan script doesn't duplicate rows; it `upsert`s on `audit_result_id`. Rows that already have the disclaimer (substring match) are skipped without touching anything.
8. **No automatic full execute.** Vladimir approves each step explicitly. The recommended sequence is `--limit=10` first, manually inspect, then full execute.

---

## Rollback procedure

If something goes wrong after a real execute:

```bash
# Roll back only the listings that succeeded (don't touch the ones that failed):
npx tsx scripts/disclaimer-injection-rollback.ts <scan_id> --apply --status=completed

# Roll back everything:
npx tsx scripts/disclaimer-injection-rollback.ts <scan_id> --apply
```

The rollback PATCH uses the same VALIDATION_PREVIEW gate as execute. Rolled-back rows become re-plannable (`ListingAuditResult.remediation_status` returns to `PENDING`).

---

## Phase 2.6.x roadmap

| Phase | Target | Cost per listing | When |
|---|---|---|---|
| **2.6.1 — Disclaimer (THIS)** | Append text in bullets + description | $0 | now |
| 2.6.2 — Title rewrite | Claude rewrites titles containing foreign brands | ~$0.01 | after 2.6.1 verify clean |
| 2.6.3 — Image regen | gpt-image-1 regenerates main images flagged by Vision | ~$0.04 | after 2.6.2 |
| 2.6.4 — Manual review | Operator handles ASINs that fail 2.6.1–2.6.3 | manual | rolling |

Each follow-up phase reuses the plan → execute → verify → rollback pattern of this one, so the operational habit only has to be learned once.

---

## Operational checklist

- [x] Disclaimer text approved (Option C, 2026-05-19)
- [x] Plan script (dry run)
- [x] Execute script (--apply gated, VALIDATION_PREVIEW first)
- [x] Verify script (read-only SP-API)
- [x] Rollback script (--apply gated)
- [x] Wiki updated
- [ ] Plan run against `cmpaisoq80000wlfz4llxuo5k` → reviewed by Vladimir
- [ ] Execute --limit=10 → spot-check 10 listings on Amazon
- [ ] Full execute → verify run
- [ ] Phase 2.6.2 (Title Rewrite) kicked off

---

**Maintained by:** Vladimir + Claude · **Last updated:** 2026-05-19
