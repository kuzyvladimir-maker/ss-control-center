# 🔬 Phase 2.1 — Brief Input + Research + Image Mirror

> **Started:** 2026-05-19 · **Status:** Shipped (UI + pipeline + R2 mirror; Stage 4 Compliance Gate wiring deferred to Phase 2.2/2.4 when Stage 4 content generation lands)
> **Full prompt:** `docs/CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_2_1.md`
> **Spec context:** `docs/BUNDLE_FACTORY_CONCEPT_v1_0.md` Stage 1–2 + `docs/BUNDLE_FACTORY_SOURCING_MAP.md` v1.1

---

## TL;DR

Lets Vladimir click **+ New Brief**, fill a 4-step form, and kick off Stage 2 Research — which calls Perplexity sonar-pro, downloads the returned reference images to Cloudflare R2 (Stage 2.5 mirror), and populates a curated `ResearchPool`. After curating, **Approve research →** flips the draft to `VARIATION_SELECTED` ready for Phase 2.2.

## Pipeline shape

```
Stage 1 — Brief Input
  /bundle-factory/briefs/new  (4-step form)
  POST /api/bundle-factory/briefs  (auto-creates GenerationJob)
       ↓
Stage 2 — Research
  POST /api/bundle-factory/research/run
       ↓ Perplexity sonar-pro (~10–30s, ~$0.01)
       ↓
Stage 2.5 — Image Mirror
  Each returned reference URL → R2 PUT
  External URLs swapped for `${R2_PUBLIC_URL}/sec/draft-<id>-<slug>/<i>.<ext>`
       ↓
ResearchPool rows persisted, BundleDraft.status → RESEARCHED
  GenerationStage(RESEARCH) marked COMPLETED
  ListingLifecycleLog entry written
       ↓
Operator curates pool (edit/delete via /api/bundle-factory/research/[id])
       ↓
Approve → POST /api/bundle-factory/briefs/[id]/approve-research
  BundleDraft.status → VARIATION_SELECTED
  (Phase 2.2 picks up from here)
```

## Module surface

```
src/lib/bundle-factory/
├── perplexity.ts            ← sonar-pro client + structured prompt + parser
├── research-pipeline.ts     ← runResearch orchestrator
├── r2-image-mirror.ts       ← mirrorImages (Cloudflare R2 PUT)
└── lifecycle-log.ts         ← logLifecycle helper (writes ListingLifecycleLog)

src/app/api/bundle-factory/
├── briefs/route.ts                              (POST auto-creates GenerationJob)
├── briefs/[id]/route.ts                         (GET/PATCH/DELETE)
├── briefs/[id]/approve-research/route.ts        (POST → VARIATION_SELECTED)
├── research/run/route.ts                        (POST, maxDuration=120)
└── research/[id]/route.ts                       (PATCH/DELETE single row)

src/app/bundle-factory/
├── page.tsx                  (Research pipeline KPI strip added)
├── briefs/page.tsx           (now lists DRAFT + RESEARCHED + …, "+ New Brief")
├── briefs/new/page.tsx       (server wrapper)
├── briefs/new/NewBriefForm.tsx   (4-step client form)
├── briefs/[id]/page.tsx      (server wrapper + stage progress)
└── briefs/[id]/BriefDetailClient.tsx  (Run Research + poll + curate + approve)
```

## API surface

| Method + URL | Purpose |
|---|---|
| `POST /api/bundle-factory/briefs` | Create brief; auto-creates GenerationJob if not provided. |
| `GET  /api/bundle-factory/briefs/[id]` | Brief + pool + stages for detail page. |
| `PATCH /api/bundle-factory/briefs/[id]` | Edit brief (DRAFT only). |
| `DELETE /api/bundle-factory/briefs/[id]` | Soft-archive (→ ARCHIVED). |
| `POST /api/bundle-factory/briefs/[id]/approve-research` | Pool ≥ 5 → status VARIATION_SELECTED. |
| `POST /api/bundle-factory/research/run` | Kick off Stage 2; maxDuration=120s for Perplexity round-trip. |
| `PATCH /api/bundle-factory/research/[id]` | Edit single pool item. |
| `DELETE /api/bundle-factory/research/[id]` | Remove from pool. |

## Dev-mode behaviour

`runResearch` skips the Perplexity call when `NODE_ENV !== "production"` AND `PERPLEXITY_API_KEY` is missing. Returns the 3-product mock fixture (Lunchables Pizza/Ham + Capri Sun) so the UI can be exercised offline. Production NEVER hits the mock path.

## R2 mirror behaviour

If R2 env vars are missing or set to the literal `placeholder`, `mirrorImages` returns the original retailer URLs with `uploaded: false`. The pipeline still completes — Stage 7 distribution can use the external URLs as a less-safe fallback. Real production keys are pulled from Vercel into `.env.local` via `vercel env pull`.

R2 key format: `sec/draft-<draft_id>-<product-slug>/<i>.<ext>`. Deterministic on inputs so re-runs overwrite the same objects (no orphans).

## Compliance Gate integration

Phase 2.1 does NOT call `runComplianceGate` — Stage 4 (content generation) is the gate's actual entry point and Stage 4 ships in Phase 2.2 / 2.4. When that wiring lands, the call site will be at the end of content-generation (per `BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md` Section "Integration with Bundle Factory pipeline"):

```typescript
// Stage 4 — post content-generation (Phase 2.2/2.4)
const decision = await runComplianceGate({
  bundle_draft_id: draft.id,
  title: generated.title,
  brand: draft.brand,
  bullets: generated.bullets,
  description: generated.description,
  browse_node: draft.browse_node,
  main_image_url: null,            // image rule fires in Stage 5
  bundle_components: draft.draft_components,
  skip_image_check: true,
}, { autoFix: true });
```

The Stage 5 image vision check then runs without `skip_image_check`. Phase 2.0 Compliance Gate is ready for both hook points.

## Tests + verification

* `scripts/smoke-research-pipeline.ts` — end-to-end smoke test against the dev DB using the mock fixture. Creates a throw-away draft, runs research, asserts pool size ≥ 3 + status transition + lifecycle log entry, then cleans up.
* `npx next build` passes on the branch (all 50+ routes generate).
* `npx tsc --noEmit` clean.

## What this phase does NOT do

* No Stage 3 (Variation Matrix) — that's Phase 2.2.
* No content generation (titles/bullets/description) — Phase 2.2/2.4.
* No image generation (main bundle hero image) — Phase 2.3.
* No SP-API/Walmart publication — Phase 2.5.
* No background job queue — Perplexity round-trip runs inline with `maxDuration=120`. Concurrency moves to BullMQ in Phase 5+.

## Operator runbook

1. Open `/bundle-factory/briefs`.
2. Click **+ New Brief**.
3. Walk Steps 1–4: idea + brand → category + composition → pack + channels → review → submit.
4. Land on `/bundle-factory/briefs/[id]` (status `DRAFT`).
5. Click **Run Research →** (typical ~30s; spinner + auto-poll keeps the page live).
6. Curate the pool — remove obvious misses with the Remove action.
7. Click **Continue to Variation Matrix →** when pool ≥ 5 items. Status flips to `VARIATION_SELECTED`. Phase 2.2 will pick up from here.
