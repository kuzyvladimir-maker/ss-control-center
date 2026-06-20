# Bundle Factory → Listing Studio (Phase 7)

> **Status:** Phase 7 in progress. Two backend seams shipped; the wizard/redesign
> below is the **approved-pending** plan (owner sign-off 2026-06-20).
> **Owner:** Vladimir. **Goal:** turn Bundle Factory from a fixed 7-stage
> pipeline into a configurable "Listing Studio" that builds NEW gift-set
> listings from the Reference/Donor Catalog, previews each one exactly as the
> marketplace will render it, and publishes only after human approval.

Related: [bundle-factory](bundle-factory.md) ·
[reference-catalog-engine](reference-catalog-engine.md) ·
[product-sourcing-engine](product-sourcing-engine.md) ·
[phase-2-0-compliance-gate](phase-2-0-compliance-gate.md) ·
[phase-2-4-validation](phase-2-4-validation.md) ·
[phase-2-5-distribution](phase-2-5-distribution.md) ·
[cogs-pricing-engine-roadmap](cogs-pricing-engine-roadmap.md) ·
[walmart-quantity-confusion-fix](walmart-quantity-confusion-fix.md)

---

## Why

The existing pipeline (Brief → Research → Variation → Content → Image →
Validation → Distribution) already produces listings, but it always sources
products from a live Perplexity search and always invents the price from a
markup. Phase 7 needs to:

1. Build listings from products we **already harvested** into the Donor /
   Reference Catalog (~990 rows, 5 retailer nets) — not a fresh web search.
2. Take the **selling price from the economics module** (≥20% margin), never
   invent it. See [cogs-pricing-engine-roadmap](cogs-pricing-engine-roadmap.md).
3. Give the operator a **configurable run** (source, set type, counts,
   variations, marketplace, LLM, image strategy) and a **preview-approve-edit**
   loop modeled on the A+ Content Factory, ending in a real marketplace upload.

Decision (2026-06-20): **gift-set bundles first**, **Amazon first**, **hybrid
photos** (donor photo + AI infographic). Price from economics, nothing
publishes without approval.

---

## Shipped (backend seams)

### 1. Donor → ResearchPool seed — `src/lib/bundle-factory/donor-pool.ts`

`seedPoolFromDonors({ bundle_draft_id, donor_product_ids[] })` is the
donor-sourced twin of `runResearch` ([phase-2-1-research](phase-2-1-research.md)).
Same ResearchPool shape, same R2 image mirror, same lifecycle bookkeeping — it
just reads selected `DonorProduct` rows instead of calling Perplexity. The COGS
basis (`avg_price_cents`) is the cheapest **first-party DIRECT** offer
(Instacart's ~+15% markup is excluded so the margin floor stays honest). It
never sets a selling price.

### 2. Margin floor validator — `validation/validators/validator-margin-floor.ts`

A 16th validator in [phase-2-4-validation](phase-2-4-validation.md). A SKU only
reaches `PASSED` (and only `PASSED` SKUs distribute), so this is the gate that
keeps un-priced / under-margin listings off the marketplace:

| Condition | Severity | Effect |
|---|---|---|
| `price_cents` not set | warning → NEEDS_REVIEW | not published (normal while economics fills price) |
| COGS basis unknown | warning → NEEDS_REVIEW | can't verify floor |
| margin < 20% | **error → FAILED** | hard-blocked from publish |
| margin ≥ 20% | pass | — |

`ValidatorInput.master_bundle` was extended with `estimated_cost_cents` (the
donor COGS) so the validator can compute margin = `(price − cost) / price`.
The selling price stays owned by the economics module.

---

## The Listing Studio (v2 design)

### Run configuration (the wizard's knobs)

A "studio run" is captured as a config object stored on `GenerationJob.brief`
(JSON). Each knob the owner asked for maps to one field:

```ts
StudioRunConfig {
  source:        "donor-catalog" | "new-brand-theme"
  donor_ids?:    string[]                    // when source = donor-catalog
  brief?:        { brand, theme, hints[] }   // when source = new-brand-theme
  set_type:      "multipack" | "thematic"    // multipack-as-giftset | mixed gift set
  listings_count: number                     // how many listings to produce
  variations:     number                     // variants per listing (VariationMatrix)
  marketplace:    "amazon" | "walmart"       // one first; multi later
  house_brand:    "Salutem Vita" | "Starfit"
  text_model:     "opus" | "sonnet"          // mirrors A+ selector
  image_strategy: "reuse-donor" | "generate"
  image_model?:   "gpt-image-1" | "gpt-image-2" | "smart"  // when generate
}
```

### Flow (per run)

```
Wizard (config above)
  └─ source = new-brand-theme OR donor pool too small for listings_count?
        → "Pull missing products" modal: POST /api/reference-catalog/enqueue
          {targetType, target, source:"bundle-factory"} → poll until done
          (reuses the sourcing engine; respects the $100/mo budget guard)
  └─ for each of listings_count:
        create BundleDraft (house_brand, set_type, marketplace)
        seedPoolFromDonors(draft, donor_ids)        ← donor path (shipped)
        generateVariations(variations)              ← existing
        select variant                              ← existing / auto for multipack
        generateContent(text_model)                 ← existing + Compliance Gate
        images:
          reuse-donor → tiled collage of donor R2 photos as main
                        (gift-set shows ALL items, not one donor front)
          generate    → image_model (gpt-image-1 cheap / gpt-image-2 / smart)
          + AI infographic secondary (qty / what's-inside, white bg, NO logos)
        reserve UPC from pool                        ← existing (owned prefixes)
        validate (15 + margin-floor)                 ← existing + shipped seam
  └─ Studio results: list of draft listings, each with a
     MARKETPLACE-ACCURATE PREVIEW (Amazon PDP / Walmart mock — real HTML, not a
     screenshot), violation badges, Approve / Edit / Regenerate (text|images)
  └─ Approve → publish (dry-run first), Amazon Listings PUT / Walmart feed
     ([phase-2-5-distribution](phase-2-5-distribution.md))
```

### Reused building blocks (don't rebuild)

| Need | Reuse |
|---|---|
| Preview/approve/edit UX, model selectors, status FSM | A+ Content Factory (`AmazonAplusJob`, `AplusFactory.tsx`, `qualify()`) — copy the pattern |
| Marketplace-accurate preview | A+ renders real HTML in Amazon's PDP text color; do the same for a listing PDP (title, gallery, About-this-item bullets, price) |
| Content + brand-voice + IP gate | [phase-2-0-compliance-gate](phase-2-0-compliance-gate.md) (8 rules: foreign-brand title block, disclaimer auto-inject, promo/health words, image vision) |
| Donor source + COGS | `donor-pool.ts` (shipped) |
| Margin rule | `validator-margin-floor.ts` (shipped) |
| Pull missing products | `/api/reference-catalog/enqueue` + cron worker + `enrichTarget()` ([product-sourcing-engine](product-sourcing-engine.md)) |
| UPC codes | UPCPool (owned GS1 prefixes 742259/789232/617261; reserve 24h → assign). Replenish: `scripts/seed-upc-pool-available.ts --per-prefix 1000` |

### UPC reality (the flagged "where do codes come from")

We own GS1 prefixes via SpeedyBarCode; the pool is generated/seeded, reserved
per draft (24h TTL) and assigned on promotion. **No per-bundle purchase
needed.** The wizard surfaces pool availability and warns when low; the
operator tops up with the seed script. `GTINExemption` exists as a model but
has no enforcement code yet — an exemption path is a future option, not needed
for gift-set listings that consume an owned UPC.

### Compliance / IP (always on)

Every generated listing passes the Compliance Gate + validators before it can
be approved; violations show in the preview and disable the Approve button
(A+ pattern). Title policy (no foreign brands under our house brand), the
curated/assembler disclaimer (exact wording in
`remediation/disclaimer-text.ts`), no emoji / promo adjectives / health claims,
gift-basket positioning — all already encoded. Walmart quantity-confusion fix
([walmart-quantity-confusion-fix](walmart-quantity-confusion-fix.md)) applies
when the Walmart channel is built.

---

## Build order (phased)

- **A — Studio orchestrator** (backend): `StudioRunConfig` + a runner that
  fans a config into N drafts and routes source (donor vs enrichment),
  threading model + image strategy. Mostly safe glue over existing stages.
- **B — Wizard UI**: the config form (source / set-type / counts / variations /
  marketplace / model / image strategy) + the "pull missing products" modal.
- **C — Preview / approve**: marketplace-accurate PDP preview + approve / edit /
  regenerate per listing (A+ pattern), with violation badges.
- **D — Publish**: Amazon first, dry-run → approval-gated real upload; status
  poll. Walmart channel + quantity-confusion images next.

Nothing publishes without explicit owner approval; every publish step defaults
to dry-run.

---

**Maintained by:** Vladimir + Claude · **Created:** 2026-06-20
