/**
 * End-to-end smoke test for the Bundle Factory happy path.
 *
 * Drives every step a real operator hits — create brief, research,
 * approve research, generate variations, select one, generate content
 * (REAL Claude call — billable), patch in a mock image URL, promote to
 * MasterBundle + ChannelSKU (allocates a UPC from the pool), and run
 * validation.
 *
 * Cost: one POST to /drafts/[id]/generate-content. With a single
 * target channel that's typically $0.05 – $0.20 per run.
 *
 * Prereq:
 *   - dev server is up on $SMOKE_BASE_URL (default http://localhost:3456)
 *   - SSCC_API_TOKEN is set in .env so the bearer-auth path works
 *   - UPCPool has ≥1 AVAILABLE row for the brand under test
 *   - ANTHROPIC_API_KEY is set (required for Stage 4 content generation)
 *
 * Run:  npx tsx scripts/smoke-bundle-factory-e2e.ts
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3456";
const TOKEN = (process.env.SSCC_API_TOKEN ?? "").trim();
if (!TOKEN) {
  console.error("SSCC_API_TOKEN is missing — required for bearer auth");
  process.exit(1);
}

const STEP_RESULTS: Array<{ n: number; label: string; ok: boolean; detail?: string }> = [];

function record(n: number, label: string, ok: boolean, detail?: string) {
  STEP_RESULTS.push({ n, label, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${String(n).padStart(2, "0")}] ${tag} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function hit<T = unknown>(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  return { status: res.status, data };
}

async function main() {
  console.log(`Smoke base: ${BASE_URL}`);
  console.log("");

  let briefId = "";
  let masterBundleId = "";
  let createdChannelSkuIds: string[] = [];

  try {
    // ─ STEP 1: create brief
    const create = await hit<{ brief: { id: string; status: string } }>(
      "POST",
      "/api/bundle-factory/briefs",
      {
        draft_name: "SMOKE-E2E-DELETE-ME",
        brand: "Salutem Vita",
        category: "FROZEN_GROCERY",
        // SINGLE_FLAVOR keeps the variant single-brand, which satisfies
        // compliance rule-5 (multi-brand requires Gift Basket Exception
        // browse_node — irrelevant here). MIXED_FLAVOR / CROSS_BRAND
        // would force rule-5 BLOCK without an exception node configured.
        composition_type: "SINGLE_FLAVOR",
        pack_count: 3,
        target_channels: ["AMAZON_AMZCOM"],
        draft_components: [],
      },
    );
    if (create.status !== 201 || !create.data?.brief?.id) {
      record(1, "create brief", false, `status=${create.status}`);
      return;
    }
    briefId = create.data.brief.id;
    record(1, "create brief", true, `id=${briefId}`);

    // ─ STEP 2: research/run
    const research = await hit<{ ok: boolean; pool_size?: number; mocked?: boolean }>(
      "POST",
      "/api/bundle-factory/research/run",
      { bundle_draft_id: briefId, trigger: "manual" },
    );
    const okResearch = research.status === 200 && research.data?.ok === true;
    record(
      2,
      "research/run",
      okResearch,
      `status=${research.status} pool_size=${research.data?.pool_size} mocked=${research.data?.mocked}`,
    );
    if (!okResearch) return;

    // ─ STEP 3: verify pool_size ≥ 5
    const poolSize = research.data.pool_size ?? 0;
    record(3, "pool_size ≥ 5", poolSize >= 5, `pool_size=${poolSize}`);
    if (poolSize < 5) return;

    // ─ STEP 4: approve-research (DRAFT → VARIATION_SELECTED)
    const approve = await hit<{ status: string }>(
      "POST",
      `/api/bundle-factory/briefs/${briefId}/approve-research`,
      {},
    );
    const briefAfterApprove = await prisma.bundleDraft.findUnique({
      where: { id: briefId },
      select: { status: true },
    });
    const okApprove =
      approve.status === 200 && briefAfterApprove?.status === "VARIATION_SELECTED";
    record(
      4,
      "approve-research → VARIATION_SELECTED",
      okApprove,
      `status=${approve.status} draft.status=${briefAfterApprove?.status}`,
    );
    if (!okApprove) return;

    // ─ STEP 5: generate-variations
    const variations = await hit<{ variants?: unknown[] }>(
      "POST",
      `/api/bundle-factory/briefs/${briefId}/generate-variations`,
      {},
    );
    const variantCount = await prisma.variationMatrix
      .findUnique({ where: { bundle_draft_id: briefId } })
      .then((m) => {
        if (!m?.variants_json) return 0;
        try {
          const arr = JSON.parse(m.variants_json);
          return Array.isArray(arr) ? arr.length : 0;
        } catch {
          return 0;
        }
      });
    const okVariations = variations.status === 200 && variantCount >= 1;
    record(
      5,
      "generate-variations",
      okVariations,
      `status=${variations.status} variants=${variantCount}`,
    );
    if (!okVariations) return;

    // ─ STEP 6: select-variation (idx 0)
    const select = await hit<{ ok?: boolean }>(
      "POST",
      `/api/bundle-factory/briefs/${briefId}/select-variation`,
      { variant_idx: 0 },
    );
    record(6, "select-variation idx=0", select.status === 200, `status=${select.status}`);
    if (select.status !== 200) return;

    // ─ STEP 7: generate-content (REAL Claude — billable)
    console.log("[07] calling generate-content (real Claude, may take 30-90s) …");
    const content = await hit<{ ok?: boolean; rows_processed?: number; total_cost_cents?: number }>(
      "POST",
      `/api/bundle-factory/drafts/${briefId}/generate-content`,
      {},
    );
    const okContent = content.status === 200;
    record(
      7,
      "generate-content (REAL Claude)",
      okContent,
      `status=${content.status} rows=${content.data?.rows_processed} cost_cents=${content.data?.total_cost_cents}`,
    );
    if (!okContent) return;

    // ─ STEP 8: verify GeneratedContent rows exist
    const generatedRows = await prisma.generatedContent.findMany({
      where: { bundle_draft_id: briefId },
      select: { channel: true, compliance_status: true, title: true },
    });
    const okGenerated = generatedRows.length >= 1;
    record(
      8,
      "GeneratedContent rows created",
      okGenerated,
      `count=${generatedRows.length} channels=${generatedRows.map((r) => r.channel).join(",")} compliance=${generatedRows.map((r) => r.compliance_status).join(",")}`,
    );
    if (!okGenerated) return;

    // Need CAN_PUBLISH rows for promote step. If any are BLOCKED, smoke
    // halts (operator would normally fix via Compliance dashboard).
    const canPublishCount = generatedRows.filter((r) => r.compliance_status === "CAN_PUBLISH").length;
    if (canPublishCount === 0) {
      record(
        8,
        "at least 1 CAN_PUBLISH row",
        false,
        `all BLOCKED — see Compliance dashboard; skipping promote/validate`,
      );
      return;
    }

    // ─ STEP 9: skip image generation; patch in mock image URLs
    await prisma.generatedContent.updateMany({
      where: { bundle_draft_id: briefId, compliance_status: "CAN_PUBLISH" },
      data: { main_image_url: "https://example.com/smoke-mock-image.jpg" },
    });
    record(9, "patch mock main_image_url (skip image gen)", true);

    // ─ STEP 10: promote → ChannelSKU (validate route does it implicitly)
    const validate = await hit<{
      promote?: {
        master_bundle_id?: string;
        created_channels?: string[];
        existing_channels?: string[];
        skipped?: Array<{ channel: string; reason: string }>;
      };
      validation?: {
        ok: boolean;
        master_bundle_id?: string | null;
        per_sku?: Array<{
          sku_id: string;
          validator_id: string;
          passed: boolean;
          severity?: string;
        }>;
        draft_status?: string;
        note?: string;
      };
    }>(
      "POST",
      `/api/bundle-factory/drafts/${briefId}/validate`,
      {},
    );
    const promoted = validate.data?.promote;
    masterBundleId = promoted?.master_bundle_id ?? "";
    const createdCount = promoted?.created_channels?.length ?? 0;
    const existingCount = promoted?.existing_channels?.length ?? 0;
    const skippedCount = promoted?.skipped?.length ?? 0;
    const okPromote = validate.status === 200 && (createdCount + existingCount) > 0;
    record(
      10,
      "promote → ChannelSKU",
      okPromote,
      `created=${createdCount} existing=${existingCount} skipped=${skippedCount} master_bundle=${masterBundleId}`,
    );
    if (promoted?.skipped?.length) {
      for (const s of promoted.skipped) console.log(`     skip [${s.channel}]: ${s.reason}`);
    }
    if (!okPromote) return;

    // ─ STEP 11: verify ChannelSKU created with a real UPC from pool
    const channelSkus = await prisma.channelSKU.findMany({
      where: { master_bundle_id: masterBundleId },
      select: { id: true, channel: true, upc: true, sku: true, upc_pool_id: true },
    });
    createdChannelSkuIds = channelSkus.map((s) => s.id);
    const okUpcs = channelSkus.length > 0 && channelSkus.every((s) => /^\d{12}$/.test(s.upc));
    record(
      11,
      "ChannelSKU has UPC from pool",
      okUpcs,
      `count=${channelSkus.length} upcs=${channelSkus.map((s) => s.upc).join(",")}`,
    );
    if (!okUpcs) return;

    // Confirm UPCs are linked back to UPCPool rows that are now ASSIGNED
    const linkedPoolRows = await prisma.uPCPool.findMany({
      where: { upc: { in: channelSkus.map((s) => s.upc) } },
      select: { upc: true, status: true, assigned_to_id: true },
    });
    const allAssigned =
      linkedPoolRows.length === channelSkus.length &&
      linkedPoolRows.every((r) => r.status === "ASSIGNED" && r.assigned_to_id);
    record(
      12,
      "UPCPool rows flipped to ASSIGNED",
      allAssigned,
      `${linkedPoolRows.filter((r) => r.status === "ASSIGNED").length}/${channelSkus.length} assigned`,
    );

    // ─ STEP 13: inspect validation result
    const v = validate.data?.validation;
    const validatorRuns = v?.per_sku ?? [];
    const errors = validatorRuns.filter((r) => !r.passed && r.severity === "error");
    const warnings = validatorRuns.filter((r) => !r.passed && r.severity === "warning");
    const validationPassed =
      v != null &&
      (v.ok === true || (errors.length === 0 && warnings.length >= 0));
    record(
      13,
      "validation: 0 errors (warnings allowed)",
      validationPassed,
      `runs=${validatorRuns.length} errors=${errors.length} warnings=${warnings.length} ok=${v?.ok}`,
    );
    if (errors.length) {
      for (const e of errors.slice(0, 5)) {
        console.log(`     err: ${e.validator_id} sku=${e.sku_id}`);
      }
    }
  } finally {
    // ─ STEP 14: cleanup. Hard-delete in dependency order so reruns are clean.
    if (process.env.SMOKE_KEEP === "1") {
      console.log("");
      console.log(`SMOKE_KEEP=1 → leaving test entities in DB for inspection.`);
      console.log(`  briefId=${briefId}`);
      console.log(`  masterBundleId=${masterBundleId}`);
      console.log(`  channelSkuIds=${createdChannelSkuIds.join(",")}`);
    } else if (briefId) {
      try {
        if (createdChannelSkuIds.length > 0) {
          // Release UPCs first so they go back to AVAILABLE
          await prisma.uPCPool.updateMany({
            where: { assigned_to_id: { in: createdChannelSkuIds } },
            data: { status: "AVAILABLE", assigned_to_id: null },
          });
          await prisma.channelSKU.deleteMany({
            where: { id: { in: createdChannelSkuIds } },
          });
        }
        if (masterBundleId) {
          await prisma.masterBundle.deleteMany({ where: { id: masterBundleId } });
        }
        await prisma.generatedContent.deleteMany({ where: { bundle_draft_id: briefId } });
        await prisma.variationMatrix.deleteMany({ where: { bundle_draft_id: briefId } });
        await prisma.researchPool.deleteMany({
          where: {
            generation_job: {
              bundle_drafts: { some: { id: briefId } },
            },
          },
        });
        await prisma.complianceCheck.deleteMany({ where: { bundle_draft_id: briefId } });
        // Cascade-delete via the generation_job parent
        const job = await prisma.bundleDraft.findUnique({
          where: { id: briefId },
          select: { generation_job_id: true },
        });
        await prisma.bundleDraft.delete({ where: { id: briefId } });
        if (job?.generation_job_id) {
          await prisma.generationJob.delete({ where: { id: job.generation_job_id } });
        }
        record(14, "cleanup test entities", true);
      } catch (e) {
        record(14, "cleanup test entities", false, (e as Error).message);
      }
    }
  }

  // Summary
  const pass = STEP_RESULTS.filter((r) => r.ok).length;
  const total = STEP_RESULTS.length;
  console.log("");
  console.log(`==== SMOKE RESULT: ${pass}/${total} PASS ====`);
  if (pass < total) {
    console.log("FAILED steps:");
    STEP_RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  [${r.n}] ${r.label} — ${r.detail ?? ""}`));
    process.exit(2);
  }
}

main()
  .catch((err) => {
    console.error("smoke fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
