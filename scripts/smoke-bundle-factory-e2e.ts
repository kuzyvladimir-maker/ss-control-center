/**
 * End-to-end smoke test for the Bundle Factory happy path.
 *
 * Runs the full 14-step pipeline for BOTH composition types that exercise
 * different compliance paths:
 *
 *   SINGLE_FLAVOR (single brand) — rule-5 trivially passes; sanity-checks
 *                                  the validator pipeline.
 *   MIXED_FLAVOR  (multi brand)  — promote-draft must auto-set the Gift
 *                                  Basket Exception browse_node so rule-5
 *                                  doesn't BLOCK and validator-amazon-
 *                                  browse-node passes.
 *
 * Cost: 2 real Claude calls (one per composition type). ~$0.05 total.
 *
 * Prereq:
 *   - dev server is up on $SMOKE_BASE_URL (default http://localhost:3456).
 *     Start it with BUNDLE_FACTORY_VISION_SKIP=1 so Rule 6 doesn't try
 *     to feed the mock image URL through Claude Vision — without that
 *     env var the rerun-compliance validator fails with
 *     image_vision_error and step 13 trips:
 *       BUNDLE_FACTORY_VISION_SKIP=1 PORT=3456 npm run dev
 *   - SSCC_API_TOKEN is set in .env so the bearer-auth path works
 *   - UPCPool has ≥2 AVAILABLE rows for the brand under test
 *   - ANTHROPIC_API_KEY is set (required for Stage 4 content generation)
 *
 * Run:  npx tsx scripts/smoke-bundle-factory-e2e.ts
 *       SMOKE_KEEP=1 npx tsx scripts/smoke-bundle-factory-e2e.ts
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3456";
const TOKEN = (process.env.SSCC_API_TOKEN ?? "").trim();
if (!TOKEN) {
  console.error("SSCC_API_TOKEN is missing — required for bearer auth");
  process.exit(1);
}

interface StepResult {
  n: number;
  label: string;
  ok: boolean;
  detail?: string;
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

interface RunInput {
  compositionType: "SINGLE_FLAVOR" | "MIXED_FLAVOR";
  draftName: string;
  /** When false, leaves the test entities in DB for inspection. */
  cleanup: boolean;
}

interface RunOutput {
  steps: StepResult[];
  /** Auto-selected browse_node on the ChannelSKU, if any. */
  channelBrowseNode: string | null;
  /** Number of validators reported in per_sku[0].results, if reached. */
  validatorCount: number | null;
}

async function runSmoke(input: RunInput): Promise<RunOutput> {
  const tag = input.compositionType;
  const steps: StepResult[] = [];
  let channelBrowseNode: string | null = null;
  let validatorCount: number | null = null;

  const record = (n: number, label: string, ok: boolean, detail?: string) => {
    steps.push({ n, label, ok, detail });
    const flag = ok ? "PASS" : "FAIL";
    console.log(`[${tag}][${String(n).padStart(2, "0")}] ${flag} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  let briefId = "";
  let masterBundleId = "";
  let createdChannelSkuIds: string[] = [];

  try {
    // ─ STEP 1: create brief
    const create = await hit<{ brief: { id: string; status: string } }>(
      "POST",
      "/api/bundle-factory/briefs",
      {
        draft_name: input.draftName,
        brand: "Salutem Vita",
        category: "FROZEN_GROCERY",
        composition_type: input.compositionType,
        pack_count: 3,
        target_channels: ["AMAZON_AMZCOM"],
        draft_components: [],
      },
    );
    if (create.status !== 201 || !create.data?.brief?.id) {
      record(1, "create brief", false, `status=${create.status}`);
      return { steps, channelBrowseNode, validatorCount };
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
    if (!okResearch) return { steps, channelBrowseNode, validatorCount };

    // ─ STEP 3: pool_size ≥ 5
    const poolSize = research.data.pool_size ?? 0;
    record(3, "pool_size ≥ 5", poolSize >= 5, `pool_size=${poolSize}`);
    if (poolSize < 5) return { steps, channelBrowseNode, validatorCount };

    // ─ STEP 4: approve-research → VARIATION_SELECTED
    const approve = await hit<unknown>(
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
    if (!okApprove) return { steps, channelBrowseNode, validatorCount };

    // ─ STEP 5: generate-variations
    const variations = await hit<unknown>(
      "POST",
      `/api/bundle-factory/briefs/${briefId}/generate-variations`,
      {},
    );
    const matrix = await prisma.variationMatrix.findUnique({
      where: { bundle_draft_id: briefId },
    });
    const variantCount = (() => {
      if (!matrix?.variants_json) return 0;
      try {
        const arr = JSON.parse(matrix.variants_json);
        return Array.isArray(arr) ? arr.length : 0;
      } catch {
        return 0;
      }
    })();
    const okVariations = variations.status === 200 && variantCount >= 1;
    record(
      5,
      "generate-variations",
      okVariations,
      `status=${variations.status} variants=${variantCount}`,
    );
    if (!okVariations) return { steps, channelBrowseNode, validatorCount };

    // ─ STEP 6: select-variation
    const select = await hit<unknown>(
      "POST",
      `/api/bundle-factory/briefs/${briefId}/select-variation`,
      { variant_idx: 0 },
    );
    record(6, "select-variation idx=0", select.status === 200, `status=${select.status}`);
    if (select.status !== 200) return { steps, channelBrowseNode, validatorCount };

    // ─ STEP 7: generate-content (REAL Claude)
    console.log(`[${tag}][07] calling generate-content (real Claude, may take 30-90s) …`);
    const content = await hit<{ total_cost_cents?: number }>(
      "POST",
      `/api/bundle-factory/drafts/${briefId}/generate-content`,
      {},
    );
    const okContent = content.status === 200;
    record(
      7,
      "generate-content (REAL Claude)",
      okContent,
      `status=${content.status} cost_cents=${content.data?.total_cost_cents}`,
    );
    if (!okContent) return { steps, channelBrowseNode, validatorCount };

    // ─ STEP 8: GeneratedContent rows + at least 1 CAN_PUBLISH
    const generatedRows = await prisma.generatedContent.findMany({
      where: { bundle_draft_id: briefId },
      select: { channel: true, compliance_status: true, failed_rule_ids: true },
    });
    const okGenerated =
      generatedRows.length >= 1 &&
      generatedRows.some((r) => r.compliance_status === "CAN_PUBLISH");
    record(
      8,
      "≥1 CAN_PUBLISH GeneratedContent row",
      okGenerated,
      `count=${generatedRows.length} compliance=${generatedRows.map((r) => r.compliance_status).join(",")}`,
    );
    if (!okGenerated) {
      for (const r of generatedRows) {
        if (r.failed_rule_ids) {
          console.log(`     [${r.channel}] failed_rule_ids=${r.failed_rule_ids}`);
        }
      }
      return { steps, channelBrowseNode, validatorCount };
    }

    // ─ STEP 9: skip image generation; patch in a loadable 2000×2000 URL
    // placehold.co returns a real PNG so rule-6's image vision check has
    // something to fetch (otherwise it errors as image_vision_error).
    // 2000×2000 clears validator-image-dimensions' minimum for Amazon
    // (1024×1024 would trip it). Operator-filled fields on the
    // ChannelSKU (package_*) are patched after promote, just below.
    await prisma.generatedContent.updateMany({
      where: { bundle_draft_id: briefId, compliance_status: "CAN_PUBLISH" },
      data: {
        main_image_url:
          "https://placehold.co/2000x2000/e5e5e5/666666.png?text=smoke",
      },
    });
    record(9, "patch mock main_image_url (skip image gen)", true);

    // ─ STEP 10: validate (promote + run validators)
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
          channel: string;
          status: string;
          failed: string[];
          warnings: string[];
          duration_ms: number;
          results?: Array<{
            validator_id: string;
            passed: boolean;
            severity?: "error" | "warning";
            message?: string;
          }>;
        }>;
        draft_status?: string;
      };
    }>("POST", `/api/bundle-factory/drafts/${briefId}/validate`, {});
    const promoted = validate.data?.promote;
    masterBundleId = promoted?.master_bundle_id ?? "";
    const createdCount = promoted?.created_channels?.length ?? 0;
    const existingCount = promoted?.existing_channels?.length ?? 0;
    const okPromote = validate.status === 200 && (createdCount + existingCount) > 0;
    record(
      10,
      "promote → ChannelSKU",
      okPromote,
      `created=${createdCount} existing=${existingCount} master_bundle=${masterBundleId}`,
    );
    if (promoted?.skipped?.length) {
      for (const s of promoted.skipped) console.log(`     skip [${s.channel}]: ${s.reason}`);
    }
    if (!okPromote) return { steps, channelBrowseNode, validatorCount };

    // ─ STEP 11: ChannelSKU has 12-digit pool UPC + browse_node set
    const channelSkus = await prisma.channelSKU.findMany({
      where: { master_bundle_id: masterBundleId },
      select: { id: true, channel: true, upc: true, sku: true, channel_browse_node: true },
    });
    createdChannelSkuIds = channelSkus.map((s) => s.id);
    channelBrowseNode = channelSkus[0]?.channel_browse_node ?? null;
    const okUpcs = channelSkus.length > 0 && channelSkus.every((s) => /^\d{12}$/.test(s.upc));
    record(
      11,
      "ChannelSKU has UPC from pool",
      okUpcs,
      `count=${channelSkus.length} upcs=${channelSkus.map((s) => s.upc).join(",")} browse_node=${channelBrowseNode}`,
    );
    if (!okUpcs) return { steps, channelBrowseNode, validatorCount };

    // ─ STEP 12: UPCPool flipped → ASSIGNED
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

    // Patch operator-filled fields on the ChannelSKU rows so
    // validator-packaging-dims, validator-weight and
    // validator-country-of-origin clear. In production these come from
    // the Vladimir-fills-pricing UI on the Master Bundles page.
    await prisma.channelSKU.updateMany({
      where: { id: { in: createdChannelSkuIds } },
      data: {
        package_length_in: 10,
        package_width_in: 8,
        package_height_in: 6,
        package_weight_oz: 40,
        country_of_origin: "US",
      },
    });

    // ─ STEP 13: re-run validation after ChannelSKU patch and inspect
    // per-validator results. The earlier validate (step 10) ran with
    // null dims so validator-packaging-dims and validator-weight tripped.
    // With the patch above they should clear; we re-call validate to get
    // a fresh per_sku result that reflects the patched state.
    const validate2 = await hit<{
      validation?: {
        ok: boolean;
        per_sku?: Array<{
          status: string;
          results?: Array<{
            validator_id: string;
            passed: boolean;
            severity?: "error" | "warning";
            message?: string;
          }>;
        }>;
      };
    }>("POST", `/api/bundle-factory/drafts/${briefId}/validate`, {});
    const v = validate2.data?.validation;
    const firstSku = v?.per_sku?.[0];
    const results = firstSku?.results ?? [];
    validatorCount = results.length;
    const errors = results.filter((r) => !r.passed && r.severity === "error");
    const warnings = results.filter((r) => !r.passed && r.severity === "warning");
    const skuStatus = firstSku?.status ?? "?";
    const okValidation = validatorCount >= 14 && errors.length === 0;
    record(
      13,
      "validation: ≥14 validators ran, 0 errors",
      okValidation,
      `runs=${validatorCount} errors=${errors.length} warnings=${warnings.length} sku.status=${skuStatus}`,
    );
    if (errors.length) {
      for (const e of errors.slice(0, 5)) {
        console.log(`     err: ${e.validator_id} — ${e.message}`);
      }
    }
  } finally {
    // ─ STEP 14: cleanup
    if (!input.cleanup) {
      console.log(`[${tag}][14] (skipped — SMOKE_KEEP=1)`);
      console.log(`     briefId=${briefId}`);
      console.log(`     masterBundleId=${masterBundleId}`);
      console.log(`     channelSkuIds=${createdChannelSkuIds.join(",")}`);
    } else if (briefId) {
      try {
        if (createdChannelSkuIds.length > 0) {
          await prisma.uPCPool.updateMany({
            where: { assigned_to_id: { in: createdChannelSkuIds } },
            data: { status: "AVAILABLE", assigned_to_id: null },
          });
          await prisma.channelSKU.deleteMany({
            where: { id: { in: createdChannelSkuIds } },
          });
        }
        if (masterBundleId) {
          await prisma.listingLifecycleLog.deleteMany({
            where: { master_bundle_id: masterBundleId },
          });
          await prisma.masterBundle.deleteMany({ where: { id: masterBundleId } });
        }
        await prisma.generatedContent.deleteMany({ where: { bundle_draft_id: briefId } });
        await prisma.variationMatrix.deleteMany({ where: { bundle_draft_id: briefId } });
        await prisma.complianceCheck.deleteMany({ where: { bundle_draft_id: briefId } });
        const job = await prisma.bundleDraft.findUnique({
          where: { id: briefId },
          select: { generation_job_id: true },
        });
        await prisma.bundleDraft.delete({ where: { id: briefId } });
        if (job?.generation_job_id) {
          await prisma.researchPool.deleteMany({
            where: { generation_job_id: job.generation_job_id },
          });
          await prisma.generationJob.delete({ where: { id: job.generation_job_id } });
        }
        record(14, "cleanup test entities", true);
      } catch (e) {
        record(14, "cleanup test entities", false, (e as Error).message);
      }
    }
  }

  return { steps, channelBrowseNode, validatorCount };
}

async function main() {
  const cleanup = process.env.SMOKE_KEEP !== "1";
  console.log(`Smoke base: ${BASE_URL}`);
  console.log(`Cleanup after each run: ${cleanup}`);
  console.log("");

  const runs: Array<{ name: string; out: RunOutput }> = [];
  for (const cfg of [
    { compositionType: "SINGLE_FLAVOR", draftName: "SMOKE-E2E-SINGLE-DELETE-ME" },
    { compositionType: "MIXED_FLAVOR", draftName: "SMOKE-E2E-MIXED-DELETE-ME" },
  ] as const) {
    console.log(`── Running ${cfg.compositionType} ──`);
    const out = await runSmoke({ ...cfg, cleanup });
    runs.push({ name: cfg.compositionType, out });
    console.log("");
  }

  // Summary
  console.log("==== SMOKE SUMMARY ====");
  let totalPass = 0;
  let totalSteps = 0;
  for (const { name, out } of runs) {
    const pass = out.steps.filter((r) => r.ok).length;
    const total = out.steps.length;
    totalPass += pass;
    totalSteps += total;
    console.log(
      `  ${name.padEnd(15)} ${pass}/${total} PASS  ·  browse_node=${out.channelBrowseNode ?? "<none>"}  ·  validators_run=${out.validatorCount ?? "<n/a>"}`,
    );
    for (const s of out.steps.filter((r) => !r.ok)) {
      console.log(`     FAIL [${s.n}] ${s.label} — ${s.detail ?? ""}`);
    }
  }
  console.log("");
  console.log(`==== TOTAL: ${totalPass}/${totalSteps} PASS ====`);
  if (totalPass < totalSteps) process.exit(2);
}

main()
  .catch((err) => {
    console.error("smoke fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
