/**
 * Phase 7 — prompt-driven mass generator engine.
 *
 * Drives a batch (GenerationJob) forward one unit of work per `tickBatch`
 * call so the client can poll and show live progress (done / total + the
 * step running right now). Serverless-friendly: every tick is a short request.
 *
 *   PENDING  → first tick parses the prompt + sources products, sets the total.
 *   RUNNING  → each tick builds ONE listing (content via Claude, donor photo),
 *              writing a BundleDraft and bumping bundles_generated.
 *   COMPLETED/FAILED → terminal.
 *
 * Progress is reported via GenerationJob: bundles_target (total),
 * bundles_generated (done), bundles_error, and `notes` (JSON: the engine plan
 * + the current step label the UI renders).
 */

import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";
import { runContentGeneration } from "./content-pipeline";
import { resolveListingBrand, isOwnBrandPassthrough } from "./own-brand";
import type { Variant, VariantComponent } from "./variation-matrix";
import { planVariations, type VariationSpec } from "./variation-planner";
import { dedupeDonorFlavors, donorUnitPriceCents } from "./donor-dedup";
import { getPricingModel } from "./pricing-config";
import { computeListingPrice } from "./listing-pricing";
import {
  legacyRecipeAliasFingerprint,
  resolveLegacyRecipeAlias,
  type RecipeAliasInput,
} from "./legacy-recipe-dedup";

export interface BatchProgress {
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  phase: "queued" | "sourcing" | "building" | "done" | "error";
  step: string; // human label for "what's happening right now"
  total: number; // listings to build
  done: number; // listings built (incl. failed)
  failed: number;
  skipped?: number;
  done_flag: boolean; // true when nothing more to do
}

interface EnginePlan {
  count: number;
  theme: string;
  pack_count: number;
  donor_ids: string[];
  listing_brand?: string;
  /** The combinatorial matrix — one entry per listing to build (P2). */
  specs: VariationSpec[];
}

interface EngineState {
  plan?: EnginePlan;
  progress: BatchProgress;
}

const MAX_WORK_ATTEMPTS = 3;
const STALE_LOCK_MS = 10 * 60_000;

/** Stable logical recipe identity (independent of donor row ids, which catalog
 * enrichment may replace). Visible for deterministic unit tests. */
export function recipeFingerprint(
  brand: string,
  spec: Pick<VariationSpec, "composition_type" | "unit_count" | "flavor_labels" | "quantities">,
): string {
  const components = spec.flavor_labels
    .map((flavor, i) => ({
      flavor: flavor.toLowerCase().replace(/\s+/g, " ").trim(),
      qty: spec.quantities[i] ?? 0,
    }))
    .sort((a, b) => a.flavor.localeCompare(b.flavor));
  return createHash("sha256")
    .update(JSON.stringify({
      brand: brand.toLowerCase().trim(),
      composition_type: spec.composition_type,
      unit_count: spec.unit_count,
      components,
    }))
    .digest("hex");
}

// ── Prompt parsing (heuristic — cheap, no LLM) ──────────────────────────────

const STOPWORDS = new Set([
  "gift", "gifts", "set", "sets", "basket", "baskets", "bundle", "bundles",
  "multipack", "multipacks", "pack", "packs", "listing", "listings", "new",
  "in", "different", "variation", "variations", "variety", "the", "a", "an",
  "of", "with", "and", "for", "make", "create", "build", "generate",
  "создай", "создать", "сделай", "сгенерируй", "новых", "новые",
  "листинг", "листинга", "листингов", "карточки", "товаров", "вариантов",
]);

export function parsePrompt(prompt: string): { count: number; theme: string; pack_count: number } {
  const lower = prompt.toLowerCase();

  // Listing count is independent from the recipe pack count. Prefer a number
  // explicitly attached to "listings/ASINs" (including Russian prompts); only
  // then fall back to the first number after removing pack-size phrases.
  const countMatch =
    lower.match(/\b(\d{1,4})\s+(?:[\p{L}'-]+\s+){0,4}(?:listings?|asins?|products?)\b/u) ||
    lower.match(/(?:listings?|asins?)\s*[:=x-]?\s*(\d{1,4})\b/) ||
    lower.match(/\b(\d{1,4})\s+(?:[\p{L}'-]+\s+){0,4}(?:листинг(?:а|ов)?|asin(?:ов)?)\b/u) ||
    lower.match(/(?:листинг(?:а|ов)?|asin(?:ов)?)\s*[:=x-]?\s*(\d{1,4})\b/u) ||
    lower
      .replace(/pack of \d{1,2}/g, " ")
      .replace(/\d{1,2}\s*-?\s*pack/g, " ")
      .replace(/\d{1,2}\s*(?:count|ct)\b/g, " ")
      .match(/\b(\d{1,4})\b/);
  let count = countMatch ? parseInt(countMatch[1], 10) : 5;
  count = Math.max(1, Math.min(500, count)); // mass generation: up to 500 listings

  // Pack size = "pack of N" / "N-pack" / "N count". Default 6.
  const packMatch =
    lower.match(/pack of (\d{1,2})/) ||
    lower.match(/(\d{1,2})\s*-?\s*pack/) ||
    lower.match(/(\d{1,2})\s*count/);
  let pack_count = packMatch ? parseInt(packMatch[1], 10) : 6;
  pack_count = Math.max(2, Math.min(50, pack_count));

  // Theme = remaining significant tokens (drop the count + stopwords).
  const theme = prompt
    .replace(/\b\d{1,4}\b/g, " ")
    .split(/[^\p{L}\p{N}'&-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()))
    .join(" ")
    .trim();

  return { count, theme: theme || prompt.trim(), pack_count };
}

// ── Sourcing ────────────────────────────────────────────────────────────────

export async function sourceDonors(theme: string) {
  const tokens = theme
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 4);

  const or = tokens.flatMap((tok) => [
    { brand: { contains: tok } },
    { title: { contains: tok } },
    { productLine: { contains: tok } },
  ]);

  return prisma.donorProduct.findMany({
    // Automatic listing creation is fail-closed: uncertain catalog rows,
    // missing identifiers/images, and uncosted products stay in manual review.
    where: {
      ...(or.length > 0 ? { OR: or } : {}),
      needsReview: false,
      bestPrice: { gt: 0 },
      upc: { not: null },
      // NOTE deliberately NO `flavor: { not: null }` filter. The catalog's
      // structured `flavor` column is sparsely backfilled (Uncrustables:
      // 0/38 rows), while flavor identity downstream comes from
      // dedupeDonorFlavors → canonicalFlavorKey(title) anyway. Requiring the
      // column here silently starved the studio to zero donors for whole
      // brands (owner hit this 2026-07-21). Rows whose title yields no flavor
      // key are still dropped later — fail-closed per donor, not per brand.
      ingredients: { not: null },
      mainImageUrl: { not: null },
      offers: {
        some: {
          isFirstParty: true,
          via: "direct",
          price: { gt: 0 },
        },
      },
    },
    orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
    take: 60,
    select: {
      id: true,
      brand: true,
      productLine: true,
      flavor: true,
      title: true,
      category: true,
      upc: true,
      ingredients: true,
      bestPrice: true,
      mainImageUrl: true,
      imageUrls: true,
      offers: {
        where: { isFirstParty: true, via: "direct", price: { gt: 0 } },
        select: { price: true, packSizeSeen: true, pricePerUnit: true },
      },
    },
  });
}

type SourcedDonor = Awaited<ReturnType<typeof sourceDonors>>[number];

/** Normalise a flavor name for identity comparison: lowercase, punctuation →
 *  spaces, own-brand words stripped. Exported so the flavors endpoint and the
 *  UI round-trip the exact same tokens the engine will match. */
export function normalizeFlavorToken(s: string): string {
  const flat = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return flat
    .replace(/\b(smucker s|smuckers|smucker|uncrustables|uncrustable)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Match the owner's selected flavors against the deduped catalog entries.
 *  EXACT normalized equality only (key or label) — review 2026-07-21 proved a
 *  substring fallback silently over-matches ("Peanut Butter" swallowed 5
 *  sibling flavors), which violates the fail-closed contract in the sneakier
 *  direction (superset instead of subset). Output preserves catalog entry
 *  order, so the produced plan is deterministic regardless of request order.
 *  Callers must treat any `unmatched` as a hard error. */
export function matchFlavorFilter<T extends { key: string; label: string }>(
  entries: T[],
  requested: string[],
): { matched: T[]; unmatched: string[] } {
  const wanted = requested
    .map((raw) => ({ raw: raw.trim(), norm: normalizeFlavorToken(raw) }))
    .filter((w) => w.norm.length > 0);
  const hit = new Set<number>();
  const matched: T[] = [];
  for (const e of entries) {
    const names = [normalizeFlavorToken(e.key), normalizeFlavorToken(e.label)];
    let take = false;
    wanted.forEach((w, i) => {
      if (names.includes(w.norm)) { hit.add(i); take = true; }
    });
    if (take) matched.push(e);
  }
  const unmatched = wanted.filter((_, i) => !hit.has(i)).map((w) => w.raw);
  return { matched, unmatched };
}

// ── State (stored as JSON in GenerationJob.notes) ───────────────────────────

function readState(notes: string | null, fallbackTotal: number): EngineState {
  if (notes) {
    try {
      const parsed = JSON.parse(notes);
      if (parsed && parsed.progress) return parsed as EngineState;
    } catch {
      /* fall through */
    }
  }
  return {
    progress: {
      status: "PENDING",
      phase: "queued",
      step: "Queued",
      total: fallbackTotal,
      done: 0,
      failed: 0,
      done_flag: false,
    },
  };
}

// ── Per-listing build ───────────────────────────────────────────────────────

function mapCategory(donorCategory: string | null): string {
  const category = (donorCategory ?? "").trim().toLowerCase();
  if (/frozen|freezer/.test(category)) return "FROZEN_GROCERY";
  if (/refrigerated|chilled|cold/.test(category)) return "REFRIGERATED";
  if (/dry|ambient|shelf/.test(category)) return "SHELF_STABLE";
  // Unknown temperature is not safe to silently classify as ambient food.
  return "OTHER";
}

function donorName(d: SourcedDonor): string {
  return (
    d.title ||
    [d.brand, d.productLine, d.flavor].filter(Boolean).join(" ") ||
    "Product"
  );
}

interface DraftBuildResult {
  kind: "CREATED" | "EXISTING" | "SKIPPED" | "FAILED";
  title: string;
  draft_id?: string;
  error?: string;
}

async function ensureDraftForSpec(args: {
  jobId: string;
  index: number;
  houseBrand: string;
  channel: string;
  spec: VariationSpec;
  donorsById: Map<string, SourcedDonor>;
  fingerprint: string;
}): Promise<DraftBuildResult> {
  const { jobId, index, houseBrand, channel, spec, donorsById } = args;
  const components: VariantComponent[] = [];

  spec.donor_ids.forEach((id, i) => {
    const donor = donorsById.get(id);
    if (!donor) return;
    const ingredients = donor.ingredients?.trim() || undefined;
    const donorImages: string[] = [];
    if (donor.mainImageUrl) donorImages.push(donor.mainImageUrl);
    try {
      const parsed = donor.imageUrls ? JSON.parse(donor.imageUrls) : [];
      if (Array.isArray(parsed)) {
        for (const url of parsed) {
          if (typeof url === "string" && url.trim() && !donorImages.includes(url)) {
            donorImages.push(url);
          }
        }
      }
    } catch {
      // Keep the known main image when the optional gallery JSON is malformed.
    }
    components.push({
      research_pool_id: donor.id,
      product_name: donorName(donor),
      brand: donor.brand ?? "Unknown",
      qty: spec.quantities[i] ?? 0,
      unit_price_cents: donorUnitPriceCents(donor) ?? 0,
      flavor: spec.flavor_labels[i] ?? donor.flavor ?? undefined,
      manufacturer_upc: donor.upc ?? undefined,
      ingredients,
      storage_temp: donor.category ?? undefined,
      donor_image_urls: donorImages,
      ...(spec.donor_pack_sizes?.[i]?.length
        ? { retail_pack_sizes: spec.donor_pack_sizes[i] }
        : {}),
    });
  });

  const qtySum = components.reduce((sum, component) => sum + component.qty, 0);
  if (
    components.length !== spec.donor_ids.length ||
    qtySum !== spec.unit_count ||
    components.some((component) =>
      component.qty <= 0 ||
      component.unit_price_cents <= 0 ||
      !component.manufacturer_upc?.trim() ||
      !component.flavor?.trim() ||
      !component.ingredients?.trim()
    )
  ) {
    return {
      kind: "FAILED",
      title: `${spec.label} (composition invalid)`,
      error:
        `Recipe integrity failed: ${components.length}/${spec.donor_ids.length} components, ` +
        `${qtySum}/${spec.unit_count} units; positive cost, UPC, flavor, and manufacturer ingredients required`,
    };
  }

  const primary = donorsById.get(spec.donor_ids[0]);
  if (!primary) {
    return { kind: "FAILED", title: spec.label, error: "Primary donor missing" };
  }
  const category = mapCategory(primary.category);
  if (category === "OTHER") {
    return {
      kind: "FAILED",
      title: spec.label,
      error: `Donor category is unknown (${primary.category ?? "null"})`,
    };
  }
  const packCount = spec.unit_count;
  const costCents = components.reduce(
    (sum, component) => sum + component.qty * component.unit_price_cents,
    0,
  );
  const listingBrand = resolveListingBrand(primary.brand, houseBrand);
  const model = await getPricingModel();
  const priced = computeListingPrice(
    {
      brand: listingBrand,
      title: `${spec.label} ${primary.title ?? ""}`,
      cogs_cents: costCents,
      unit_count: packCount,
      weight_lb: null,
      category,
    },
    model,
  );
  const variant: Variant = {
    idx: index,
    name: spec.label,
    composition: components,
    cost_cents: costCents,
    suggested_price_cents: priced.selling_price_cents,
    margin_cents: priced.profit_cents,
    margin_pct: priced.margin_pct,
    feasibility_score: 90,
    notes: spec.label,
  };

  const draftName = isOwnBrandPassthrough(listingBrand)
    ? spec.label.slice(0, 120)
    : `${houseBrand} ${spec.label} Gift Set`.slice(0, 120);
  const exactAliasInput: RecipeAliasInput = {
    brand: listingBrand,
    composition_type: spec.composition_type,
    unit_count: packCount,
    components: components.map((component) => ({
      product_name: component.product_name,
      qty: component.qty,
    })),
  };
  const exactAliasFingerprint = legacyRecipeAliasFingerprint(exactAliasInput);
  let duplicate = await prisma.bundleDraft.findFirst({
    where: {
      OR: [
        { recipe_fingerprint: args.fingerprint },
        // A reviewed legacy plan may reserve the exact product/title recipe
        // instead of the newer flavor-based fingerprint.
        { recipe_fingerprint: exactAliasFingerprint },
        { draft_name: draftName },
      ],
    },
    select: { id: true, generation_job_id: true },
  });
  if (!duplicate) {
    // Legacy rows predate recipe_fingerprint. Compare their exact selected
    // recipes so an alias title cannot mint another logical listing. Any
    // unreadable candidate blocks creation rather than being silently skipped.
    const legacyCandidates = await prisma.bundleDraft.findMany({
      where: {
        brand: listingBrand,
        composition_type: spec.composition_type,
        pack_count: packCount,
      },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: 501,
      select: {
        id: true,
        generation_job_id: true,
        brand: true,
        composition_type: true,
        pack_count: true,
        recipe_fingerprint: true,
        draft_components: true,
        created_at: true,
        variation_matrix: {
          select: {
            variants_json: true,
            selected_variant_idx: true,
          },
        },
      },
    });
    const legacyResolution = resolveLegacyRecipeAlias(
      exactAliasInput,
      legacyCandidates,
      500,
    );
    if (legacyResolution.status === "BLOCKED") {
      return {
        kind: "FAILED",
        title: `${draftName} (legacy dedup blocked)`,
        error: legacyResolution.blockers.join(" | "),
      };
    }
    if (legacyResolution.status === "MATCH") {
      duplicate = {
        id: legacyResolution.canonical.id,
        generation_job_id: legacyResolution.canonical.generation_job_id,
      };
    }
  }
  if (duplicate) {
    return duplicate.generation_job_id === jobId
      ? { kind: "EXISTING", title: draftName, draft_id: duplicate.id }
      : { kind: "SKIPPED", title: `${draftName} (exists — skipped)` };
  }

  const secondaryImages = Array.from(
    new Set(
      components
        .flatMap((component) => component.donor_image_urls ?? [])
        .filter((url) => url !== primary.mainImageUrl),
    ),
  );
  const draft = await prisma.bundleDraft.create({
    data: {
      generation_job_id: jobId,
      draft_name: draftName,
      brand: listingBrand,
      category,
      composition_type: spec.composition_type,
      pack_count: packCount,
      draft_components: JSON.stringify(components),
      draft_main_image_url: primary.mainImageUrl,
      draft_secondary_images: JSON.stringify(secondaryImages),
      draft_cost_cents: costCents,
      draft_suggested_price_cents: priced.selling_price_cents,
      recipe_fingerprint: args.fingerprint,
      status: "VARIATION_SELECTED",
      target_channels: JSON.stringify([channel]),
      compliance_status: "PENDING",
      variation_matrix: {
        create: {
          variants_json: JSON.stringify([variant]),
          selected_variant_idx: 0,
          selected_at: new Date(),
        },
      },
    },
    select: { id: true },
  });
  return { kind: "CREATED", title: draftName, draft_id: draft.id };
}

// ── Tick ────────────────────────────────────────────────────────────────────

export async function tickBatch(batchId: string): Promise<BatchProgress> {
  const job = await prisma.generationJob.findUnique({ where: { id: batchId } });
  if (!job) {
    return {
      status: "FAILED", phase: "error", step: "Batch not found",
      total: 0, done: 0, failed: 0, done_flag: true,
    };
  }

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(job.brief ?? "{}");
  } catch {
    /* empty */
  }
  const prompt = typeof cfg.prompt === "string" ? cfg.prompt : "";
  const channel = typeof cfg.channel === "string" ? cfg.channel : "AMAZON_SALUTEM";
  const houseBrand = typeof cfg.house_brand === "string" ? cfg.house_brand : "Salutem Vita";
  // Structured self-service knobs (owner 2026-07-21): the module UI passes the
  // exact flavors and listing count instead of burying them in prose. Free-text
  // prompts without these keep the parsePrompt behaviour unchanged.
  const flavorFilter = Array.isArray(cfg.flavor_filter)
    ? (cfg.flavor_filter as unknown[])
        .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        .map((f) => f.trim())
    : [];
  const listingCountOverride =
    Number.isInteger(cfg.listing_count) && (cfg.listing_count as number) >= 1
      ? Math.min(500, cfg.listing_count as number)
      : null;

  const state = readState(job.notes, job.bundles_target);

  // Terminal — nothing to do.
  if (job.status === "COMPLETED" || job.status === "FAILED") {
    state.progress.done_flag = true;
    return state.progress;
  }

  // ── First tick: parse + source ──
  if (job.status === "PENDING" || !state.plan) {
    const parsed = parsePrompt(prompt);
    if (listingCountOverride != null) parsed.count = listingCountOverride;
    const planningProgress: BatchProgress = {
      status: "RUNNING",
      phase: "sourcing",
      step: `Sourcing verified products for "${parsed.theme}"…`,
      total: parsed.count,
      done: 0,
      failed: 0,
      done_flag: false,
    };

    // Planning must be claimed too. Without this compare-and-set, an eager UI
    // poll and the cron can both observe PENDING/no-plan, independently source
    // the catalog, then delete/recreate each other's queue. A fresh SOURCING
    // claim is left alone; a crashed claim can be reclaimed after the same
    // bounded stale interval used by per-spec work items.
    const planningIsFresh =
      job.status !== "PENDING" &&
      job.current_stage === "SOURCING" &&
      job.updated_at.getTime() > Date.now() - STALE_LOCK_MS;
    if (planningIsFresh) return planningProgress;

    const planningClaim = await prisma.generationJob.updateMany({
      where: {
        id: batchId,
        status: job.status,
        current_stage: job.current_stage,
        updated_at: job.updated_at,
      },
      data: {
        status: "IN_PROGRESS",
        current_stage: "SOURCING",
        notes: JSON.stringify({ progress: planningProgress }),
      },
    });
    if (planningClaim.count === 0) return planningProgress;

    const donors = await sourceDonors(parsed.theme);

    if (donors.length === 0) {
      const progress: BatchProgress = {
        status: "FAILED", phase: "error",
        step: `No products found for "${parsed.theme}" in the catalog. Pull them in via the Reference Catalog first.`,
        total: parsed.count, done: 0, failed: 0, done_flag: true,
      };
      await prisma.generationJob.update({
        where: { id: batchId },
        data: { status: "FAILED", bundles_target: parsed.count, notes: JSON.stringify({ progress }) },
      });
      return progress;
    }

    // Collapse duplicate flavors first (the catalog carries the same flavor in
    // several pack sizes / retailers) — otherwise the matrix pairs a flavor
    // with itself ("Strawberry + Strawberry") and COGS gets priced off a PACK
    // price. One entry per flavor, cheapest per-unit donor wins; flavors whose
    // unit cost can't be parsed are excluded (can't price → can't list).
    const entries = dedupeDonorFlavors(donors);
    const costable = entries.filter((e) => e.costable);
    if (costable.length === 0) {
      const progress: BatchProgress = {
        status: "FAILED", phase: "error",
        step: `Found ${donors.length} products for "${parsed.theme}", but none carry a parseable pack size (count) — cannot derive a per-unit cost.`,
        total: parsed.count, done: 0, failed: 0, done_flag: true,
      };
      await prisma.generationJob.update({
        where: { id: batchId },
        data: { status: "FAILED", bundles_target: parsed.count, notes: JSON.stringify({ progress }) },
      });
      return progress;
    }

    // Owner-selected flavors (module UI). Fail-closed: a requested flavor the
    // catalog can't satisfy stops the batch with the exact mismatch — silently
    // building a subset would ship a different assortment than the owner asked.
    let pool = costable;
    if (flavorFilter.length > 0) {
      // Match against ALL deduped entries, not just costable ones — the flavors
      // endpoint (and its UI) shows uncostable flavors too, and "not found in
      // the catalog" would be a false statement about a flavor the same system
      // just displayed. Costability is verified as its own step with its own
      // message (review 2026-07-21).
      const { matched, unmatched } = matchFlavorFilter(entries, flavorFilter);
      const uncostableMatched = matched.filter((e) => !e.costable);
      if (unmatched.length > 0 || matched.length === 0 || uncostableMatched.length > 0) {
        const available = costable.map((e) => e.label).join(" · ") || "none";
        const parts: string[] = [];
        if (unmatched.length > 0) parts.push(`not found in the catalog: ${unmatched.join(", ")}`);
        if (uncostableMatched.length > 0) parts.push(`no per-unit cost yet (needs enrichment): ${uncostableMatched.map((e) => e.label).join(", ")}`);
        if (parts.length === 0) parts.push("no matches");
        const progress: BatchProgress = {
          status: "FAILED", phase: "error",
          step: `Requested flavor(s) ${parts.join("; ")}. Buildable now for "${parsed.theme}": ${available}`,
          total: parsed.count, done: 0, failed: 0, done_flag: true,
        };
        await prisma.generationJob.update({
          where: { id: batchId },
          data: { status: "FAILED", bundles_target: parsed.count, notes: JSON.stringify({ progress }) },
        });
        return progress;
      }
      pool = matched;
      // Coverage guarantee: singles are planned counts-outer/flavors-inner, so
      // a count below the selection size would silently drop selected flavors
      // (review 2026-07-21). Raise to at least one listing per selected flavor.
      if (parsed.count < pool.length) parsed.count = pool.length;
    }

    // Never switch a mixed donor pool into passthrough mode because one row
    // happened to match the allowlist. Every selected flavor must be eligible.
    const ownBrand = pool.every((e) => isOwnBrandPassthrough(e.donor.brand));
    const flavors = pool.map((e) => ({
      id: e.donor.id,
      label: e.label,
      pack_sizes: e.pack_sizes,
    }));
    const listingBrand = resolveListingBrand(pool[0]?.donor.brand, houseBrand);
    const existingDrafts = await prisma.bundleDraft.findMany({
      where: { brand: listingBrand },
      select: { draft_name: true },
    });
    const existingNames = new Set(existingDrafts.map((draft) => draft.draft_name));
    // Generate enough candidates to replace already-existing deterministic
    // combinations, then keep exactly the requested number of NEW recipes.
    const candidates = planVariations(flavors, {
      targetCount: parsed.count + existingNames.size,
      ownBrand,
      defaultPack: parsed.pack_count,
    });
    const specs = candidates
      .filter((spec) => {
        const name = ownBrand
          ? spec.label.slice(0, 120)
          : `${houseBrand} ${spec.label} Gift Set`.slice(0, 120);
        return !existingNames.has(name);
      })
      .slice(0, parsed.count);
    if (specs.length === 0) {
      const progress: BatchProgress = {
        status: "FAILED",
        phase: "error",
        step: `No new recipe combinations remain for "${parsed.theme}".`,
        total: 0,
        done: 0,
        failed: 0,
        done_flag: true,
      };
      await prisma.generationJob.update({
        where: { id: batchId },
        data: { status: "FAILED", bundles_target: 0, notes: JSON.stringify({ progress }) },
      });
      return progress;
    }
    const usedIds = Array.from(new Set(specs.flatMap((s) => s.donor_ids)));
    const plan: EnginePlan = {
      count: specs.length,
      theme: parsed.theme,
      pack_count: parsed.pack_count,
      donor_ids: usedIds,
      listing_brand: listingBrand,
      specs,
    };
    const uncosted = entries.length - costable.length;
    const progress: BatchProgress = {
      status: "RUNNING", phase: "sourcing",
      step: `Found ${donors.length} verified products → ${costable.length} distinct flavors${uncosted ? ` (${uncosted} skipped: no unit cost)` : ""}${flavorFilter.length > 0 ? ` → ${pool.length} selected by flavor filter` : ""} — queued ${specs.length} new listings`,
      total: specs.length, done: 0, failed: 0, done_flag: false,
    };
    await prisma.$transaction(async (tx) => {
      await tx.generationWorkItem.deleteMany({ where: { generation_job_id: batchId } });
      await tx.generationWorkItem.createMany({
        data: specs.map((spec, index) => ({
          generation_job_id: batchId,
          spec_index: index,
          spec_json: JSON.stringify(spec),
          fingerprint: recipeFingerprint(listingBrand, spec),
        })),
      });
      await tx.generationJob.update({
        where: { id: batchId },
        data: {
          status: "IN_PROGRESS",
          current_stage: "CONTENT_GENERATION",
          bundles_target: specs.length,
          bundles_generated: 0,
          bundles_error: 0,
          notes: JSON.stringify({ plan, progress }),
        },
      });
    });
    return progress;
  }

  // ── Building tick: one durable work item ──
  const plan = state.plan;
  const total = plan.count;
  let items = await prisma.generationWorkItem.findMany({
    where: { generation_job_id: batchId },
    select: { status: true },
  });
  // Jobs created before the durable queue migration may already carry a full
  // plan in notes but have no work-item rows. Rehydrate that plan once instead
  // of leaving the batch RUNNING forever. Legacy specs get flavor labels only
  // from their referenced donor rows; missing labels still fail closed later.
  if (items.length === 0 && plan.specs.length > 0) {
    const legacyDonors = await prisma.donorProduct.findMany({
      where: { id: { in: plan.donor_ids } },
      select: { id: true, brand: true, flavor: true, title: true },
    });
    const legacyById = new Map(legacyDonors.map((donor) => [donor.id, donor]));
    const listingBrand =
      plan.listing_brand ??
      resolveListingBrand(legacyDonors[0]?.brand, houseBrand);
    const normalizedSpecs = plan.specs.map((spec) => ({
      ...spec,
      flavor_labels:
        Array.isArray(spec.flavor_labels) && spec.flavor_labels.length === spec.donor_ids.length
          ? spec.flavor_labels
          : spec.donor_ids.map((id) => {
              const donor = legacyById.get(id);
              return donor?.flavor?.trim() || donor?.title?.trim() || "";
            }),
    }));
    await prisma.$transaction(async (tx) => {
      await tx.generationWorkItem.createMany({
        data: normalizedSpecs.map((spec, index) => ({
          generation_job_id: batchId,
          spec_index: index,
          spec_json: JSON.stringify(spec),
          fingerprint: recipeFingerprint(listingBrand, spec),
        })),
      });
      await tx.generationJob.update({
        where: { id: batchId },
        data: {
          bundles_target: normalizedSpecs.length,
          bundles_generated: 0,
          bundles_error: 0,
          notes: JSON.stringify({
            plan: { ...plan, listing_brand: listingBrand, specs: normalizedSpecs },
            progress: {
              ...state.progress,
              total: normalizedSpecs.length,
              done: 0,
              failed: 0,
              skipped: 0,
              step: `Recovered ${normalizedSpecs.length} durable work item(s) from the legacy plan`,
            },
          }),
        },
      });
    });
    items = normalizedSpecs.map(() => ({ status: "PENDING" }));
  }
  const succeeded = items.filter((item) => item.status === "SUCCEEDED").length;
  const failed = items.filter((item) => item.status === "FAILED").length;
  const skipped = items.filter((item) => item.status === "SKIPPED").length;
  const terminal = succeeded + failed + skipped;
  if (items.length > 0 && terminal === items.length) {
    // A requested batch is complete only when every planned listing actually
    // succeeded. Partial output must be visible as a failed batch rather than
    // a green COMPLETED state with a silently short listing count.
    const terminalStatus = failed > 0 || skipped > 0 ? "FAILED" : "COMPLETED";
    const progress: BatchProgress = {
      status: terminalStatus,
      phase: terminalStatus === "COMPLETED" ? "done" : "error",
      step: `${terminalStatus === "COMPLETED" ? "Done" : "Incomplete"} — ${succeeded}/${total} listings generated${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`,
      total,
      done: terminal,
      failed,
      skipped,
      done_flag: true,
    };
    await prisma.generationJob.update({
      where: { id: batchId },
      data: {
        status: terminalStatus,
        bundles_generated: succeeded,
        bundles_error: failed,
        completed_at: new Date(),
        notes: JSON.stringify({ plan, progress }),
      },
    });
    return progress;
  }

  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  const candidate = await prisma.generationWorkItem.findFirst({
    where: {
      generation_job_id: batchId,
      OR: [
        { status: "PENDING" },
        { status: "RUNNING", locked_at: { lt: staleBefore } },
      ],
    },
    orderBy: { spec_index: "asc" },
  });
  if (!candidate) {
    return {
      status: "RUNNING",
      phase: "building",
      step: `Building… ${terminal} of ${total} completed`,
      total,
      done: terminal,
      failed,
      skipped,
      done_flag: false,
    };
  }

  const claimedAt = new Date();
  const claim = await prisma.generationWorkItem.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      ...(candidate.status === "RUNNING" ? { locked_at: candidate.locked_at } : {}),
    },
    data: {
      status: "RUNNING",
      locked_at: claimedAt,
      attempts: { increment: 1 },
    },
  });
  if (claim.count === 0) {
    return {
      status: "RUNNING", phase: "building", step: `Building… ${terminal} of ${total}`,
      total, done: terminal, failed, skipped, done_flag: false,
    };
  }

  const attempt = candidate.attempts + 1;
  let title = `spec ${candidate.spec_index + 1}`;
  let outcome: "SUCCEEDED" | "FAILED" | "SKIPPED" | "RETRY" = "FAILED";
  let error: string | null = null;
  let draftId = candidate.bundle_draft_id;
  try {
    const spec = JSON.parse(candidate.spec_json) as VariationSpec;
    title = spec.label;
    if (!Array.isArray(spec.flavor_labels)) {
      throw new Error("Work item is missing structured flavor_labels");
    }
    if (!draftId) {
      const donors = await prisma.donorProduct.findMany({
        where: { id: { in: spec.donor_ids } },
        select: {
          id: true, brand: true, productLine: true, flavor: true,
          title: true, category: true, upc: true, ingredients: true,
          bestPrice: true, mainImageUrl: true, imageUrls: true,
          offers: {
            where: { isFirstParty: true, via: "direct", price: { gt: 0 } },
            select: { price: true, packSizeSeen: true, pricePerUnit: true },
          },
        },
      });
      const build = await ensureDraftForSpec({
        jobId: batchId,
        index: candidate.spec_index,
        houseBrand,
        channel,
        spec,
        donorsById: new Map(donors.map((donor) => [donor.id, donor])),
        fingerprint: candidate.fingerprint,
      });
      title = build.title;
      if (build.kind === "SKIPPED") {
        outcome = "SKIPPED";
      } else if (build.kind === "FAILED" || !build.draft_id) {
        throw new Error(build.error ?? "Draft creation failed");
      } else {
        draftId = build.draft_id;
        await prisma.generationWorkItem.update({
          where: { id: candidate.id },
          data: { bundle_draft_id: draftId },
        });
      }
    }
    if (draftId && outcome !== "SKIPPED") {
      const content = await runContentGeneration({
        bundle_draft_id: draftId,
        channels: [channel],
        actor: "studio-engine",
      });
      const passed =
        content.outcomes.length > 0 &&
        content.outcomes.every((row) => row.compliance_status === "CAN_PUBLISH");
      if (!passed) throw new Error(content.error ?? "Content did not pass every channel gate");
      outcome = "SUCCEEDED";
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    outcome = attempt < MAX_WORK_ATTEMPTS ? "RETRY" : "FAILED";
  }

  await prisma.$transaction(async (tx) => {
    await tx.generationWorkItem.update({
      where: { id: candidate.id },
      data: {
        status: outcome === "RETRY" ? "PENDING" : outcome,
        locked_at: null,
        last_error: error,
        ...(draftId ? { bundle_draft_id: draftId } : {}),
      },
    });
    if (outcome === "SUCCEEDED") {
      await tx.generationJob.update({
        where: { id: batchId },
        data: { bundles_generated: { increment: 1 } },
      });
    } else if (outcome === "FAILED") {
      await tx.generationJob.update({
        where: { id: batchId },
        data: { bundles_error: { increment: 1 } },
      });
    }
  });

  const newDone = terminal + (outcome === "RETRY" ? 0 : 1);
  const newFailed = failed + (outcome === "FAILED" ? 1 : 0);
  const newSkipped = skipped + (outcome === "SKIPPED" ? 1 : 0);
  const progress: BatchProgress = {
    status: "RUNNING",
    phase: "building",
    step:
      outcome === "RETRY"
        ? `Retrying ${title} (${attempt}/${MAX_WORK_ATTEMPTS}): ${error}`
        : `${outcome === "SUCCEEDED" ? "Built" : outcome === "SKIPPED" ? "Skipped" : "Failed"} ${newDone} of ${total}: ${title}`,
    total,
    done: newDone,
    failed: newFailed,
    skipped: newSkipped,
    done_flag: false,
  };
  await prisma.generationJob.update({
    where: { id: batchId },
    data: { notes: JSON.stringify({ plan, progress }) },
  });
  return progress;
}
