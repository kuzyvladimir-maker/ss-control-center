/**
 * Phase 2.1 smoke test — exercise the research pipeline end-to-end
 * against the dev DB using the dev mock fixture (no Perplexity call).
 *
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/smoke-research-pipeline.ts
 *
 * Cleans up after itself.
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { runResearch } from "@/lib/bundle-factory/research-pipeline";

async function main() {
  // Force mock path: empty PERPLEXITY_API_KEY + non-prod NODE_ENV.
  process.env.PERPLEXITY_API_KEY = "";

  const job = await prisma.generationJob.create({
    data: {
      brief: JSON.stringify({ test: true }),
      current_stage: "BRIEF",
      status: "PENDING",
      bundles_target: 1,
      user_id: "smoke",
    },
  });
  const draft = await prisma.bundleDraft.create({
    data: {
      generation_job_id: job.id,
      draft_name: "Smoke Test — Pizza Lunch",
      brand: "Salutem Vita",
      category: "FROZEN_GROCERY",
      composition_type: "CROSS_BRAND",
      pack_count: 12,
      draft_components: JSON.stringify([]),
      target_channels: JSON.stringify(["AMAZON_SALUTEM"]),
      status: "DRAFT",
    },
  });

  let failed = false;
  try {
    console.log(`Created draft ${draft.id}`);
    const result = await runResearch({
      bundle_draft_id: draft.id,
      trigger: "manual",
      actor: "smoke-test",
    });
    console.log(
      `Result: ok=${result.ok} pool=${result.pool_size} mocked=${result.mocked} duration=${result.duration_ms}ms`,
    );
    console.log(`Mirror summary:`, result.mirror_summary);

    const after = await prisma.bundleDraft.findUnique({
      where: { id: draft.id },
    });
    console.log(`Draft status after research: ${after?.status}`);
    if (after?.status !== "RESEARCHED") {
      throw new Error(`expected RESEARCHED, got ${after?.status}`);
    }

    const poolRows = await prisma.researchPool.count({
      where: { generation_job_id: job.id },
    });
    console.log(`Pool rows in DB: ${poolRows}`);
    if (poolRows < 3) throw new Error(`expected >=3 pool rows, got ${poolRows}`);

    const stages = await prisma.generationStage.findMany({
      where: { generation_job_id: job.id },
    });
    console.log(`Stages: ${stages.map((s) => `${s.stage}=${s.status}`).join(", ")}`);

    const logs = await prisma.listingLifecycleLog.findMany({
      where: { entity_id: draft.id },
    });
    console.log(`Lifecycle logs: ${logs.length}`);
    if (logs.length === 0) throw new Error("expected lifecycle log entry");

    console.log("\nPASS");
  } catch (e) {
    failed = true;
    console.error("\nFAIL:", e);
  } finally {
    // Best-effort cleanup so the dev DB stays clean.
    await prisma.researchPool.deleteMany({
      where: { generation_job_id: job.id },
    });
    await prisma.generationStage.deleteMany({
      where: { generation_job_id: job.id },
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
