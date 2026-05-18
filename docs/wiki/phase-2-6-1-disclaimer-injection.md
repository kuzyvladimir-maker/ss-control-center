# 🛡 Phase 2.6.1 — Bulk Disclaimer Injection

> **Started:** 2026-05-19
> **Cost:** $0 (no AI, just SP-API PATCH)
> **Full spec:** `docs/BUNDLE_FACTORY_PHASE_2_6_1_DISCLAIMER_INJECTION.md`

---

## TL;DR

Append a curator/assembler disclaimer to bullets + description for every listing the [Listing Audit Tool](listing-audit-tool.md) flagged with `Missing curator/assembler disclaimer`. Closes the largest single compliance gap surfaced after the 2026-05-17 Retailer Distributor ban.

## Disclaimer (Option C — Defensive)

Stored in `src/lib/bundle-factory/remediation/disclaimer-text.ts`.

- **One new bullet** added at the end of existing bullets.
- **One paragraph** appended to existing description with `\n\n` separator.
- Both reference Salutem Solutions LLC as third-party curator, decline endorsement from foreign brands, declare gift basket assembly intent.

## Scripts

4 idempotent scripts in `scripts/disclaimer-injection-*.ts`. All require `<scan_id>` as the first positional arg.

| Script | Mode | SP-API |
|---|---|---|
| `plan.ts` | DRY (default) | no |
| `execute.ts` | `--apply` required | yes |
| `verify.ts` | read-only | yes (GET) |
| `rollback.ts` | `--apply` required | yes |

## Pipeline

1. `plan` → upsert `ListingRemediation { status: 'plan' }` per candidate.
2. `execute --apply --limit=10` (safety test).
3. Visual spot-check 10 ASINs in Amazon.
4. `execute --apply --batch-size=25` (full execute).
5. `verify` → confirm disclaimer present in live listings.
6. `rollback --apply` (only if needed).

## Safety

- VALIDATION_PREVIEW before every real PATCH.
- 4 req/sec rate limit (Listings API ceiling is 5).
- Auto-abort if per-batch error rate > 10%.
- Original bullets + description preserved on every `ListingRemediation` row — rollback is always possible.

## Связанные

- [Listing Audit Tool](listing-audit-tool.md) — где формируются `risk_reasons`
- [Amazon SP-API](amazon-sp-api.md) — общая инфраструктура auth + Listings 2021-08-01 API
- [Bundle Factory](bundle-factory.md) — родительский модуль (Phase 2.6 = первая remediation фаза скелета из Phase 2.0a)
