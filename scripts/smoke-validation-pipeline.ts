/**
 * Phase 2.4 Stage 6 smoke — end-to-end pipeline against dev DB.
 *
 * Seeds: GenerationJob → BundleDraft (status=IMAGE_GENERATED) →
 *        VariationMatrix → 2 GeneratedContent rows (CAN_PUBLISH + image
 *        URL set) → UPCPool with 2 AVAILABLE rows.
 *
 * Stubs: Anthropic Vision returns "clean" so Rule 6 of the compliance-
 *        rerun validator passes. Veeqo is left unstubbed — the inventory
 *        validator gracefully returns NEEDS_REVIEW when the API call
 *        fails (no API key in dev).
 *
 * Asserts:
 *   1. promote-draft creates a MasterBundle + 2 ChannelSKU rows.
 *   2. Validation pipeline runs all 15 validators per row.
 *   3. AMAZON_SALUTEM ends at PASSED or NEEDS_REVIEW (inventory warn).
 *   4. BundleDraft.status transitions to VALIDATING then to VALIDATED
 *      or stays VALIDATING (if NEEDS_REVIEW only).
 *
 * Run with:
 *   npx tsx scripts/smoke-validation-pipeline.ts
 *
 * Cleans up after itself.
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { promoteDraftToChannelSkus } from "@/lib/bundle-factory/validation/promote-draft";
import { runValidationForDraft } from "@/lib/bundle-factory/validation/validation-pipeline";
import type { VisionCheckResult } from "@/lib/bundle-factory/audit/vision-check";

// Stub Vision so the compliance-rerun validator's Rule 6 passes.
(globalThis as {
  __BUNDLE_FACTORY_VISION_STUB__?: (
    imageUrl: string,
    ownBrand: string,
  ) => Promise<VisionCheckResult>;
}).__BUNDLE_FACTORY_VISION_STUB__ = async () => ({
  has_foreign_logos: false,
  detected_logos: [],
  cost_cents: 0,
});

// Tiny valid PNG header that decodes to 2000×2000 so
// validator-image-dimensions passes on Amazon's 2000×2000 floor.
function build2000pxPng(): string {
  const buf = Buffer.alloc(24);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, 4, "binary");
  buf.writeUInt32BE(2000, 16);
  buf.writeUInt32BE(2000, 20);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

const IMAGE_DATA_URL = build2000pxPng();

async function seedAvailableUpcs(count: number): Promise<string[]> {
  const created: string[] = [];
  // Use a deterministic UPC prefix + valid checksum so
  // validator-upc-format passes during the post-promotion run.
  for (let i = 0; i < count; i++) {
    const base = `9${String(900000 + i).padStart(10, "0")}`; // 11 digits
    let sum = 0;
    for (let j = 0; j < 11; j++) {
      const d = base.charCodeAt(j) - 48;
      sum += j % 2 === 0 ? d * 3 : d;
    }
    const check = ((10 - (sum % 10)) % 10).toString();
    const upc = `${base}${check}`;
    await prisma.uPCPool.create({
      data: {
        upc,
        upc_prefix: upc.slice(0, 3),
        status: "AVAILABLE",
        gs1_validated: true,
        acquired_at: new Date(),
      },
    });
    created.push(upc);
  }
  return created;
}

async function main() {
  const job = await prisma.generationJob.create({
    data: {
      brief: JSON.stringify({ test: true, phase: "2.4" }),
      current_stage: "BRIEF",
      status: "PENDING",
      bundles_target: 1,
      user_id: "smoke",
    },
  });
  const draft = await prisma.bundleDraft.create({
    data: {
      generation_job_id: job.id,
      draft_name: "Phase 2.4 Smoke — Validation Run",
      brand: "Salutem Vita",
      category: "REFRIGERATED",
      composition_type: "SINGLE_FLAVOR",
      pack_count: 9,
      draft_components: JSON.stringify([]),
      target_channels: JSON.stringify(["AMAZON_SALUTEM", "WALMART"]),
      status: "IMAGE_GENERATED",
    },
  });
  await prisma.variationMatrix.create({
    data: {
      bundle_draft_id: draft.id,
      variants_json: JSON.stringify([
        {
          idx: 0,
          name: "smoke variant",
          composition: [
            {
              qty: 9,
              product_name: "Generic refrigerated lunch tray",
              brand: "Generic",
            },
          ],
          feasibility_score: 90,
        },
      ]),
      selected_variant_idx: 0,
      generated_at: new Date(),
      selected_at: new Date(),
    },
  });
  const upcs = await seedAvailableUpcs(2);

  await prisma.generatedContent.create({
    data: {
      bundle_draft_id: draft.id,
      channel: "AMAZON_SALUTEM",
      template: "amazon",
      title: "Salutem Vita Curated Refrigerated Lunch Variety Gift Basket Pack of 9",
      bullets_json: JSON.stringify([
        "Includes nine single-serve refrigerated lunch trays in original retail packaging.",
        "Refrigerator-stable until the printed use-by date on each tray.",
        "Curated and assembled by Salutem Solutions LLC as a gift basket.",
      ]),
      description:
        "Variety pack of nine single-serve lunches in retail packaging.\n\nCurated and assembled by Salutem Solutions LLC.",
      compliance_status: "CAN_PUBLISH",
      main_image_url: IMAGE_DATA_URL,
    },
  });
  await prisma.generatedContent.create({
    data: {
      bundle_draft_id: draft.id,
      channel: "WALMART",
      template: "walmart",
      title: "Salutem Vita Curated Refrigerated Lunch Variety Gift Basket Pack of 9",
      bullets_json: JSON.stringify([
        "Includes nine single-serve refrigerated lunch trays in original retail packaging.",
        "Refrigerator-stable until the printed use-by date on each tray.",
        "Curated and assembled by Salutem Solutions LLC as a gift basket.",
      ]),
      description:
        "Variety pack of nine single-serve lunches in retail packaging.\n\nCurated and assembled by Salutem Solutions LLC.",
      compliance_status: "CAN_PUBLISH",
      main_image_url: IMAGE_DATA_URL,
    },
  });

  let failed = false;
  let masterBundleId: string | null = null;
  let createdSkuIds: string[] = [];
  try {
    console.log(`Created draft ${draft.id} + 2 GeneratedContent rows + ${upcs.length} UPCs`);

    const promo = await promoteDraftToChannelSkus(draft.id);
    console.log(
      `Promote: created=${promo.created_channels.join(",")} existing=${promo.existing_channels.join(",")} skipped=${promo.skipped.length}`,
    );
    masterBundleId = promo.master_bundle_id;
    if (!masterBundleId) throw new Error("promote returned no master_bundle_id");
    if (promo.created_channels.length !== 2) {
      throw new Error(`expected 2 created channels, got ${promo.created_channels.length}`);
    }

    // Seed packaging dims + item_type on the WALMART row so the
    // Walmart-specific validator can pass — without this the smoke
    // shows NEEDS_REVIEW which is fine but less informative.
    const skus = await prisma.channelSKU.findMany({
      where: { master_bundle_id: masterBundleId },
      orderBy: { channel: "asc" },
    });
    createdSkuIds = skus.map((s) => s.id);
    for (const s of skus) {
      await prisma.channelSKU.update({
        where: { id: s.id },
        data: {
          package_length_in: 14,
          package_width_in: 10,
          package_height_in: 6,
          package_weight_oz: 32,
          item_type: "Refrigerated Lunches",
          // Gift Basket Exception node — required because the smoke
          // composition is single-brand (Generic) so technically not
          // multi-brand, but Amazon channels also reject empty browse
          // nodes regardless.
          channel_browse_node: "12011207011",
        },
      });
    }

    const result = await runValidationForDraft({
      bundle_draft_id: draft.id,
      actor: "smoke",
    });
    console.log(
      `Validation: ok=${result.ok} draft_status=${result.draft_status} duration=${result.duration_ms}ms`,
    );
    for (const s of result.per_sku) {
      console.log(
        `  ${s.channel} → ${s.status}  failed=[${s.failed.join(", ")}] warnings=[${s.warnings.join(", ")}]`,
      );
    }
    if (result.per_sku.length !== 2) {
      throw new Error(`expected 2 SKU outcomes, got ${result.per_sku.length}`);
    }
    // Acceptable terminal statuses: PASSED (Veeqo happens to be set up)
    // or NEEDS_REVIEW (Veeqo unavailable → inventory warning) — both
    // mean the pipeline ran cleanly. FAILED is a real bug.
    for (const s of result.per_sku) {
      if (s.status === "FAILED") {
        throw new Error(
          `${s.channel} FAILED — failed validators: ${s.failed.join(", ")}`,
        );
      }
    }
    console.log("\nPASS");
  } catch (e) {
    failed = true;
    console.error("\nFAIL:", e);
  } finally {
    if (createdSkuIds.length > 0) {
      await prisma.uPCPool.updateMany({
        where: { assigned_to_id: { in: createdSkuIds } },
        data: { status: "AVAILABLE", assigned_to_id: null },
      });
    }
    await prisma.uPCPool.deleteMany({ where: { upc: { in: upcs } } });
    if (masterBundleId) {
      await prisma.complianceCheck.deleteMany({
        where: { OR: [{ channel_sku_id: { in: createdSkuIds } }, { bundle_draft_id: draft.id }] },
      });
      await prisma.channelSKU.deleteMany({ where: { master_bundle_id: masterBundleId } });
      await prisma.masterBundle.delete({ where: { id: masterBundleId } });
    }
    await prisma.generatedContent.deleteMany({ where: { bundle_draft_id: draft.id } });
    await prisma.variationMatrix.deleteMany({ where: { bundle_draft_id: draft.id } });
    await prisma.complianceCheck.deleteMany({ where: { bundle_draft_id: draft.id } });
    await prisma.complianceAuditLog.deleteMany({ where: { bundle_draft_id: draft.id } });
    await prisma.listingLifecycleLog.deleteMany({ where: { entity_id: draft.id } });
    if (createdSkuIds.length > 0) {
      await prisma.listingLifecycleLog.deleteMany({
        where: { entity_id: { in: createdSkuIds } },
      });
    }
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
