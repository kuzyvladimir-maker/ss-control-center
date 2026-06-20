# 🎨 Phase 2.3 — Image Generation

> **Started:** 2026-05-19 · **Status:** Shipped (Stage 5 main bundle image via gpt-image-1 + R2 hosting + vision-gated retry loop)
> **Spec:** continuation of Phase 2.2 — picks up `BundleDraft.status=GENERATED`

---

## TL;DR

For each draft that finished content generation, the pipeline asks OpenAI **gpt-image-1** to render a single 1024×1024 main bundle photograph. The result is uploaded to **Cloudflare R2** under `prod/<slug>/main<attemptSuffix>.png`, and a `runComplianceGate({ skip_image_check: false })` pass is fired so **Rule 6 (vision check)** can inspect the rendered image for foreign-brand logos. On rejection, the next attempt re-prompts gpt-image-1 with an explicit negative list built from `detected_logos`. Up to **3 attempts total** (`MAX_IMAGE_RETRIES`); past that the draft sticks at `manual_review_required=true` for the operator.

## Pipeline shape

```
GENERATED draft  →  user (or auto-trigger) clicks "Generate image →"
   ↓ status → IMAGE_GENERATING
Stage 5 — generate-images endpoint
   ↓ attempt = 1
   ↓   buildFinalPrompt({ style, composition, attempt, detected_logos }) →
   ↓     attempt ≥ 2 prepends a CRITICAL negative listing the brands
   ↓     the previous attempt's compliance gate flagged
   ↓   POST OpenAI images.generations (model=gpt-image-1, size=1024×1024)
   ↓   PUT to R2 → main_image_url
   ↓   runComplianceGate({ skip_image_check: false, main_image_url })
   ↓     Rule 6 (vision-check) calls Anthropic Vision; returns detected_logos[]
   ↓   if BLOCKED & attempt < 3  →  retry with stronger negative
   ↓   if CAN_PUBLISH            →  status = IMAGE_GENERATED, exit
   ↓   if BLOCKED & attempt = 3  →  manual_review_required=true, status stays
```

## Module surface

```
src/lib/bundle-factory/
├── image-generation.ts   ← OpenAI client + R2 upload primitive
│                           - MODEL_NAME = "gpt-image-1"
│                           - COST_USD_BY_SIZE["1024x1024"] = 0.04
│                           - buildFinalPrompt() composes the prompt;
│                             on attempt ≥ 2 inserts:
│                               "CRITICAL — previous attempt was rejected
│                                for showing branded packaging. Do NOT show
│                                any of these brand names/logos anywhere in
│                                the image: <banList>. Use entirely generic,
│                                unbranded packaging."
│                           - upload writes to R2 key
│                             prod/<slug>/main<attemptSuffix>.png
└── image-pipeline.ts     ← orchestrator: runImageGeneration(draftId)
                            - MAX_IMAGE_RETRIES = 3
                            - sets BundleDraft.status across the transitions
                            - persists each attempt's R2 url, cost, compliance
                              verdict, detected_logos
                            - on retry, feeds detected_logos into the next
                              buildFinalPrompt call
```

## API surface

| Method + URL | Purpose |
|---|---|
| `POST /api/bundle-factory/drafts/[id]/generate-images` | Stage 5 — full attempt loop. `maxDuration=300`. Idempotent for IMAGE_GENERATED drafts (returns existing). |
| `POST /api/bundle-factory/drafts/[id]/regenerate-image` | Force a fresh attempt loop, resets attempt counter. `maxDuration=300`. |

## BundleDraft.status transitions

```
GENERATED → IMAGE_GENERATING → IMAGE_GENERATED
                            ↘ (back to GENERATED with manual_review_required=true on exhaustion)
```

The intermediate `IMAGE_GENERATING` lets the UI distinguish in-flight work from completed work without polling the OpenAI/R2 endpoints directly.

## Compliance Gate integration (Rule 6 activation)

This is the first stage where the gate runs with `skip_image_check: false`. Rule 6 (`detectForeignLogosInImage` from `audit/vision-check.ts`) uses Anthropic Vision against the **just-uploaded R2 URL** — Vladimir's own brands and the generic-deli ignorelist are whitelisted; foreign brand logos count.

On `BLOCKED` verdict, the compliance check row records `detected_logos: ["Oscar Mayer", "Bird's Eye", …]`. The orchestrator reads that list out of the verdict and threads it through to the next `buildFinalPrompt` call so the model is told **by name** what to avoid.

```typescript
const verdict = await runComplianceGate(
  {
    bundle_draft_id: draft.id,
    main_image_url:  uploadedUrl,
    title:           generated.title,
    bullets:         generated.bullets,
    description:     generated.description,
    bundle_components: variant.composition,
    skip_image_check: false,
  },
  { autoFix: false, actor: "image-pipeline" },
);
```

Note: `autoFix: false` — Rule 6 has no fixer; the only recourse is re-generation with a better prompt.

## Cost model

* gpt-image-1 @ 1024×1024 = **$0.04 / image** (`COST_USD_BY_SIZE`).
* R2 PUT + storage is negligible (CDN egress only happens when shoppers / Amazon fetch the image).
* Vision check cost (Anthropic Vision) lives in Phase 2.0 Rule 6 — ~$0.003 / call.
* Worst case (3 attempts) → 3 × ($0.04 + $0.003) ≈ **$0.13 / draft**.
* Median case (1 attempt) → ~$0.043 / draft.

At 1000 drafts/month with ~30% retry rate, this lands around **$50–60/mo**.

## Manual review trigger

The pipeline sets `manual_review_required=true` and leaves `compliance_status=BLOCKED` once `MAX_IMAGE_RETRIES` is reached. The draft is left at `GENERATED` (image stages reverted) so the operator can either:

* Adjust the variant composition (different items → different reference logos)
* Override the rule manually via Compliance UI (logged as `actor:manual_override`)
* Re-trigger via `/regenerate-image` after composition changes

## What this phase does NOT do

* No additional gallery images, lifestyle shots, or A+ Content rendering — only the **main image** lands here. The 6× lifestyle slot is deferred.
* No image dimension / format / colour-space validation here — that's Phase 2.4 (validators `image-dimensions`, `image-format`).
* No second-pass watermark/text overlay — gpt-image-1 output is shipped as-is.
* No model fallback (Higgsfield, SDXL, etc.) — single model only.
* No background job queue — runs inline with `maxDuration=300`.

## Operator runbook

1. From the draft detail page (after Phase 2.2 GENERATED), click **Generate image** (or it auto-triggers when configured).
2. Watch the per-attempt log — each attempt records prompt + R2 URL + detected_logos.
3. If the badge stays BLOCKED after attempt 3, check the detected_logos list; either tweak the composition (drop the offending brand from the variant) or override in Compliance UI.
4. When the badge flips to CAN_PUBLISH (status=IMAGE_GENERATED), Phase 2.4 (Validation) is the next stage.

## Vladimir's to-do list after merge

1. **Env vars** — `OPENAI_API_KEY` + `R2_*` already wired in Phase 2.1 (mirror) and Phase 2.6.3 spec. No new keys.
2. **No Turso migration** — the columns this stage writes (`main_image_url`, image-attempt counters) live on `BundleDraft` and were added in Phase 2.1 image-mirror schema.
3. **OpenAI billing alert** — at $0.04/image the bill is bounded but real; set a $50/mo alert on the OpenAI dashboard.

## Связано с
- [Phase 2.4 — Validation Pipeline](phase-2-4-validation.md) — следующий этап pipeline
- [Cloudflare R2 Setup Guide](cloudflare-r2-setup.md) — хранилище сгенерированных картинок
