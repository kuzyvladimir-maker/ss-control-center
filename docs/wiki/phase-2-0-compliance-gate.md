# 🛡️ Phase 2.0 — Compliance Gate

> **Started:** 2026-05-19 · **Status:** Shipped (gate module + UI + API ready; wiring into Phase 2.1 pipeline pending Stage-4 integration)
> **Full spec:** `docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md`
> **Implementation prompt:** `docs/CLAUDE_CODE_PROMPT_PHASE_2_0_COMPLIANCE_GATE.md`

---

## TL;DR

Protective gate that sits between AI content generation (Stage 4) and Distribution (Stage 7) in the Bundle Factory pipeline. Evaluates 8 hard rules; any failed rule returns `BLOCKED` and the draft cannot publish until auto-fix or AI regeneration produces a passing version.

The gate is the codified version of what the 2026-05-17 RETAILER ban taught us. Without it, any Phase 2.1+ output can recreate the `[Own Brand] – [Foreign Brand Product] Gift Set` pattern that took down the account.

## 8 hard rules

| # | Rule | Auto-fix? | Triggers |
|---|------|-----------|----------|
| 1 | Title contains no foreign brand names | ❌ requires AI regen | Kraft / Goya / Ore-Ida / SpongeBob in title |
| 2 | Brand field is Salutem Vita / Starfit / Generic | ❌ requires correction | Foreign brand or empty value |
| 3 | At least one bullet carries curator disclaimer | ✅ injects DISCLAIMER_BULLET | Missing disclaimer marker |
| 4 | Description carries curator disclaimer paragraph | ✅ appends DISCLAIMER_DESCRIPTION | Missing disclaimer marker |
| 5 | Multi-brand bundle uses Gift Basket Exception node | ❌ requires category change | Multiple component brands outside node 12011207011 et al |
| 6 | Main image has no foreign logos (Claude Vision) | ❌ requires image regen | Foreign logos detected; **fail-CLOSED on vision error** |
| 7 | Title not in permanent BrandConflict blocklist | ❌ requires AI regen | Brand + product-keyword pair matches a seeded incident |
| 8 | No promotional / health-claim language | ❌ requires AI regen | `ultimate`, `perfect`, `boost immune`, etc. |

The disclaimer text used by rules 3 + 4 is reused from [`remediation/disclaimer-text.ts`](../../ss-control-center/src/lib/bundle-factory/remediation/disclaimer-text.ts) — Variant A wording, the only version verified to survive Amazon PDP code 99300 (see [Phase 2.6.2](phase-2-6-2-claude-rewrite.md)).

The vision call in Rule 6 reuses `detectForeignLogosInImage` from [`audit/vision-check.ts`](../../ss-control-center/src/lib/bundle-factory/audit/vision-check.ts) so the own-brand whitelist + generic-deli-term ignorelist from Phase 2.6.0 apply automatically.

Rule 7 reads from `BrandConflict` — the table was created and seeded with the 5 incident ASINs back in Phase 2.0a; this phase does NOT re-seed it.

## Module surface

```
src/lib/bundle-factory/compliance/
├── gate.ts                                ← runComplianceGate(input, options)
├── types.ts                               ← ComplianceInput / RuleResult / ComplianceDecision
├── banned-words.ts                        ← 4-tier word lists + helpers
├── browse-nodes.ts                        ← GIFT_BASKET_EXCEPTION_NODES + check
├── audit-log.ts                           ← writeAuditLog helper
└── rules/
    ├── rule-1-title-foreign-brands.ts
    ├── rule-2-brand-field.ts
    ├── rule-3-disclaimer-bullets.ts       (autoFix)
    ├── rule-4-disclaimer-description.ts   (autoFix)
    ├── rule-5-browse-node.ts
    ├── rule-6-image-vision-check.ts       (async, fail-CLOSED)
    ├── rule-7-permanent-blocklist.ts      (async, queries BrandConflict)
    └── rule-8-promotional-language.ts
```

## DB schema

Two new tables (Prisma migration `20260519010000_phase_2_0_compliance_gate`):

* `ComplianceCheck` — one row per gate run. Stores decision, passed/failed rule IDs, detected brands/logos, AI cost.
* `ComplianceAuditLog` — event trail (gate_check, manual_override, pattern_detected, auto_fix).

Both `BundleDraft` and `ChannelSKU` gain four columns: `compliance_status` (PENDING | CAN_PUBLISH | BLOCKED), `compliance_check_id`, `compliance_blocked_at`, `compliance_blocked_reasons`.

Turso applied via `scripts/turso-migrate-phase-2-0-compliance-gate.mjs` (idempotent; ALTER TABLE guarded with try/catch since SQLite has no `IF NOT EXISTS` for column adds).

## API endpoints

* `POST /api/bundle-factory/compliance/check` — body = `ComplianceInput` + `autoFix?`; returns `ComplianceDecision`. Persists if `bundle_draft_id` is set; stateless otherwise.
* `GET /api/bundle-factory/compliance/checks` — last 50 ComplianceCheck rows (filterable by `bundle_draft_id`, `decision`).
* `GET /api/bundle-factory/compliance/blocked-drafts` — BundleDraft rows with `compliance_status='BLOCKED'`.
* `GET /api/bundle-factory/compliance/brand-conflicts` — active BrandConflict entries.
* `POST /api/bundle-factory/compliance/brand-conflicts` — append new incident.
* `GET /api/bundle-factory/compliance/audit-log` — paginated ComplianceAuditLog.

## UI

Route: `/bundle-factory/compliance` — 4 tabs (Recent Decisions, Blocked Drafts, Brand Conflicts, Audit Log) over a KPI strip (total checks / can-publish / blocked drafts / active conflicts). Server-side renders KPIs; tab bodies are client islands that fetch on activation.

Sub-nav entry added to `BundleFactorySubNav`.

## Tests

* `src/lib/bundle-factory/compliance/__tests__/rules.test.ts` — 24 tests (3 per rule × 8 rules), all passing.
* `src/lib/bundle-factory/compliance/__tests__/gate.test.ts` — 6 fixture scenarios (clean / incident replay / autoFix on / autoFix off / multi-brand wrong node / promotional words), all passing.
* `scripts/smoke-test-compliance-gate.ts` — 4 realistic end-to-end cases, all passing.

Run:
```
npx tsx --test src/lib/bundle-factory/compliance/__tests__/rules.test.ts
npx tsx --test src/lib/bundle-factory/compliance/__tests__/gate.test.ts
npx tsx scripts/smoke-test-compliance-gate.ts
```

## What this gate does NOT do

* It does NOT scan existing live listings — that's [Phase 2.0a Listing Audit](listing-audit-tool.md).
* It does NOT generate content — that's Phase 2.2 (Variation/Content), gated AFTER generation.
* It does NOT wire itself into the Phase 2.1 pipeline yet. The hook points (Stage 4 post-gen, Stage 5 post-image, Stage 7 pre-publish) will be added when Phase 2.1 lands.
* It does NOT send Telegram alerts on BLOCKED — deferred to Phase 2.5 (Distribution).

## Maintenance

* Add new foreign brands to `FOREIGN_BRANDS_HARD_BLOCK` in [`banned-words.ts`](../../ss-control-center/src/lib/bundle-factory/compliance/banned-words.ts).
* Add new IP incidents via the UI ("Brand Conflicts" tab) or directly via `POST /api/bundle-factory/compliance/brand-conflicts`.
* The PROMOTIONAL_BANNED list is empirically derived from Phase 2.6.2 99300 triggers — extend whenever a new term lands in a rejected PATCH.
