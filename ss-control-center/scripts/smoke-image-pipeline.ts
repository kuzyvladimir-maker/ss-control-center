/**
 * Phase 2.3 Stage 5 smoke test — drive the image pipeline end-to-end
 * against the dev DB. Three stubs let it run free of network cost:
 *
 *   1. Codex image-worker stub returns a tiny 1×1 PNG (no live worker).
 *   2. Vision check stub returns "no foreign logos" for the first ASIN
 *      and "Lunchables detected" for the second — so we cover both the
 *      happy path AND the BLOCKED-then-retry path in a single run.
 *   3. R2 is left unconfigured locally → generateMainImage falls back
 *      to a data: URL, which Vision is happy to accept (the stub
 *      doesn't care about URL contents).
 *
 * Asserts:
 *   1. Pipeline writes main_image_url + image_generated_at on the
 *      "clean" row.
 *   2. Pipeline writes manual_review_required=true + BLOCKED on the
 *      "always-detects" row after MAX_IMAGE_RETRIES attempts.
 *   3. BundleDraft.status transitions GENERATED → IMAGE_GENERATING →
 *      IMAGE_GENERATED.
 *   4. Per-row image_retry_count + image_generation_cost_cents are set
 *      sensibly.
 *
 * Run with:
 *   npx tsx scripts/smoke-image-pipeline.ts
 *
 * Cleans up after itself.
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { runImageGeneration } from "@/lib/bundle-factory/image-pipeline";
import type { VisionCheckResult } from "@/lib/bundle-factory/audit/vision-check";

// 1×1 transparent PNG — same constant used in the unit test. Just enough
// bytes for the image-generation pipeline to "succeed".
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// ── Install stubs BEFORE any pipeline import ──────────────────────────

// Codex image-worker stub: returns canned PNG bytes, no network/sharp.
(globalThis as {
  __SS_CODEX_IMAGE_STUB__?: (args: { prompt: string; size?: string }) => Promise<Buffer>;
}).__SS_CODEX_IMAGE_STUB__ = async () => TINY_PNG;

// Vision stub returns clean for the first channel processed, dirty for
// every subsequent channel — gives us one happy path and one
// manual-review path in the same smoke run.
let visionCalls = 0;
(globalThis as {
  __BUNDLE_FACTORY_VISION_STUB__?: (
    imageUrl: string,
    ownBrand: string,
  ) => Promise<VisionCheckResult>;
}).__BUNDLE_FACTORY_VISION_STUB__ = async () => {
  visionCalls++;
  // Call 1 (AMAZON_SALUTEM attempt 1) gets a clean verdict so the
  // happy-path branch runs. Every subsequent call (WALMART × 3 retries)
  // returns dirty so we also cover the manual_review path in the same
  // smoke run.
  if (visionCalls === 1) {
    return { has_foreign_logos: false, detected_logos: [], cost_cents: 0 };
  }
  return {
    has_foreign_logos: true,
    detected_logos: ["Lunchables"],
    cost_cents: 0,
  };
};

async function main() {
  // ── Set up a throwaway draft with TWO channels already CAN_PUBLISH ───
  const job = await prisma.generationJob.create({
    data: {
      brief: JSON.stringify({ test: true, phase: "2.3" }),
      current_stage: "BRIEF",
      status: "PENDING",
      bundles_target: 1,
      user_id: "smoke",
    },
  });
  const draft = await prisma.bundleDraft.create({
    data: {
      generation_job_id: job.id,
      draft_name: "Phase 2.3 Smoke — Lunchables Variety",
      brand: "Salutem Vita",
      category: "REFRIGERATED",
      composition_type: "MULTI_FLAVOR",
      pack_count: 9,
      draft_components: JSON.stringify([]),
      target_channels: JSON.stringify(["AMAZON_SALUTEM", "WALMART"]),
      status: "GENERATED",
    },
  });

  const variants = [
    {
      idx: 0,
      name: "Lunchables variety pack ×9",
      composition: [
        {
          qty: 3,
          product_name: "Lunchables Ham + Cheese",
          brand: "Lunchables",
        },
        {
          qty: 3,
          product_name: "Lunchables Turkey + Cheese",
          brand: "Lunchables",
        },
        { qty: 3, product_name: "Lunchables Pizza", brand: "Lunchables" },
      ],
      feasibility_score: 88,
    },
  ];

  await prisma.variationMatrix.create({
    data: {
      bundle_draft_id: draft.id,
      variants_json: JSON.stringify(variants),
      selected_variant_idx: 0,
      generated_at: new Date(),
      selected_at: new Date(),
    },
  });

  // Two pre-seeded GeneratedContent rows in CAN_PUBLISH state, no image yet.
  // NOTE — titles and bullets deliberately avoid foreign brand names so
  // Stage 5's re-run of the full Compliance Gate doesn't trip Rule 1 or
  // Rule 7. The text content is treated as already Stage-4-clean.
  await prisma.generatedContent.create({
    data: {
      bundle_draft_id: draft.id,
      channel: "AMAZON_SALUTEM",
      template: "amazon",
      title: "Salutem Vita Curated Refrigerated Lunch Variety Gift Basket Pack of 9",
      bullets_json: JSON.stringify([
        "Includes 9 single-serve refrigerated lunch trays in original retail packaging.",
        "Refrigerator-stable until the printed use-by date on each tray.",
        "Curated and assembled by Salutem Solutions LLC as a gift basket.",
      ]),
      description:
        "Variety pack of nine single-serve lunches in retail packaging.\n\nCurated and assembled by Salutem Solutions LLC.",
      compliance_status: "CAN_PUBLISH",
    },
  });
  await prisma.generatedContent.create({
    data: {
      bundle_draft_id: draft.id,
      channel: "WALMART",
      template: "walmart",
      title: "Salutem Vita Curated Refrigerated Lunch Variety Gift Basket Pack of 9",
      bullets_json: JSON.stringify([
        "Includes 9 single-serve refrigerated lunch trays in original retail packaging.",
        "Refrigerator-stable until the printed use-by date on each tray.",
        "Curated and assembled by Salutem Solutions LLC as a gift basket.",
      ]),
      description:
        "Variety pack of nine single-serve lunches in retail packaging.\n\nCurated and assembled by Salutem Solutions LLC.",
      compliance_status: "CAN_PUBLISH",
    },
  });

  let failed = false;
  try {
    console.log(`Created draft ${draft.id} (2 CAN_PUBLISH rows, no images)`);

    const result = await runImageGeneration({
      bundle_draft_id: draft.id,
      actor: "smoke",
    });
    console.log(
      `Result: ok=${result.ok} cost=${result.total_cost_cents}¢ duration=${result.duration_ms}ms`,
    );
    for (const o of result.outcomes) {
      console.log(
        `  ${o.channel} → ${o.compliance_status} attempts=${o.attempts} cost=${o.cost_cents}¢ manual_review=${o.manual_review_required} logos=[${o.detected_logos.join(", ")}]`,
      );
    }

    // ── Assertions ───────────────────────────────────────────────────
    if (result.outcomes.length !== 2) {
      throw new Error(`expected 2 outcomes, got ${result.outcomes.length}`);
    }
    // First channel processed (alphabetical: AMAZON_SALUTEM) should be
    // CAN_PUBLISH on attempt 1 (vision stub returns clean once).
    const amazon = result.outcomes.find((o) => o.channel === "AMAZON_SALUTEM");
    const walmart = result.outcomes.find((o) => o.channel === "WALMART");
    if (!amazon || !walmart) {
      throw new Error(
        `expected both AMAZON_SALUTEM and WALMART in outcomes, got ${result.outcomes.map((o) => o.channel).join(", ")}`,
      );
    }
    if (amazon.compliance_status !== "CAN_PUBLISH") {
      throw new Error(
        `expected AMAZON_SALUTEM CAN_PUBLISH (vision stub returned clean), got ${amazon.compliance_status}`,
      );
    }
    if (amazon.attempts !== 1) {
      throw new Error(`expected AMAZON_SALUTEM attempts=1, got ${amazon.attempts}`);
    }
    if (walmart.compliance_status !== "BLOCKED") {
      throw new Error(
        `expected WALMART BLOCKED (vision stub returns dirty), got ${walmart.compliance_status}`,
      );
    }
    if (!walmart.manual_review_required) {
      throw new Error(`expected WALMART manual_review_required=true`);
    }
    if (walmart.attempts !== 3) {
      throw new Error(
        `expected WALMART attempts=3 (initial + 2 retries), got ${walmart.attempts}`,
      );
    }

    const after = await prisma.bundleDraft.findUnique({
      where: { id: draft.id },
      include: { generated_content: true },
    });
    console.log(`Draft status: ${after?.status}`);
    if (after?.status !== "IMAGE_GENERATED") {
      throw new Error(
        `expected status=IMAGE_GENERATED (every CAN_PUBLISH row resolved), got ${after?.status}`,
      );
    }
    if (!after.image_generated_at) {
      throw new Error("expected image_generated_at to be set on draft");
    }

    const amazonRow = after.generated_content.find(
      (r) => r.channel === "AMAZON_SALUTEM",
    );
    const walmartRow = after.generated_content.find(
      (r) => r.channel === "WALMART",
    );
    if (!amazonRow?.main_image_url) {
      throw new Error("expected AMAZON_SALUTEM row to have main_image_url");
    }
    if (!amazonRow.image_generated_at) {
      throw new Error("expected AMAZON_SALUTEM image_generated_at");
    }
    if (amazonRow.image_retry_count !== 1) {
      throw new Error(
        `expected AMAZON_SALUTEM image_retry_count=1, got ${amazonRow.image_retry_count}`,
      );
    }
    // Subscription image_gen is free → cost is always 0 now.
    if (amazonRow.image_generation_cost_cents !== 0) {
      throw new Error(
        `expected AMAZON_SALUTEM image_generation_cost_cents === 0 (subscription path is free), got ${amazonRow.image_generation_cost_cents}`,
      );
    }
    if (!walmartRow?.manual_review_required) {
      throw new Error("expected WALMART manual_review_required=true on row");
    }
    if (walmartRow.image_retry_count !== 3) {
      throw new Error(
        `expected WALMART image_retry_count=3, got ${walmartRow.image_retry_count}`,
      );
    }

    console.log("\nPASS");
  } catch (e) {
    failed = true;
    console.error("\nFAIL:", e);
  } finally {
    await prisma.complianceCheck.deleteMany({
      where: { bundle_draft_id: draft.id },
    });
    await prisma.complianceAuditLog.deleteMany({
      where: { bundle_draft_id: draft.id },
    });
    await prisma.generatedContent.deleteMany({
      where: { bundle_draft_id: draft.id },
    });
    await prisma.variationMatrix.deleteMany({
      where: { bundle_draft_id: draft.id },
    });
    await prisma.listingLifecycleLog.deleteMany({
      where: { entity_id: draft.id },
    });
    await prisma.bundleDraft.delete({ where: { id: draft.id } });
    await prisma.generationJob.delete({ where: { id: job.id } });
    console.log("Cleanup complete");
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
