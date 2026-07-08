/**
 * Phase 2.2 Stage 3 — Variation Matrix generator.
 *
 * Given a curated ResearchPool for a BundleDraft, produce 5–10
 * composition variants. The generator is **deterministic** (no AI call,
 * $0 cost). Variants are constructed from the top-freshness items in
 * the pool, weighted by `composition_type`:
 *
 *   SINGLE_FLAVOR    → 1 variant: the highest-freshness item × pack_count
 *   MIXED_FLAVOR     → variants spanning top 2–4 items, varying split
 *   USE_CASE         → variants that pair complementary storage types
 *   HOLIDAY_THEMED   → same as USE_CASE for now (manual curation expected)
 *   CROSS_BRAND      → variants that maximise brand diversity
 *
 * For each variant we compute:
 *   - cost_cents             = Σ(avg_price_cents × qty)
 *   - suggested_price_cents  = round(cost × DEFAULT_MARKUP_X / 0.5) × 0.5  (rounded to nearest 50¢)
 *   - margin_cents           = suggested_price - cost
 *   - margin_pct             = margin / suggested_price
 *   - feasibility_score      = mean(component freshness_score)
 *
 * `feasibility_score` doubles as the sort key: most-likely-in-stock
 * variants surface first in the UI.
 */

import type { CompositionType } from "./enums";

/**
 * Subset of ResearchPool we need — keeping the input loose so callers
 * (route handler, unit tests) can pass either Prisma model instances
 * or hand-built fixtures.
 */
export interface ResearchPoolItem {
  id: string;
  product_name: string;
  brand: string;
  avg_price_cents: number | null;
  freshness_score: number | null;
  storage_temp: string | null;
  pack_sizes: string | null; // JSON array, may be null
  flavors: string | null; // JSON array, may be null
}

export interface VariantComponent {
  research_pool_id: string;
  product_name: string;
  brand: string;
  qty: number;
  unit_price_cents: number;
  /** Retail pack sizes this flavor really ships in (e.g. [15,10,4]) — drives
   *  the MAIN-image exact-box rule (boxes only when qty splits with no
   *  remainder; otherwise loose individually-wrapped pieces). */
  retail_pack_sizes?: number[];
}

export interface Variant {
  idx: number;
  name: string;
  composition: VariantComponent[];
  cost_cents: number;
  suggested_price_cents: number;
  margin_cents: number;
  margin_pct: number;
  feasibility_score: number;
  notes: string;
}

export interface GenerateVariantsInput {
  pool: ResearchPoolItem[];
  composition_type: CompositionType;
  pack_count: number;
  /** Default 2.5×. Vladimir-tunable per draft via the API later. */
  markup_multiplier?: number;
}

const DEFAULT_MARKUP = 2.5;
const MIN_VARIANTS = 1; // SINGLE_FLAVOR may legitimately produce just one
const MAX_VARIANTS = 10;
const PRICE_ROUND_STEP_CENTS = 50;

/**
 * Generate the variant set for a draft. Throws when pool is too small
 * for the composition type — callers should validate before invoking.
 */
export function generateVariants(input: GenerateVariantsInput): Variant[] {
  const pack = input.pack_count;
  if (!Number.isFinite(pack) || pack < 2) {
    throw new Error(`pack_count must be ≥ 2, got ${pack}`);
  }
  const markup = input.markup_multiplier ?? DEFAULT_MARKUP;

  // Sort pool: highest freshness first, then by lowest price (stable).
  const ranked = [...input.pool]
    .filter((p) => (p.avg_price_cents ?? 0) > 0)
    .sort((a, b) => {
      const fa = a.freshness_score ?? 0;
      const fb = b.freshness_score ?? 0;
      if (fb !== fa) return fb - fa;
      return (a.avg_price_cents ?? 0) - (b.avg_price_cents ?? 0);
    });

  if (ranked.length === 0) {
    throw new Error(
      "Research pool has no items with avg_price_cents — cannot generate variants",
    );
  }

  const variants: Variant[] = [];

  switch (input.composition_type) {
    case "SINGLE_FLAVOR":
      variants.push(
        buildVariant({
          idx: 0,
          name: `Single — ${pack}× ${ranked[0].product_name}`,
          notes: "Single best-availability item, full pack.",
          assignments: [{ item: ranked[0], qty: pack }],
          markup,
        }),
      );
      break;

    case "MIXED_FLAVOR":
      // 2-way 50/50, 2-way 60/40, 3-way even, 4-way even (when pool allows).
      variants.push(
        buildEvenSplitVariant(ranked, 2, pack, markup, "A — 50/50 split"),
      );
      if (ranked.length >= 2) {
        variants.push(
          buildWeightedSplitVariant(
            ranked,
            [0.6, 0.4],
            pack,
            markup,
            "B — 60/40 split",
          ),
        );
      }
      if (ranked.length >= 3) {
        variants.push(
          buildEvenSplitVariant(ranked, 3, pack, markup, "C — Even 3-way"),
        );
      }
      if (ranked.length >= 4 && pack >= 8) {
        variants.push(
          buildEvenSplitVariant(ranked, 4, pack, markup, "D — Even 4-way"),
        );
      }
      break;

    case "CROSS_BRAND":
      variants.push(
        ...buildCrossBrandVariants(ranked, pack, markup),
      );
      break;

    case "USE_CASE":
    case "HOLIDAY_THEMED":
      // Pair complementary storage types (one shelf-stable + one cold)
      // when available; otherwise fall through to MIXED_FLAVOR-style.
      variants.push(...buildUseCaseVariants(ranked, pack, markup));
      break;

    default:
      // Defensive: an unknown composition type still yields variants.
      variants.push(
        buildEvenSplitVariant(ranked, 2, pack, markup, "Default 50/50"),
      );
  }

  // Always include the "Single best" option as a safe baseline.
  if (
    variants.length < MAX_VARIANTS &&
    !variants.some((v) => v.composition.length === 1)
  ) {
    variants.push(
      buildVariant({
        idx: 0,
        name: `Baseline — ${pack}× ${ranked[0].product_name}`,
        notes: "Single-item baseline (always include for safety).",
        assignments: [{ item: ranked[0], qty: pack }],
        markup,
      }),
    );
  }

  return variants
    .slice(0, MAX_VARIANTS)
    .map((v, i) => ({ ...v, idx: i }))
    .filter((v) => v.composition.length >= MIN_VARIANTS);
}

// ── Composition builders ─────────────────────────────────────────────────

function buildEvenSplitVariant(
  ranked: ResearchPoolItem[],
  splitCount: number,
  pack: number,
  markup: number,
  label: string,
): Variant {
  const items = ranked.slice(0, splitCount);
  const baseQty = Math.floor(pack / splitCount);
  const remainder = pack - baseQty * splitCount;
  const assignments = items.map((item, i) => ({
    item,
    qty: baseQty + (i < remainder ? 1 : 0),
  }));
  return buildVariant({
    idx: 0,
    name: `Variant ${label}`,
    notes: `Top ${splitCount} pool items split evenly.`,
    assignments,
    markup,
  });
}

function buildWeightedSplitVariant(
  ranked: ResearchPoolItem[],
  weights: number[],
  pack: number,
  markup: number,
  label: string,
): Variant {
  const items = ranked.slice(0, weights.length);
  const rawQtys = weights.map((w) => Math.round(w * pack));
  // Fix rounding drift so qtys sum to pack.
  const diff = pack - rawQtys.reduce((a, b) => a + b, 0);
  if (diff !== 0) rawQtys[0] += diff;
  const assignments = items.map((item, i) => ({
    item,
    qty: Math.max(1, rawQtys[i]),
  }));
  return buildVariant({
    idx: 0,
    name: `Variant ${label}`,
    notes: `Weighted split (${weights.map((w) => Math.round(w * 100)).join("/")}).`,
    assignments,
    markup,
  });
}

function buildCrossBrandVariants(
  ranked: ResearchPoolItem[],
  pack: number,
  markup: number,
): Variant[] {
  // Take one item per distinct brand, in freshness order.
  const seenBrands = new Set<string>();
  const distinct: ResearchPoolItem[] = [];
  for (const p of ranked) {
    const key = (p.brand || "").toLowerCase().trim();
    if (!key || seenBrands.has(key)) continue;
    seenBrands.add(key);
    distinct.push(p);
    if (distinct.length >= 6) break;
  }

  const variants: Variant[] = [];
  if (distinct.length >= 2) {
    variants.push(
      buildEvenSplitVariant(distinct, 2, pack, markup, "X — 2-brand variety"),
    );
  }
  if (distinct.length >= 3) {
    variants.push(
      buildEvenSplitVariant(distinct, 3, pack, markup, "Y — 3-brand variety"),
    );
  }
  if (distinct.length >= 4 && pack >= 8) {
    variants.push(
      buildEvenSplitVariant(distinct, 4, pack, markup, "Z — 4-brand variety"),
    );
  }
  return variants;
}

function buildUseCaseVariants(
  ranked: ResearchPoolItem[],
  pack: number,
  markup: number,
): Variant[] {
  // Try to pair items across storage temps (one cold + one ambient) so
  // the resulting bundle reads as a "use-case" (e.g. lunch = entree +
  // drink). Fall back to MIXED_FLAVOR-style if temps don't vary.
  const variants: Variant[] = [];

  const cold = ranked.filter(
    (p) => p.storage_temp === "Frozen" || p.storage_temp === "Refrigerated",
  );
  const ambient = ranked.filter((p) => p.storage_temp === "Ambient");

  if (cold.length >= 1 && ambient.length >= 1) {
    variants.push(
      buildVariant({
        idx: 0,
        name: `Variant U1 — ${cold[0].product_name} + ${ambient[0].product_name}`,
        notes: "Cold + ambient pairing (use-case bundle).",
        assignments: [
          { item: cold[0], qty: Math.ceil(pack / 2) },
          { item: ambient[0], qty: Math.floor(pack / 2) },
        ],
        markup,
      }),
    );
  }

  variants.push(
    buildEvenSplitVariant(ranked, 2, pack, markup, "U2 — Even 50/50"),
  );
  if (ranked.length >= 3) {
    variants.push(
      buildEvenSplitVariant(ranked, 3, pack, markup, "U3 — Even 3-way"),
    );
  }

  return variants;
}

// ── Cost / margin / feasibility ──────────────────────────────────────────

function buildVariant(input: {
  idx: number;
  name: string;
  notes: string;
  assignments: Array<{ item: ResearchPoolItem; qty: number }>;
  markup: number;
}): Variant {
  const composition: VariantComponent[] = input.assignments.map((a) => ({
    research_pool_id: a.item.id,
    product_name: a.item.product_name,
    brand: a.item.brand,
    qty: a.qty,
    unit_price_cents: a.item.avg_price_cents ?? 0,
  }));

  const cost = composition.reduce(
    (sum, c) => sum + c.unit_price_cents * c.qty,
    0,
  );
  const suggestedRaw = cost * input.markup;
  const suggested =
    Math.round(suggestedRaw / PRICE_ROUND_STEP_CENTS) * PRICE_ROUND_STEP_CENTS;
  const margin = Math.max(0, suggested - cost);
  const marginPct = suggested > 0 ? margin / suggested : 0;

  const freshnessSum = input.assignments.reduce(
    (s, a) => s + (a.item.freshness_score ?? 0) * a.qty,
    0,
  );
  const totalQty = input.assignments.reduce((s, a) => s + a.qty, 0);
  const feasibility = totalQty > 0 ? freshnessSum / totalQty : 0;

  return {
    idx: input.idx,
    name: input.name,
    composition,
    cost_cents: cost,
    suggested_price_cents: suggested,
    margin_cents: margin,
    margin_pct: marginPct,
    feasibility_score: Math.round(feasibility),
    notes: input.notes,
  };
}
