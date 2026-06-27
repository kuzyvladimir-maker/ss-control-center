# Bundle Factory — Rebuild Plan (v1.0, 2026-06-27)

> Canonical step-by-step plan to rebuild Bundle Factory per the agreed listing
> logic. Owner sign-off: "делай!" 2026-06-27. Builds shared modules first so the
> [Listing Quality Stack](listing-quality-stack.md) is reused by Amazon/Walmart
> Growth, not copied. Each phase ends with a verifiable result.

## Phase 0 — Foundations (shared, under the hood)
- **0.1 Attribute registry** — machine-readable field list per product type
  (Amazon GROCERY default, PET_FOOD for pet; Walmart Food & Beverage), derived
  from the live schemas in `docs/marketplace-rules/*/_schemas/`, bundled into
  `src/lib/bundle-factory/attributes/`. The single contract for builder + QA Officer.
- **0.2 KB cleanup** — strip emoji/promo example bullets from the Amazon KB docs;
  generalize the KB loader.
- **0.3 Shared `brand-voice`** — collapse the 3 duplicate scrub copies into one lib.

## Phase 1 — Content from the catalog (adapt, don't invent)
- **1.1** Feed donor harvested content (title/bullets/description/nutrition/
  ingredients) into content generation; Claude ADAPTS in brand voice.
- **1.2** Allergen extraction from ingredients.
- **1.3** Product-type selection (default GROCERY; pet → PET_FOOD) + `item_type_keyword` + browse node.

## Phase 2 — Full attributes
- **2.1** Attribute filler — walk the registry, fill from catalog/KB/computed, mark gaps "needs data".
- **2.2** Extend Amazon (SP-API) + Walmart publish payloads to send the full set (ingredients, allergens, nutrition, COO, storage…).

## Phase 3 — Images (per `BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v1.0.md`)
- **3.1** Extend the free Codex/GPT-subscription worker to accept reference images (product refs + 2 frozen anchors).
- **3.2** Main image: frozen hero (branded gift set) for Amazon; non-frozen = clean product-on-white; secondary = real catalog photos.
- **3.3** Clean fallback main variant (in case Amazon auto-flags the hero).

## Phase 4 — Qualification Officer (Dept 5)
- **4.1** Pre-publish QA agent: checks each listing vs the marketplace KB
  (attribute completeness, brand-voice, image rules + the frozen 10-point
  checklist, IP). Blocks/flags before publish. Serves create AND improve.

## Phase 5 — Channels + flow polish
- **5.1** Channel gate: frozen/refrigerated → Amazon only; Walmart → shelf-stable only.
- **5.2** Richer start form (owner vision) + fix "build stops when you leave the page" (server-side generation).

## Phase 6 — Growth reuse
- **6.1** Switch Amazon Growth + Walmart Growth onto the shared modules (KB, attribute registry, brand-voice, QA Officer).

Critical path to the first HIGH-QUALITY Amazon listing: Phases 0→1→2→3→4.

## 🔗 Связи
- **Зависит от:** [Listing Quality Stack](listing-quality-stack.md), [Bundle Factory](bundle-factory.md).
- **Используется в:** [Amazon Growth](amazon-growth-roadmap.md), [Walmart Growth](walmart-growth-roadmap.md).

## История
- 2026-06-27 — план создан и подписан владельцем. Решение по товарной группе: GROCERY по умолчанию, PET_FOOD для кормов.
