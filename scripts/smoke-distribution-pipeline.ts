/**
 * Phase 2.5 Stage 7 smoke — end-to-end DRY RUN of the distribution
 * pipeline against the dev DB. NEVER touches Amazon or Walmart; the
 * dry-run branch in distribution-pipeline returns simulated payloads.
 *
 * Seeds:
 *   GenerationJob → BundleDraft (status=VALIDATED) → VariationMatrix →
 *   MasterBundle → 4 ChannelSKU rows:
 *     - AMAZON_SALUTEM  validation=PASSED listing=PENDING  → SUBMITTED
 *     - WALMART         validation=PASSED listing=PENDING  → SUBMITTED
 *     - AMAZON_RETAILER validation=PASSED listing=PENDING  → SKIPPED (suspended)
 *     - AMAZON_SIRIUS   validation=PASSED listing=PENDING  → SKIPPED (no app)
 *   + 4 AVAILABLE UPCs (one per SKU; will be left as-is since smoke
 *     doesn't promote).
 *
 * Asserts:
 *   1. apply=false (default) returns dry_run=true outcomes for all 4 SKUs
 *   2. Two are SUBMITTED, two SKIPPED
 *   3. DB rows untouched (listing_status still PENDING after dry-run)
 *   4. Payload shape readable in outcome.payload
 *
 * Run with:
 *   npx tsx scripts/smoke-distribution-pipeline.ts
 *
 * Cleans up after itself.
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { runDistribution } from "@/lib/bundle-factory/distribution/distribution-pipeline";

async function main() {
  const job = await prisma.generationJob.create({
    data: {
      brief: JSON.stringify({ test: true, phase: "2.5" }),
      current_stage: "BRIEF",
      status: "PENDING",
      bundles_target: 1,
      user_id: "smoke",
    },
  });
  const masterSlug = `smoke-distribution-${Math.random().toString(36).slice(2, 8)}`;
  const masterBundle = await prisma.masterBundle.create({
    data: {
      name: "Phase 2.5 Smoke — Distribution dry-run",
      internal_slug: masterSlug,
      brand: "Salutem Vita",
      category: "REFRIGERATED",
      composition_type: "SINGLE_FLAVOR",
      pack_count: 9,
      cost_breakdown: JSON.stringify({}),
      estimated_cost_cents: 1000,
      suggested_price_cents: 3000,
      packaging_spec: JSON.stringify({}),
      main_image_url: "https://example.com/main.png",
      secondary_images: JSON.stringify([]),
    },
  });
  const draft = await prisma.bundleDraft.create({
    data: {
      generation_job_id: job.id,
      master_bundle_id: masterBundle.id,
      draft_name: "Smoke draft",
      brand: "Salutem Vita",
      category: "REFRIGERATED",
      composition_type: "SINGLE_FLAVOR",
      pack_count: 9,
      draft_components: JSON.stringify([]),
      target_channels: JSON.stringify(["AMAZON_SALUTEM", "WALMART"]),
      status: "VALIDATED",
    },
  });

  const channelDefs = [
    { channel: "AMAZON_SALUTEM",  sku: "SV-AS01-A001", upc: "900000000018" },
    { channel: "WALMART",         sku: "SV-WM01-A002", upc: "900000000025" },
    { channel: "AMAZON_RETAILER", sku: "SV-AR01-A003", upc: "900000000032" },
    { channel: "AMAZON_SIRIUS",   sku: "SV-AX01-A004", upc: "900000000049" },
  ];

  const createdSkuIds: string[] = [];
  for (const def of channelDefs) {
    const sku = await prisma.channelSKU.create({
      data: {
        master_bundle_id: masterBundle.id,
        channel: def.channel,
        sku: def.sku,
        upc: def.upc,
        title: "Salutem Vita Smoke Lunch Variety Gift Basket Pack of 9",
        bullets: JSON.stringify([
          "Includes nine single-serve refrigerated lunch trays.",
          "Refrigerator-stable until the printed use-by date on each tray.",
          "Curated and assembled by Salutem Solutions LLC as a gift basket.",
        ]),
        description: "Variety pack of nine single-serve lunches.",
        attributes: JSON.stringify({}),
        price_cents: 2500,
        channel_browse_node: "12011207011",
        main_image_url: "https://example.com/main.png",
        compliance_status: "CAN_PUBLISH",
        validation_status: "PASSED",
        package_length_in: 14,
        package_width_in: 10,
        package_height_in: 6,
        package_weight_oz: 32,
        country_of_origin: "US",
        item_type: "Refrigerated Lunches",
      },
    });
    createdSkuIds.push(sku.id);
  }

  let failed = false;
  try {
    console.log(`Created draft ${draft.id} + master ${masterBundle.id} + 4 SKUs`);

    const result = await runDistribution({
      bundle_draft_id: draft.id,
      apply: false, // SAFETY — dry run
      actor: "smoke",
    });
    console.log(
      `Distribution: ok=${result.ok} apply=${result.apply} aborted=${result.aborted} draft_status=${result.draft_status} duration=${result.duration_ms}ms`,
    );
    for (const o of result.per_sku) {
      console.log(
        `  ${o.channel} → ${o.status}  marketplace=${o.marketplace_status ?? "-"} dry_run=${o.dry_run}${o.skip_reason ? ` [SKIP: ${o.skip_reason.slice(0, 60)}]` : ""}`,
      );
    }

    if (result.apply !== false) throw new Error("expected apply=false (smoke default)");
    if (result.per_sku.length !== 4) {
      throw new Error(`expected 4 outcomes, got ${result.per_sku.length}`);
    }
    const submitted = result.per_sku.filter((o) => o.status === "SUBMITTED");
    const skipped = result.per_sku.filter((o) => o.status === "SKIPPED");
    if (submitted.length !== 2) {
      throw new Error(`expected 2 SUBMITTED dry-run, got ${submitted.length}`);
    }
    if (skipped.length !== 2) {
      throw new Error(
        `expected 2 SKIPPED (RETAILER + SIRIUS), got ${skipped.length}`,
      );
    }
    // Dry-run must NOT mutate DB.
    for (const sku of await prisma.channelSKU.findMany({
      where: { id: { in: createdSkuIds } },
      select: { listing_status: true, distribution_attempt_count: true },
    })) {
      if (sku.listing_status !== "PENDING") {
        throw new Error(`dry-run mutated listing_status to ${sku.listing_status}`);
      }
      if (sku.distribution_attempt_count !== 0) {
        throw new Error(`dry-run bumped attempt count`);
      }
    }
    // Payload should be readable on SUBMITTED outcomes.
    for (const s of submitted) {
      if (!s.payload || Object.keys(s.payload).length === 0) {
        throw new Error(`${s.channel} payload empty`);
      }
    }
    console.log("\nPASS");
  } catch (e) {
    failed = true;
    console.error("\nFAIL:", e);
  } finally {
    await prisma.listingLifecycleLog.deleteMany({
      where: { entity_id: { in: [...createdSkuIds, draft.id] } },
    });
    await prisma.channelSKU.deleteMany({ where: { master_bundle_id: masterBundle.id } });
    await prisma.bundleDraft.delete({ where: { id: draft.id } });
    await prisma.masterBundle.delete({ where: { id: masterBundle.id } });
    await prisma.generationJob.delete({ where: { id: job.id } });
    console.log("Cleanup complete");
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
