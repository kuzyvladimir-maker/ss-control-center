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
import { runContentGeneration } from "./content-pipeline";
import { resolveListingBrand, isOwnBrandPassthrough } from "./own-brand";
import type { Variant, VariantComponent } from "./variation-matrix";
import { planVariations, type VariationSpec } from "./variation-planner";
import { dedupeDonorFlavors, donorUnitPriceCents } from "./donor-dedup";

export interface BatchProgress {
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  phase: "queued" | "sourcing" | "building" | "done" | "error";
  step: string; // human label for "what's happening right now"
  total: number; // listings to build
  done: number; // listings built (incl. failed)
  failed: number;
  done_flag: boolean; // true when nothing more to do
}

interface EnginePlan {
  count: number;
  theme: string;
  pack_count: number;
  donor_ids: string[];
  /** The combinatorial matrix — one entry per listing to build (P2). */
  specs: VariationSpec[];
}

interface EngineState {
  plan?: EnginePlan;
  progress: BatchProgress;
}

// ── Prompt parsing (heuristic — cheap, no LLM) ──────────────────────────────

const STOPWORDS = new Set([
  "gift", "gifts", "set", "sets", "basket", "baskets", "bundle", "bundles",
  "multipack", "multipacks", "pack", "packs", "listing", "listings", "new",
  "in", "different", "variation", "variations", "variety", "the", "a", "an",
  "of", "with", "and", "for", "make", "create", "build", "generate",
]);

export function parsePrompt(prompt: string): { count: number; theme: string; pack_count: number } {
  const lower = prompt.toLowerCase();

  // Count = first standalone integer (e.g. "50 ..."). Default 5.
  const countMatch = lower.match(/\b(\d{1,4})\b/);
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
    .split(/[^a-zA-Z0-9'&-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()))
    .join(" ")
    .trim();

  return { count, theme: theme || prompt.trim(), pack_count };
}

// ── Sourcing ────────────────────────────────────────────────────────────────

async function sourceDonors(theme: string) {
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
    where: or.length > 0 ? { OR: or } : {},
    orderBy: [{ updatedAt: "desc" }],
    take: 60,
    select: {
      id: true,
      brand: true,
      productLine: true,
      flavor: true,
      title: true,
      category: true,
      bestPrice: true,
      mainImageUrl: true,
      imageUrls: true,
    },
  });
}

type SourcedDonor = Awaited<ReturnType<typeof sourceDonors>>[number];

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
  switch ((donorCategory ?? "").toLowerCase()) {
    case "frozen":
      return "FROZEN_GROCERY";
    case "refrigerated":
      return "REFRIGERATED";
    case "dry":
      return "SHELF_STABLE";
    default:
      return "SHELF_STABLE";
  }
}

function donorName(d: SourcedDonor): string {
  return (
    d.title ||
    [d.brand, d.productLine, d.flavor].filter(Boolean).join(" ") ||
    "Product"
  );
}

async function buildOneListing(args: {
  jobId: string;
  index: number;
  houseBrand: string;
  channel: string;
  spec: VariationSpec;
  donorsById: Map<string, SourcedDonor>;
}): Promise<{ ok: boolean; title: string }> {
  const { jobId, index, houseBrand, channel, spec, donorsById } = args;

  // Build the composition from the variation spec — one component per flavor,
  // each carrying its share of the total piece count (spec.quantities).
  const components: VariantComponent[] = [];
  spec.donor_ids.forEach((id, i) => {
    const d = donorsById.get(id);
    if (!d) return;
    // COGS per SANDWICH/unit — the donor's bestPrice is the RETAIL PACK price
    // ("10 Count $9.84" → $0.98/unit). Never treat a pack price as a unit price:
    // that inflates a 30-piece listing's COGS 10× and births an absurd price.
    const unitPriceCents =
      donorUnitPriceCents(d) ??
      (typeof d.bestPrice === "number" && d.bestPrice > 0 ? Math.round(d.bestPrice * 100) : 0);
    components.push({
      research_pool_id: d.id,
      product_name: donorName(d),
      brand: d.brand ?? "Unknown",
      qty: spec.quantities[i] ?? 0,
      unit_price_cents: unitPriceCents,
    });
  });
  if (components.length === 0) return { ok: false, title: "(no donors for spec)" };

  const primary = donorsById.get(spec.donor_ids[0]) ?? donorsById.get(components[0].research_pool_id)!;
  const category = mapCategory(primary.category);
  const packCount = spec.unit_count;
  const costCents = components.reduce((s, c) => s + c.qty * c.unit_price_cents, 0);

  const variant: Variant = {
    idx: index,
    name: spec.label,
    composition: components,
    cost_cents: costCents,
    // Placeholder for the content prompt only — the real selling price comes
    // from the economics module, the margin validator gates it before publish.
    suggested_price_cents: costCents > 0 ? Math.round(costCents * 2) : 0,
    margin_cents: 0,
    margin_pct: 0,
    feasibility_score: 1,
    notes: spec.label,
  };

  // Own-brand passthrough (Uncrustables carve-out): list the genuine product
  // UNDER THE DONOR's OWN brand, NOT as a Salutem gift set. The listing brand
  // drives the whole downstream branch (content-gen + compliance derive the
  // mode from it). Everything else stays the Salutem gift-set model.
  const listingBrand = resolveListingBrand(primary.brand, houseBrand);
  const ownBrand = isOwnBrandPassthrough(listingBrand);
  // Own-brand: spec.label carries the CLEAN deduped flavor names + count
  // ("Peanut Butter & Strawberry Jam — 24 ct") — never the raw donor titles,
  // which drag retail pack sizes ("8oz/4ct") into a 24-piece listing's name.
  const draftName = ownBrand
    ? spec.label.slice(0, 120)
    : `${houseBrand} ${spec.label} Gift Set`.slice(0, 120);

  // ── Bridge to the canonical pipeline ───────────────────────────────────────
  // Earlier this engine baked content straight onto the BundleDraft and
  // stopped — but the draft-detail UI, compliance gate, validation and the
  // publish path all read GeneratedContent rows + a selected variant, so those
  // drafts dead-ended with nothing to validate or publish. We now create the
  // draft exactly like a brief-born one (with a VariationMatrix whose single
  // variant is pre-selected) and hand it to runContentGeneration — the same
  // orchestrator the "Generate content" button calls. It writes the per-channel
  // GeneratedContent, runs the compliance gate (curator disclaimer auto-
  // injected by rules 3+4) and flips the draft to GENERATED on a clean pass.
  const draft = await prisma.bundleDraft.create({
    data: {
      generation_job_id: jobId,
      draft_name: draftName,
      brand: listingBrand,
      category,
      composition_type: spec.composition_type,
      pack_count: packCount,
      draft_components: JSON.stringify(components),
      draft_main_image_url: primary.mainImageUrl ?? null,
      // Persist ALL donor photos so the preview + master bundle carry the full
      // set (only the title image is generated; the rest come from the donor).
      draft_secondary_images: (() => {
        try {
          const arr = primary.imageUrls ? JSON.parse(primary.imageUrls) : [];
          if (!Array.isArray(arr)) return JSON.stringify([]);
          const secondary = arr.filter(
            (u): u is string =>
              typeof u === "string" && u.trim().length > 0 && u !== primary.mainImageUrl,
          );
          return JSON.stringify(secondary);
        } catch {
          return JSON.stringify([]);
        }
      })(),
      draft_cost_cents: costCents,
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

  let passed = false;
  try {
    const result = await runContentGeneration({
      bundle_draft_id: draft.id,
      channels: [channel],
      actor: "studio-engine",
    });
    passed = result.outcomes.some((o) => o.compliance_status === "CAN_PUBLISH");
  } catch {
    passed = false;
  }

  // On a clean pass runContentGeneration leaves the draft at GENERATED with
  // CAN_PUBLISH content and NO image. We deliberately stop here rather than
  // reusing the donor photo: validator-image-dimensions hard-FAILS Amazon main
  // images below 2000×2000, and donor thumbnails are smaller — so the operator
  // generates real bundle images from the draft page ("Generate N images",
  // free Codex worker), which lifts the draft to IMAGE_GENERATED and unlocks
  // ship-specs → Validate → Publish. A BLOCKED result leaves the draft at
  // VARIATION_SELECTED with BLOCKED rows the operator can re-try.
  return { ok: passed, title: draftName };
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

  const state = readState(job.notes, job.bundles_target);

  // Terminal — nothing to do.
  if (job.status === "COMPLETED" || job.status === "FAILED") {
    state.progress.done_flag = true;
    return state.progress;
  }

  // ── First tick: parse + source ──
  if (job.status === "PENDING" || !state.plan) {
    const parsed = parsePrompt(prompt);
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

    // Build the combinatorial matrix (flavors × counts + mixes). Own-brand
    // (Uncrustables) → single flavors then 2/3/4-flavor mixes at 24/30/45/90/120;
    // gift-set → variations at the pack size. Capped at the requested count.
    const ownBrand = donors.some((d) => isOwnBrandPassthrough(d.brand));
    const flavors = costable.map((e) => ({ id: e.donor.id, label: e.label }));
    const specs = planVariations(flavors, {
      targetCount: parsed.count,
      ownBrand,
      defaultPack: parsed.pack_count,
    });
    const usedIds = Array.from(new Set(specs.flatMap((s) => s.donor_ids)));
    const plan: EnginePlan = {
      count: specs.length,
      theme: parsed.theme,
      pack_count: parsed.pack_count,
      donor_ids: usedIds,
      specs,
    };
    const skipped = entries.length - costable.length;
    const progress: BatchProgress = {
      status: "RUNNING", phase: "sourcing",
      step: `Found ${donors.length} products → ${costable.length} distinct flavors${skipped ? ` (${skipped} skipped: no parseable pack size)` : ""} — building ${specs.length} listings`,
      total: specs.length, done: 0, failed: 0, done_flag: false,
    };
    await prisma.generationJob.update({
      where: { id: batchId },
      data: {
        status: "IN_PROGRESS",
        current_stage: "CONTENT_GENERATION",
        bundles_target: specs.length,
        bundles_generated: 0,
        notes: JSON.stringify({ plan, progress }),
      },
    });
    return progress;
  }

  // ── Building tick: one listing ──
  const plan = state.plan;
  const total = plan.count;
  const done = job.bundles_generated;

  if (done >= total) {
    const progress: BatchProgress = {
      status: "COMPLETED", phase: "done",
      step: `Done — ${total} listings built${job.bundles_error ? `, ${job.bundles_error} failed` : ""}`,
      total, done, failed: job.bundles_error, done_flag: true,
    };
    await prisma.generationJob.update({
      where: { id: batchId },
      data: { status: "COMPLETED", completed_at: new Date(), notes: JSON.stringify({ plan, progress }) },
    });
    return progress;
  }

  // Atomically CLAIM slot `done` before any expensive work, so a concurrent
  // tick (cron backstop + browser polling) can't build the same listing twice
  // and double the Claude spend. Only the tick that flips bundles_generated
  // done→done+1 owns this slot.
  const claim = await prisma.generationJob.updateMany({
    where: { id: batchId, status: "IN_PROGRESS", bundles_generated: done },
    data: { bundles_generated: done + 1 },
  });
  if (claim.count === 0) {
    const fresh = await prisma.generationJob.findUnique({
      where: { id: batchId },
      select: { bundles_generated: true, bundles_target: true, bundles_error: true, status: true },
    });
    const d = fresh?.bundles_generated ?? done;
    const t = fresh?.bundles_target ?? total;
    return {
      status: fresh?.status === "COMPLETED" ? "COMPLETED" : "RUNNING",
      phase: d >= t ? "done" : "building",
      step: `Building… ${d} of ${t}`,
      total: t, done: d, failed: fresh?.bundles_error ?? 0, done_flag: d >= t,
    };
  }

  // Re-load the sourced donors (ids → rows) so we have image + price.
  const donors = await prisma.donorProduct.findMany({
    where: { id: { in: plan.donor_ids } },
    select: {
      id: true, brand: true, productLine: true, flavor: true,
      title: true, category: true, bestPrice: true, mainImageUrl: true,
      imageUrls: true,
    },
  });
  if (donors.length === 0) {
    const progress: BatchProgress = {
      status: "FAILED", phase: "error", step: "Sourced products vanished from the catalog.",
      total, done, failed: job.bundles_error, done_flag: true,
    };
    await prisma.generationJob.update({
      where: { id: batchId },
      data: { status: "FAILED", notes: JSON.stringify({ plan, progress }) },
    });
    return progress;
  }

  const donorsById = new Map(donors.map((d) => [d.id, d]));
  const spec = plan.specs?.[done];
  const result = spec
    ? await buildOneListing({ jobId: batchId, index: done, houseBrand, channel, spec, donorsById })
    : { ok: false, title: "(no variation spec)" };

  const newDone = done + 1;
  const newFailed = job.bundles_error + (result.ok ? 0 : 1);
  const isLast = newDone >= total;

  const progress: BatchProgress = {
    status: isLast ? "COMPLETED" : "RUNNING",
    phase: isLast ? "done" : "building",
    step: isLast
      ? `Done — ${total} listings built${newFailed ? `, ${newFailed} failed` : ""}`
      : `Built ${newDone} of ${total}: ${result.title}`,
    total, done: newDone, failed: newFailed, done_flag: isLast,
  };

  await prisma.generationJob.update({
    where: { id: batchId },
    data: {
      // bundles_generated already advanced by the atomic claim above; only track
      // errors (increment, race-safe) + terminal status here.
      ...(result.ok ? {} : { bundles_error: { increment: 1 } }),
      ...(isLast ? { status: "COMPLETED", completed_at: new Date() } : {}),
      notes: JSON.stringify({ plan, progress }),
    },
  });

  return progress;
}
