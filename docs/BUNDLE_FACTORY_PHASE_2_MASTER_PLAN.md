# Bundle Factory — Phase 2 Master Plan (Revised)

> **Created:** 2026-05-17
> **Last updated:** 2026-05-17 (revised scope: Amazon + Walmart only, no TikTok)
> **Status:** Phase 1 ✅ complete; Phase 2.1 next
> **Total est. work:** ~25-35 hours of Claude Code autonomous execution, split across 5 sub-phases

---

## 🎯 Phase 2 Overview (revised)

Phase 2 = **actual AI generation pipeline для Amazon + Walmart**. Turns Bundle Factory from "scaffolded shell с empty tables" (Phase 1 result) в working concept-to-listing engine: Vladimir вводит idea → AI выдаёт published listings на Amazon × 5 + Walmart.

### Scope clarifications (revised 2026-05-17)

✅ **In scope для Phase 2:**
- Stage 1-7 AI pipeline implementation
- Distribution: **Amazon (× 5 accounts) + Walmart** = 6 channel SKUs per MasterBundle
- Image strategy: **1 AI-generated main image** + **3-5 scraped + mirrored secondary images** (download to Cloudflare R2)
- Content: title + bullets + description per channel (Amazon SP-API + Walmart Items API)

❌ **Out of scope для Phase 2 (отложено к Phase 3-4):**
- eBay listings
- TikTok Shop listings
- TikTok video generation (Higgsfield)
- AI generation для secondary images (используем готовые из retail/manufacturer sites)

### Why 6 channels, не 9

Vladimir focuses на **highest-volume channels first** для proof of concept:
- Amazon × 5: основная revenue источник, Brand Registry protections, sticky listings
- Walmart: вторая по volume, complementary audience
- eBay: lower volume, можно добавить позже когда инфраструктура proven
- TikTok: requires creator content + video — capital-intensive entry, лучше после Amazon/Walmart success

---

## 📋 Sub-phase breakdown

### Phase 2.1 — Brief + Research + Image Mirror (Stages 1, 2, 2.5)

**Status:** 🟢 Ready to execute (prompt at `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_2_1.md`)
**Estimated time:** 6-8 hours

**Что Vladimir получает:**
- Multi-step form: вводит идею → выбирает category, composition, pack count, target channels (default = Amazon + Walmart)
- One-click "Run Research" → Perplexity API ищет products + image URLs в radius 10mi (37 stores)
- ResearchPool populates с 10-25 candidates + reference image URLs за ~30s
- **Stage 2.5 (NEW)**: Background job downloads images из retail sites → uploads в Cloudflare R2 → replaces URLs в DB с R2 URLs
- Vladimir может edit / delete items, override AI guesses
- Transition: DRAFT → RESEARCHED

**Dependencies:**
- Phase 1 foundation ✅
- Perplexity API key
- Cloudflare R2 bucket (можно отложить — Stage 2.5 implements но не critical для Phase 2.1 testing; для production нужен)

---

### Phase 2.2 — Variation Matrix + Content Generation (Stages 3-4)

**Status:** ⚪ Waiting for Phase 2.1 deliverables
**Estimated time:** 8-10 hours

**Что делает:**
- AI generates 5-10 bundle composition variants из ResearchPool:
  - Variant A: 12× Pepperoni pizza
  - Variant B: 6× Pepperoni + 6× Cheese
  - Variant C: 4× each of Pepperoni / Cheese / Ham
  - etc.
- Vladimir picks variant → AI generates per-channel content:
  - Title (200 chars Amazon, 75 chars Walmart)
  - Bullets (5 для Amazon с Vladimir's emoji pattern; adapted plain text для Walmart)
  - Description (HTML for Brand Registry, plain for Walmart)
- Each Marketplace Rules KB файл (45 files) loaded as context для AI prompts
- Status: RESEARCHED → VARIATION_SELECTED → GENERATED

**Key technical:**
- Claude API integration (Vladimir's existing Anthropic credentials)
- KB loader util reads markdown files и injects в system prompts
- **Prompt caching enabled** для KB context (saves 60% Claude API costs)
- Each variant evaluated на cost / margin / feasibility перед presentation

---

### Phase 2.3 — Main Image Generation (Stage 5)

**Status:** ⚪ Waiting for Phase 2.2
**Estimated time:** 4-6 hours

**Что делает:**
- OpenAI gpt-image-1 generates **1 main image only** per bundle:
  - Branded gift box ("Salutem Solutions GIFT SET N COUNT" packaging)
  - White background (Amazon RGB 255, Walmart RGB 240+)
  - Component products visible inside open box
  - 1500×1500 (Walmart-compliant minimum)
- Generated image → uploaded to Cloudflare R2 → URL stored в `MasterBundle.main_image_url`
- **Secondary images** (3-5) уже mirrored в R2 во время Stage 2.5 — просто re-used здесь
- Status: GENERATED + has main_image_url

**Key technical:**
- OpenAI API integration
- Cloudflare R2 SDK (S3-compatible, used `@aws-sdk/client-s3`)
- Image prompt template из `marketplace-rules/amazon/image-requirements.md`
- Re-generation logic (max 2 retries если первый result не passes validation)

**Cloudflare R2 setup prerequisite:** see `docs/wiki/cloudflare-r2-setup.md`

---

### Phase 2.4 — Validation (Stage 6)

**Status:** ⚪ Waiting for Phase 2.3
**Estimated time:** 4-6 hours

**Что делает:**
- 15+ compliance validators run против KB rules:
  - Title length per channel
  - Forbidden keywords (consolidated from `prohibited-keywords.md`)
  - Image requirements (resolution, white background, no text overlay)
  - Allergen disclosure
  - Browse node correctness
  - GTIN/UPC validity
  - Bundle composition rules (Gift Basket Exception eligibility)
  - A-to-Z claim avoidance patterns
- Each validator returns `{ passed, issues[] }` → aggregated в `BundleDraft.validation_result` JSON
- If validation fails → block transition to APPROVED, show specific errors to Vladimir
- Status: GENERATED → APPROVED (or back to GENERATED для re-iteration)

**Key technical:**
- TypeScript validators в `src/lib/bundle-factory/validators/`
- Each KB file's pseudocode → actual code
- Validation runs synchronously после Stage 4-5 completion

---

### Phase 2.5 — Distribution: Amazon + Walmart (Stage 7)

**Status:** ⚪ Waiting for Phase 2.4
**Estimated time:** 6-8 hours (упрощённо vs original 8-12h — только 2 channels вместо 4)

**Что делает:**
- Для каждого target_channel создаёт ChannelSKU и pushes к marketplace API:
  - **5× Amazon accounts** — SP-API `putListingsItem` через JSON Listings v2
  - **Walmart** — Items API `MPItemFeed`
- Каждый channel's submission tracked в ChannelSKU.lifecycle_status
- Webhook listeners для async processing (Amazon takes 1-4 hours для listing to go live; Walmart similar)
- Status: APPROVED → SUBMITTED → PROCESSING → LIVE (или ERROR с retry queue)

**Key technical:**
- Per-channel API clients (existing Vladimir's SP-API integration)
- Webhook endpoints для status updates
- Retry logic для transient failures
- Cross-account synchronization (5 Amazon accounts с synced pricing)

**Не входит в Phase 2.5:**
- eBay distribution → Phase 3
- TikTok Shop distribution → Phase 3
- TikTok video upload → Phase 4

---

## 📊 Cumulative deliverable timeline

| Sub-phase | Cumulative status |
|---|---|
| Phase 1 ✅ | Empty Bundle Factory shell (tables + UI placeholders) |
| Phase 2.1 | Vladimir can do **research + image mirror** — find products + cache reference images |
| Phase 2.2 | Vladimir can **generate full listing content** для Amazon + Walmart |
| Phase 2.3 | Vladimir gets **AI-generated main product image** в R2 |
| Phase 2.4 | Bundle is **validated against all 45 KB rules** — ready to publish |
| Phase 2.5 | Bundle **auto-publishes** to 6 channels (Amazon × 5 + Walmart) |

After Phase 2.5: **complete end-to-end automation для Amazon + Walmart**. Vladimir вводит idea → 6 listings live за ~10 minutes.

---

## ⏰ Realistic timeline

Если Vladimir работает с темпом "1 sub-phase per day":

| Day | Activity |
|---|---|
| Day 1 (today) | Phase 2.1 implementation (Claude Code 6-8h) |
| Day 2 | Phase 2.1 review + production deploy + Perplexity API key setup |
| Day 3 | Phase 2.2 implementation (Claude Code 8-10h) |
| Day 4 | Phase 2.2 review + test full content generation |
| Day 5 | Cloudflare R2 setup (Vladimir 10 min) + Phase 2.3 implementation (Claude Code 4-6h) |
| Day 6 | Phase 2.4 implementation (validators) |
| Day 7 | Phase 2.5 implementation (Amazon + Walmart APIs) |
| Day 8 | End-to-end testing + first live published bundle |

**~1 week real-world time от Phase 1 done до first auto-published bundle.**

Если хочешь spread out — easily 2-3 weeks comfortable pace.

---

## 🚧 Decision points (Vladimir review checkpoints)

После каждого sub-phase Vladimir решает:
1. **Continue к следующему** (default — если quality satisfactory)
2. **Polish current sub-phase** (если есть unfixed bugs или UX issues)
3. **Pause overall progress** (если нужно validate business assumptions)

---

## 💰 Cost projections (revised)

См. `BUNDLE_FACTORY_COST_ANALYSIS.md` для полного breakdown. TL;DR:

| Volume | Monthly cost (Lean tier с optimization) |
|---|---|
| 1000 bundles | $300/mo |
| 3000 bundles | $800/mo |
| 5000 bundles | $1,300/mo |

Per-bundle: **$0.15-0.32** depending on optimization level.

---

## 📚 Related documents

- `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_2_1.md` — detailed prompt для Phase 2.1 implementation
- `BUNDLE_FACTORY_COST_ANALYSIS.md` — full budget breakdown
- `wiki/cloudflare-r2-setup.md` — R2 storage setup guide (одно-разовый setup)
- `PHASE_1_COMPLETION_REPORT.md` — что было сделано в Phase 1
- `BUNDLE_FACTORY_CONCEPT_v1_0.md` — overall pipeline concept
- `marketplace-rules/` — 45 KB файлов, читаемых Stage 4 / Stage 6

---

**Maintained by:** Vladimir + Claude · **Last updated:** 2026-05-17
