# 🪄 Phase 2.2 — Variation Matrix + Content Generation

> **Started:** 2026-05-19 · **Status:** Shipped (Stage 3 deterministic variants + Stage 4 Claude content + Compliance Gate feedback loop)
> **Spec:** Vladimir's autonomous prompt 2026-05-19

---

## TL;DR

Two stages glued into one pipeline:

* **Stage 3 — Variation Matrix.** Reads the curated `ResearchPool`, builds 1–10 composition variants algorithmically (no AI cost), persists them in a new `VariationMatrix` row. Operator picks one in the UI; the index is recorded.
* **Stage 4 — Content Generation.** For the selected variant, calls Claude Sonnet 4.5 once per channel template (Amazon vs Walmart) with the marketplace-rules KB cached at every file breakpoint. Pipes the output through `runComplianceGate({ autoFix: true })` which auto-injects the curator disclaimer. Failed rules feed back into a retry prompt (up to 3 attempts) before the row lands BLOCKED + manual_review_required.

When every channel passes compliance, the parent BundleDraft flips from `VARIATION_SELECTED` → `GENERATED`. Mixed results leave the draft at `VARIATION_SELECTED` so the operator can hit "Re-try BLOCKED".

## Pipeline shape

```
RESEARCHED draft → user clicks "Approve research →"
   ↓ status → VARIATION_SELECTED
Stage 3 — generate-variations endpoint
   ↓ deterministic algorithm reads ResearchPool, scores by freshness,
   ↓ builds 1–10 variants with cost / margin / feasibility
   ↓ persists VariationMatrix row, selected_variant_idx=null
User picks a variant
   ↓ select-variation endpoint → selected_variant_idx set
User clicks "Continue to content generation →"
   ↓ → /bundle-factory/drafts/[id]
Stage 4 — generate-content endpoint
   ↓ for each unique template (amazon, walmart):
   ↓   1. Claude Sonnet 4.5 with KB cached (4 cache breakpoints)
   ↓   2. runComplianceGate({ autoFix: true })
   ↓      - rules 3 + 4 inject disclaimer text into bullets + description
   ↓      - rules 1, 2, 5, 7, 8 are HARD BLOCK → fall through to retry
   ↓   3. On BLOCKED, feed failed_rules back to Claude (attempt ≤ 3)
   ↓   4. After exhausted retries, store CAN_PUBLISH or BLOCKED+manual_review
   ↓ GeneratedContent row per channel; 5 Amazon channels share the
   ↓ amazon template (one Claude call, one cost owner; siblings carry 0¢)
   ↓ when every row CAN_PUBLISH → BundleDraft.status = GENERATED
```

## DB schema

Two new tables (migration `20260519030000_phase_2_2_content_generation`):

* **VariationMatrix** — one row per `BundleDraft` (unique FK). Stores `variants_json` and the chosen `selected_variant_idx`. `generation_cost_cents` is always 0 — the generator is deterministic.
* **GeneratedContent** — one row per `(BundleDraft, channel)`. Stores `title`, `bullets_json`, `description`, plus the compliance verdict (`compliance_status`, `compliance_check_id`, `compliance_attempts`, `manual_review_required`, `failed_rule_ids`) and Claude accounting (`generation_cost_cents`, `claude_input_tokens`, `claude_output_tokens`, `cache_read_tokens`, `cache_write_tokens`).

`BundleDraft` gains two back-relations (`variation_matrix`, `generated_content[]`) but no new columns.

Turso script: `scripts/turso-migrate-phase-2-2-content-generation.mjs`. Idempotent via `CREATE TABLE IF NOT EXISTS`. Run with the existing TURSO env vars.

## Module surface

```
src/lib/bundle-factory/
├── kb-loader.ts             ← reads kb-content/{amazon,walmart}/*.md, returns
│                              Anthropic system blocks with cache_control markers
├── kb-content/              ← BAKED-IN copy of docs/marketplace-rules/
│   ├── amazon/              (refresh via scripts/sync-kb-content.sh)
│   └── walmart/
├── variation-matrix.ts      ← deterministic generateVariants(pool, type, pack)
├── content-generation.ts    ← Claude Sonnet 4.5 wrapper per template + validator
├── content-pipeline.ts      ← runContentGeneration: dedup-by-template, gate,
│                              retry loop, persist, status transition
└── (existing) compliance/gate.ts is the gate runner — Phase 2.0 work
```

## API surface

| Method + URL | Purpose |
|---|---|
| `POST /api/bundle-factory/briefs/[id]/generate-variations` | Stage 3 — build 1–10 variants from the curated pool. Idempotent. |
| `POST /api/bundle-factory/briefs/[id]/select-variation`     | Body: `{ variant_idx }`. Records the chosen variant. |
| `GET  /api/bundle-factory/drafts/[id]`                      | Draft + variation matrix + generated content + pool. |
| `POST /api/bundle-factory/drafts/[id]/generate-content`     | Stage 4 — generate per channel, run gate, retry loop, persist. `maxDuration=300`. |
| `POST /api/bundle-factory/drafts/[id]/regenerate-content`   | Default: re-run only currently-BLOCKED channels. Fresh 3-retry budget. |

## UI

* **/bundle-factory/briefs/[id]** — when status ∈ {VARIATION_SELECTED, GENERATED, APPROVED}, a new `VariationMatrixSection` renders. It has a Generate / Re-generate button, a 6-column variant table (Composition / Cost / Price / Margin / Feasibility / Action), and a Continue link once a variant is selected.
* **/bundle-factory/drafts/[id]** — NEW. Server-renders the selected variant summary, then the `DraftDetailClient` island for the per-channel cards (Generate / Re-generate-all / Re-try BLOCKED, plus title/bullets/description preview with char counts and compliance badges).

## Compliance Gate integration

Per-channel call:

```typescript
const decision = await runComplianceGate(
  {
    bundle_draft_id: draft.id,
    title:           generated.title,
    brand:           draft.brand,
    bullets:         generated.bullets,
    description:     generated.description,
    browse_node:     null,           // channel-specific browse_node lands in Phase 2.5
    main_image_url:  null,           // image gate runs in Phase 2.3
    bundle_components: selected.composition,
    skip_image_check: true,
  },
  { autoFix: true, actor: "content-pipeline" },
);
```

The gate's rules 3 + 4 (disclaimer-bullets, disclaimer-description) own the disclaimer text — content-generation NEVER includes the disclaimer itself, which is exactly what surfaced as a regression in Phase 2.6.2 (duplicate disclaimer triggers Amazon code 99300). The text lives in `remediation/disclaimer-text.ts` (Variant A wording).

Retry loop: on BLOCKED, the failed_rules array is folded into the next Claude call's user message as a "PRIOR ATTEMPT N WAS REJECTED" block, with the offending output quoted back. Up to 3 attempts before manual-review escalation.

## Cost model

Per draft (6 channels, 2 templates, no retries):
* 2 Claude calls × ~1500 input + ~250 output tokens (input cached after first call) = ~$0.02
* Compliance gate runs locally (Rule 6 vision skipped here) — $0 unless image is on
* Per-channel ComplianceCheck row writes — $0

At 1000 drafts/month: ~$20–25. Cache hit rate climbs sharply after the first draft of the day since the KB blocks don't change.

## Tests + verification

* `src/lib/bundle-factory/__tests__/variation-matrix.test.ts` — 9 unit tests (single/mixed/cross-brand variant shapes, cost/margin/feasibility math, error paths).
* `src/lib/bundle-factory/__tests__/kb-loader.test.ts` — 4 tests (loads amazon + walmart bundles, cache-marker limit enforcement).
* `src/lib/bundle-factory/__tests__/content-generation.test.ts` — 15 tests (parser tolerance, output validator on emoji/HTML/manual-marker/length/promo).
* `scripts/smoke-content-pipeline.ts` — end-to-end against `dev.db` with a stubbed Claude client (`globalThis.__BUNDLE_FACTORY_CLAUDE_STUB__`): variants persisted, compliance gate runs with autoFix, disclaimer injected, draft flips to GENERATED.

All 28 tests PASS; smoke PASS.

## What this phase does NOT do

* No Stage 5 (main bundle image generation) — Phase 2.3.
* No Stage 6 (final validation / marketplace pre-flight) — Phase 2.4.
* No Stage 7 (SP-API / Walmart publication) — Phase 2.5.
* No browse-node-aware Rule 5 firing yet — the content gate runs with `browse_node: null` because per-channel browse nodes aren't selected in this stage. Phase 2.5 will pass the real value.
* No background job queue — generation runs inline with `maxDuration=300`. Phase 5+ moves it behind BullMQ.

## Operator runbook

1. Open a brief at status RESEARCHED, curate the pool, click **Continue to Variation Matrix →**.
2. On the brief page (now VARIATION_SELECTED), click **Generate variants**. Pick one — the row goes green and a **Continue to content generation →** link appears.
3. Open the draft page (`/bundle-factory/drafts/[id]`), click **Generate content**. ~20–60s. Cards land per channel with compliance badges.
4. If any channel is BLOCKED, **Re-try BLOCKED** auto-feeds the failed rules back to Claude. After 3 retries the row is left for manual review.
5. When every channel reads CAN_PUBLISH, the draft status flips to **GENERATED** — Phase 2.3 (Image Generation) picks up from here.

## Vladimir's to-do list after merge

1. **Apply Turso migration** when convenient:
   ```bash
   cd ss-control-center
   node scripts/turso-migrate-phase-2-2-content-generation.mjs
   ```
   Idempotent (CREATE TABLE IF NOT EXISTS).
2. **No new env vars** — `ANTHROPIC_API_KEY` already lives in Vercel from Phase 2.6.x.
3. **KB sync** — when you edit anything under `docs/marketplace-rules/{amazon,walmart}/`, run `bash scripts/sync-kb-content.sh` so the baked copy under `ss-control-center/src/lib/bundle-factory/kb-content/` follows.

## Связано с
- [Phase 2.3 — Image Generation](phase-2-3-image-generation.md) — следующий этап pipeline
- [Bundle Factory](bundle-factory.md) — общая архитектура модуля
