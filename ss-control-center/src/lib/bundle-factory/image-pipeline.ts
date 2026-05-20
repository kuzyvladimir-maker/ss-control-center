/**
 * Phase 2.3 Stage 5 — Main image pipeline orchestrator.
 *
 * Combines image generation + compliance gate Rule 6 (with vision check
 * ACTUALLY running this time) + retry-with-stronger-negatives + per-row
 * persistence + draft status transitions into one entry point.
 *
 * Per-row flow (one GeneratedContent that needs an image):
 *   1. Build a prompt from the variant composition + brand + style rules.
 *   2. generateMainImage(prompt) → preliminary R2 URL.
 *   3. Persist preliminary URL onto the GeneratedContent row.
 *   4. runComplianceGate({ skip_image_check: false }) on the content +
 *      image — only Rule 6 can fire now since Stage 4 already cleared
 *      every text-only rule.
 *   5. CAN_PUBLISH → mark image_generated_at, increment counter, done.
 *   6. BLOCKED on rule-6 → build stronger negative from
 *      detected_logos → retry. Max MAX_IMAGE_RETRIES total attempts.
 *   7. Still BLOCKED after retries → mark manual_review_required=true,
 *      leave compliance_status=BLOCKED.
 *
 * Scope:
 *   ONLY rows where compliance_status='CAN_PUBLISH' AND main_image_url
 *   IS NULL get processed. BLOCKED rows (text-level) and rows that
 *   already have an image (idempotent re-run) are left alone.
 *
 * Draft transitions:
 *   - Pipeline entry: status='GENERATED' → 'IMAGE_GENERATING'
 *     (only when the caller is acting on a draft that's at GENERATED;
 *      drafts already in IMAGE_GENERATING/IMAGE_GENERATED stay where
 *      they are so re-runs from the UI don't bounce the badge).
 *   - Pipeline exit: 'IMAGE_GENERATED' if every CAN_PUBLISH row now has
 *     an image or is in manual review; 'ERROR' if no row succeeded.
 */

import { prisma } from "@/lib/prisma";
import {
  generateMainImage,
  type RewriteFeedback,
} from "./image-generation";
import { runComplianceGate } from "./compliance/gate";
import type { BundleComponentInput } from "./compliance/types";
import type { Variant } from "./variation-matrix";
import { logLifecycle } from "./lifecycle-log";

// Per spec: 2 retries on top of the initial attempt = 3 total tries.
const MAX_IMAGE_RETRIES = 3;

export interface RunImageGenerationInput {
  bundle_draft_id: string;
  /** Optional channel subset. Default = all rows on the draft that are
   *  CAN_PUBLISH + main_image_url IS NULL. */
  channels?: string[];
  /** When true, regenerate even if main_image_url is already set
   *  (UI "regenerate one channel" flow). Defaults to false. */
  force?: boolean;
  actor?: string;
}

export interface ChannelImageOutcome {
  channel: string;
  generated_content_id: string;
  /** Final per-row status after the pipeline ran. */
  compliance_status: "CAN_PUBLISH" | "BLOCKED" | "SKIPPED";
  attempts: number;
  image_url: string | null;
  cost_cents: number;
  manual_review_required: boolean;
  /** Logos that the LAST vision check found, even on success — useful
   *  for the UI's "image OK but Vision saw X" badge. */
  detected_logos: string[];
  error?: string;
}

export interface RunImageGenerationResult {
  ok: boolean;
  bundle_draft_id: string;
  outcomes: ChannelImageOutcome[];
  total_cost_cents: number;
  duration_ms: number;
  /** Non-fatal pipeline-level message — typically "no rows to process". */
  note?: string;
}

// Visible for tests so the prompt rendering can be asserted without
// round-tripping through OpenAI.
export function buildImagePrompt(args: {
  brand: string;
  variant: Variant;
  composition_type: string;
}): string {
  const composition = args.variant.composition
    .map((c) => `${c.qty}× ${c.product_name}`)
    .join(", ");

  // Style rules pulled directly from CLAUDE.md brand-voice section —
  // factual, neutral, no promo language even inside the visual description.
  return [
    `Professional product photograph of a curated gift basket / variety pack.`,
    `Contents: ${composition}.`,
    `Composition type: ${args.composition_type.toLowerCase().replace(/_/g, " ")}.`,
    `Curated and assembled by ${args.brand}.`,
    ``,
    `STYLE:`,
    `- Clean studio photography on a seamless pure white background.`,
    `- Soft even lighting, minimal shadow under the items, no dramatic gradient.`,
    `- Items neatly arranged so each is clearly visible — flat lay or shallow group composition.`,
    `- Square 1:1 framing, items fill roughly 85% of the frame.`,
    `- Sharp focus across all items, accurate colour.`,
    ``,
    `STRICT NEGATIVES (do not include any of these):`,
    `- No third-party brand logos, brand text, or trademarked packaging artwork visible on any item.`,
    `- No retailer marks, no shelf labels, no price tags, no UPC barcodes.`,
    `- Use entirely generic, unbranded packaging — plain wrappers, blank cartons, neutral pouches.`,
    `- No people, hands, mouths, or body parts.`,
    `- No emojis, decorative icons, stars, sparkles, or burst graphics overlaid on the image.`,
    `- No promotional text or marketing copy rendered into the image.`,
    `- No watermarks, no signatures, no AI-generation artefacts.`,
  ].join("\n");
}

function parseBundleComponents(
  raw: string | null,
  fallback: Variant,
): BundleComponentInput[] {
  // Prefer the variant composition (canonical Stage 3 data) — falls back
  // to draft_components only if the variant is somehow empty.
  if (fallback.composition.length > 0) {
    return fallback.composition.map((c) => ({
      brand: c.brand,
      product_name: c.product_name,
    }));
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      .map((c) => ({
        brand: typeof c.brand === "string" ? c.brand : "",
        product_name:
          typeof c.product_name === "string" ? c.product_name : undefined,
      }));
  } catch {
    return [];
  }
}

export async function runImageGeneration(
  input: RunImageGenerationInput,
): Promise<RunImageGenerationResult> {
  const startMs = Date.now();

  const draft = await prisma.bundleDraft.findUnique({
    where: { id: input.bundle_draft_id },
    include: {
      variation_matrix: true,
      generated_content: { orderBy: { channel: "asc" } },
    },
  });
  if (!draft) {
    throw new Error(`BundleDraft ${input.bundle_draft_id} not found`);
  }
  if (!draft.variation_matrix) {
    throw new Error(
      `BundleDraft ${draft.id} has no VariationMatrix — content/variant must be set first`,
    );
  }
  const matrix = draft.variation_matrix;
  if (matrix.selected_variant_idx == null) {
    throw new Error(`BundleDraft ${draft.id} has no selected variant`);
  }

  let variants: Variant[];
  try {
    variants = JSON.parse(matrix.variants_json) as Variant[];
  } catch (e) {
    throw new Error(
      `VariationMatrix.variants_json malformed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const selected = variants[matrix.selected_variant_idx];
  if (!selected) {
    throw new Error(
      `Selected variant idx ${matrix.selected_variant_idx} out of range`,
    );
  }

  // Filter to processable rows.
  const allRows = draft.generated_content;
  const candidateChannels =
    input.channels && input.channels.length > 0
      ? new Set(input.channels)
      : null;

  const rowsToProcess = allRows.filter((r) => {
    if (candidateChannels && !candidateChannels.has(r.channel)) return false;
    if (r.compliance_status !== "CAN_PUBLISH") return false;
    if (!input.force && r.main_image_url) return false;
    return true;
  });

  if (rowsToProcess.length === 0) {
    return {
      ok: true,
      bundle_draft_id: draft.id,
      outcomes: [],
      total_cost_cents: 0,
      duration_ms: Date.now() - startMs,
      note:
        "No rows to process — every CAN_PUBLISH channel either already has an image, or no channel was requested.",
    };
  }

  // Flip status to IMAGE_GENERATING (only if we're stepping forward from
  // GENERATED — re-runs from later states keep their status).
  const fromStatus = draft.status;
  if (fromStatus === "GENERATED") {
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: { status: "IMAGE_GENERATING" },
    });
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: fromStatus,
      to_status: "IMAGE_GENERATING",
      reason: `Image pipeline started for ${rowsToProcess.length} channel(s)`,
      actor: input.actor ?? "system",
    });
  }

  const bundleComponents = parseBundleComponents(
    draft.draft_components,
    selected,
  );

  const basePrompt = buildImagePrompt({
    brand: draft.brand,
    variant: selected,
    composition_type: draft.composition_type,
  });

  const outcomes: ChannelImageOutcome[] = [];
  let totalCost = 0;

  for (const row of rowsToProcess) {
    const outcome = await processOneRow({
      row,
      draft_id: draft.id,
      brand: draft.brand,
      title: row.title,
      bullets: safeJsonStringArray(row.bullets_json),
      description: row.description,
      basePrompt,
      bundleComponents,
      actor: input.actor ?? "system",
    });
    outcomes.push(outcome);
    totalCost += outcome.cost_cents;
  }

  // Final draft-level status transition.
  const successCount = outcomes.filter(
    (o) => o.compliance_status === "CAN_PUBLISH",
  ).length;
  const allDone = await everyCanPublishRowHasImage(draft.id);
  let nextStatus = draft.status;
  if (allDone) {
    nextStatus = "IMAGE_GENERATED";
  } else if (successCount === 0 && fromStatus === "GENERATED") {
    // Rolled into IMAGE_GENERATING but nothing succeeded → move to ERROR
    // so the operator sees the run failed at the draft level.
    nextStatus = "ERROR";
  }

  if (nextStatus !== draft.status) {
    const updateData: { status: string; image_generated_at?: Date } = {
      status: nextStatus,
    };
    if (nextStatus === "IMAGE_GENERATED") {
      updateData.image_generated_at = new Date();
    }
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: updateData,
    });
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: draft.status,
      to_status: nextStatus,
      reason:
        nextStatus === "IMAGE_GENERATED"
          ? `Image pipeline finished — ${successCount}/${outcomes.length} compliant, others in manual review`
          : `Image pipeline produced no compliant images for ${outcomes.length} row(s)`,
      actor: input.actor ?? "system",
      details: {
        total_cost_cents: totalCost,
        outcomes: outcomes.map((o) => ({
          channel: o.channel,
          status: o.compliance_status,
          attempts: o.attempts,
        })),
      },
    });
  }

  return {
    ok: successCount > 0,
    bundle_draft_id: draft.id,
    outcomes,
    total_cost_cents: totalCost,
    duration_ms: Date.now() - startMs,
  };
}

// ── Per-row inner loop ─────────────────────────────────────────────────

interface ProcessOneRowInput {
  row: {
    id: string;
    channel: string;
    title: string;
    bullets_json: string;
    description: string;
    image_retry_count: number;
  };
  draft_id: string;
  brand: string;
  title: string;
  bullets: string[];
  description: string;
  basePrompt: string;
  bundleComponents: BundleComponentInput[];
  actor: string;
}

async function processOneRow(
  args: ProcessOneRowInput,
): Promise<ChannelImageOutcome> {
  const { row, draft_id, brand, basePrompt, bundleComponents } = args;
  const r2Slug = `draft-${draft_id}-${row.channel}`.toLowerCase();

  let attempt = 0;
  let totalCost = 0;
  let lastImageUrl: string | null = null;
  let lastDetectedLogos: string[] = [];
  let lastError: string | undefined;
  let priorFailure: RewriteFeedback | undefined;

  while (attempt < MAX_IMAGE_RETRIES) {
    attempt++;

    const imgResult = await generateMainImage({
      prompt: basePrompt,
      r2_path_slug: r2Slug,
      retry_context: priorFailure
        ? { ...priorFailure, attempt }
        : undefined,
    });
    totalCost += imgResult.cost_cents;

    if (imgResult.error && !imgResult.image_url) {
      // Hard failure — record and bail without compliance check.
      lastError = imgResult.error;
      break;
    }
    lastImageUrl = imgResult.image_url;

    // Persist preliminary URL so it's recoverable if the process dies
    // mid-compliance-check.
    await prisma.generatedContent.update({
      where: { id: row.id },
      data: {
        main_image_url: lastImageUrl,
        image_generation_cost_cents: { increment: imgResult.cost_cents },
        image_retry_count: attempt,
      },
    });

    if (!lastImageUrl) {
      // Mock/dev fallback returned null — treat as terminal soft fail.
      lastError = imgResult.error ?? "image generation returned no URL";
      break;
    }

    // Run compliance gate WITH image check this time. Rules 1-5+7-8 will
    // re-pass trivially (text didn't change), only Rule 6 is the real
    // gate here.
    const decision = await runComplianceGate(
      {
        bundle_draft_id: draft_id,
        title: args.title,
        brand,
        bullets: args.bullets,
        description: args.description,
        browse_node: null,
        main_image_url: lastImageUrl,
        bundle_components: bundleComponents,
        skip_image_check: false,
      },
      { autoFix: false, actor: args.actor },
    );
    lastDetectedLogos = decision.detected_logos;

    if (decision.decision === "CAN_PUBLISH") {
      await prisma.generatedContent.update({
        where: { id: row.id },
        data: {
          compliance_status: "CAN_PUBLISH",
          compliance_check_id: decision.compliance_check_id ?? null,
          manual_review_required: false,
          image_generated_at: new Date(),
        },
      });
      return {
        channel: row.channel,
        generated_content_id: row.id,
        compliance_status: "CAN_PUBLISH",
        attempts: attempt,
        image_url: lastImageUrl,
        cost_cents: totalCost,
        manual_review_required: false,
        detected_logos: lastDetectedLogos,
      };
    }

    // BLOCKED — build stronger retry feedback from Rule 6's findings.
    const rule6 = decision.rules.find(
      (r) => r.rule_id === "rule-6-image-vision-check",
    );
    priorFailure = {
      attempt,
      detected_logos: lastDetectedLogos,
      failure_reason: rule6?.reason ?? "image_compliance_failed",
    };
  }

  // Exhausted retries — manual review.
  await prisma.generatedContent.update({
    where: { id: row.id },
    data: {
      compliance_status: "BLOCKED",
      manual_review_required: true,
      image_retry_count: attempt,
      // Keep last preview URL for the manual reviewer to look at; they
      // can either approve override or send back to regenerate.
    },
  });

  return {
    channel: row.channel,
    generated_content_id: row.id,
    compliance_status: "BLOCKED",
    attempts: attempt,
    image_url: lastImageUrl,
    cost_cents: totalCost,
    manual_review_required: true,
    detected_logos: lastDetectedLogos,
    error: lastError,
  };
}

async function everyCanPublishRowHasImage(draftId: string): Promise<boolean> {
  // True if every CAN_PUBLISH row has either an image URL or is in
  // manual review (BLOCKED). False only when there are CAN_PUBLISH rows
  // that haven't been touched yet.
  const pending = await prisma.generatedContent.count({
    where: {
      bundle_draft_id: draftId,
      compliance_status: "CAN_PUBLISH",
      main_image_url: null,
    },
  });
  return pending === 0;
}

function safeJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}
