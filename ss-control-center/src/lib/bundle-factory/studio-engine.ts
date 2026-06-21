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
import { generateContent } from "./content-generation";
import type { Variant, VariantComponent } from "./variation-matrix";
import { DISCLAIMER_BULLET, DISCLAIMER_DESCRIPTION } from "./remediation/disclaimer-text";

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
  const countMatch = lower.match(/\b(\d{1,3})\b/);
  let count = countMatch ? parseInt(countMatch[1], 10) : 5;
  count = Math.max(1, Math.min(50, count));

  // Pack size = "pack of N" / "N-pack" / "N count". Default 6.
  const packMatch =
    lower.match(/pack of (\d{1,2})/) ||
    lower.match(/(\d{1,2})\s*-?\s*pack/) ||
    lower.match(/(\d{1,2})\s*count/);
  let pack_count = packMatch ? parseInt(packMatch[1], 10) : 6;
  pack_count = Math.max(2, Math.min(50, pack_count));

  // Theme = remaining significant tokens (drop the count + stopwords).
  const theme = prompt
    .replace(/\b\d{1,3}\b/g, " ")
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
  textModel: "opus" | "sonnet";
  donors: SourcedDonor[];
  packCount: number;
}): Promise<{ ok: boolean; title: string }> {
  const { jobId, index, houseBrand, channel, donors, packCount } = args;

  // Each listing features a different donor product (the "variations").
  const primary = donors[index % donors.length];
  const unitPriceCents =
    typeof primary.bestPrice === "number" && primary.bestPrice > 0
      ? Math.round(primary.bestPrice * 100)
      : 0;
  const category = mapCategory(primary.category);

  const component: VariantComponent = {
    research_pool_id: primary.id,
    product_name: donorName(primary),
    brand: primary.brand ?? "Unknown",
    qty: packCount,
    unit_price_cents: unitPriceCents,
  };
  const costCents = component.qty * component.unit_price_cents;

  const variant: Variant = {
    idx: index,
    name: `Variation ${index + 1}`,
    composition: [component],
    cost_cents: costCents,
    // Placeholder for the content prompt only — the real selling price comes
    // from the economics module, the margin validator gates it before publish.
    suggested_price_cents: costCents > 0 ? Math.round(costCents * 2) : 0,
    margin_cents: 0,
    margin_pct: 0,
    feasibility_score: 1,
    notes: `Multipack of ${donorName(primary)}`,
  };

  const draftName = `${houseBrand} ${donorName(primary)} Gift Set`.slice(0, 120);

  let title = draftName;
  let bullets: string[] = [];
  let description = "";
  let ok = true;

  const out = await generateContent({
    template: "amazon",
    draft_name: draftName,
    brand: houseBrand,
    category,
    composition_type: "SINGLE_FLAVOR",
    pack_count: packCount,
    selected_variant: variant,
  });

  if (out.error || !out.title) {
    ok = false;
    title = draftName;
    bullets = [];
    description = "";
  } else {
    title = out.title;
    bullets = out.bullets;
    description = out.description;
  }

  // Append the curator disclaimer (exact verified wording) unless already there.
  if (!bullets.some((b) => b.toLowerCase().includes("curated and assembled by salutem"))) {
    bullets = [...bullets, DISCLAIMER_BULLET];
  }
  if (!description.toLowerCase().includes("curated and assembled by salutem")) {
    description = description ? `${description}\n\n${DISCLAIMER_DESCRIPTION}` : DISCLAIMER_DESCRIPTION;
  }

  await prisma.bundleDraft.create({
    data: {
      generation_job_id: jobId,
      draft_name: draftName,
      brand: houseBrand,
      category,
      composition_type: "SINGLE_FLAVOR",
      pack_count: packCount,
      draft_components: JSON.stringify([component]),
      draft_title: title,
      draft_bullets: JSON.stringify(bullets),
      draft_description: description,
      draft_main_image_url: primary.mainImageUrl ?? null,
      draft_cost_cents: costCents,
      status: ok ? "GENERATED" : "ERROR",
      target_channels: JSON.stringify([channel]),
      compliance_status: "PENDING",
    },
  });

  return { ok, title };
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
  const textModel = cfg.text_model === "sonnet" ? "sonnet" : "opus";

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

    const plan: EnginePlan = {
      count: parsed.count,
      theme: parsed.theme,
      pack_count: parsed.pack_count,
      donor_ids: donors.map((d) => d.id),
    };
    const progress: BatchProgress = {
      status: "RUNNING", phase: "sourcing",
      step: `Found ${donors.length} products — building ${parsed.count} listings`,
      total: parsed.count, done: 0, failed: 0, done_flag: false,
    };
    await prisma.generationJob.update({
      where: { id: batchId },
      data: {
        status: "IN_PROGRESS",
        current_stage: "CONTENT_GENERATION",
        bundles_target: parsed.count,
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

  // Re-load the sourced donors (ids → rows) so we have image + price.
  const donors = await prisma.donorProduct.findMany({
    where: { id: { in: plan.donor_ids } },
    select: {
      id: true, brand: true, productLine: true, flavor: true,
      title: true, category: true, bestPrice: true, mainImageUrl: true,
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

  const result = await buildOneListing({
    jobId: batchId,
    index: done,
    houseBrand,
    channel,
    textModel,
    donors,
    packCount: plan.pack_count,
  });

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
      bundles_generated: newDone,
      bundles_error: newFailed,
      ...(isLast ? { status: "COMPLETED", completed_at: new Date() } : {}),
      notes: JSON.stringify({ plan, progress }),
    },
  });

  return progress;
}
