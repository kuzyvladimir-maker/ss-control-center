import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { POST as retiredAmazonAdvisorPaidExecution } from "@/app/api/amazon/growth/advisor/route";
import { POST as legacyStudioGenerate } from "@/app/api/bundle-factory/studio/generate/route";
import { POST as retiredAmazonAdvisorApply } from "@/app/api/amazon/growth/advisor/apply/route";
import { POST as retiredAmazonAdvisorBulkEnqueue } from "@/app/api/amazon/growth/advisor-bulk/route";
import { POST as retiredAmazonAdvisorBulkDrain } from "@/app/api/amazon/growth/advisor-bulk/drain/route";
import { POST as retiredAmazonBulkFixEnqueue } from "@/app/api/amazon/growth/bulk-fix/route";
import { POST as retiredAmazonBulkFixDrain } from "@/app/api/amazon/growth/bulk-fix/drain/route";
import { POST as retiredAmazonChangelogRollback } from "@/app/api/amazon/growth/changelog/rollback/route";
import { POST as amazonHistoryPost } from "@/app/api/amazon/growth/history/route";
import { POST as retiredAmazonOptimizerApply } from "@/app/api/amazon/growth/optimizer/apply/route";
import { GET as retiredAmazonAutoImprove } from "@/app/api/cron/amazon-auto-improve/route";
import { GET as retiredAmazonRemediationWorker } from "@/app/api/cron/amazon-remediation/route";
import { GET as retiredCogsSweep } from "@/app/api/cron/cogs-sweep/route";
import { GET as retiredAmazonRepricer } from "@/app/api/cron/reprice-amazon/route";
import { GET as retiredReferenceEnrichmentWorker } from "@/app/api/cron/reference-enrichment-worker/route";
import { GET as retiredReferenceHarvestWorker } from "@/app/api/cron/reference-harvest-worker/route";
import { GET as retiredWalmartRemediationWorker } from "@/app/api/cron/walmart-remediation-worker/route";
import { POST as retiredReferenceEnrichmentEnqueue } from "@/app/api/reference-catalog/enqueue/route";
import { POST as retiredReferenceHarvestSeed } from "@/app/api/reference-catalog/harvest/route";
import { POST as retiredWalmartGeneratedImageApply } from "@/app/api/walmart/growth/remediation/apply-generated/route";
import { POST as retiredWalmartRemediationEnqueue } from "@/app/api/walmart/growth/remediation/route";
import { LEGACY_AMAZON_LISTING_IMPROVEMENT_RETIRED_REASON } from "@/lib/amazon/growth/product-truth-containment";
import { tools as amazonListingTools } from "@/lib/jackie-mcp/tools/listings";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function source(path: string): string {
  return readFileSync(join(PROJECT, path), "utf8");
}

function tsFiles(path: string): string[] {
  const absolute = join(PROJECT, path);
  const out: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) out.push(...tsFiles(join(path, entry)));
    else if (/\.(?:ts|mjs|js)$/.test(entry) && !/\.test\./.test(entry)) out.push(join(path, entry));
  }
  return out;
}

test("dangerous sourcing workers are absent from automatic cron schedules", () => {
  const config = JSON.parse(source("vercel.json")) as { crons?: { path?: string }[] };
  const paths = new Set((config.crons || []).map((cron) => cron.path));
  assert.equal(paths.has("/api/cron/reference-enrichment-worker"), false);
  assert.equal(paths.has("/api/cron/walmart-remediation-worker"), false);
  assert.equal(paths.has("/api/cron/reference-harvest-worker"), false);
  assert.equal(paths.has("/api/cron/cogs-sweep"), false);
  assert.equal(paths.has("/api/cron/reprice-amazon"), false);
  assert.equal(paths.has("/api/cron/amazon-remediation"), false);
  assert.equal(paths.has("/api/cron/amazon-auto-improve"), false);
});

test("legacy Product Truth workers are hard tombstones with no executable sourcing path", () => {
  const routes = [
    {
      path: "src/app/api/cron/cogs-sweep/route.ts",
      code: "LEGACY_COGS_SWEEP_RETIRED",
    },
    {
      path: "src/app/api/cron/reference-enrichment-worker/route.ts",
      code: "LEGACY_REFERENCE_ENRICHMENT_WORKER_RETIRED",
    },
    {
      path: "src/app/api/cron/reference-harvest-worker/route.ts",
      code: "LEGACY_REFERENCE_HARVEST_WORKER_RETIRED",
    },
  ];
  for (const route of routes) {
    const text = source(route.path);
    assert.match(text, new RegExp(route.code));
    assert.match(text, /status: 410/);
    assert.match(text, /cache-control": "no-store/);
    assert.doesNotMatch(text, /NextRequest|CRON_SECRET|request/i);
    assert.doesNotMatch(text, /SS_(?:COGS|REFERENCE|METERED)_/);
    assert.doesNotMatch(
      text,
      /createClient|currentMeteredRunPermit|decodeMeteredRunPermit|costOneSku|enrichTarget|enqueueEnrichment|seedDonorHarvestState|executeDonorHarvestCandidate|listClaimableDonorHarvestStates|withMeteredProviderCall|@\/lib\/sourcing|INSERT|UPDATE|DELETE|samsclub|costco/i,
    );
  }

  const walmart = source("src/app/api/cron/walmart-remediation-worker/route.ts");
  assert.match(walmart, /LEGACY_WALMART_REMEDIATION_RETIRED/);
  assert.match(walmart, /status: 410/);
  assert.doesNotMatch(walmart, /SS_WALMART_REMEDIATION_WORKER_ENABLED/);
  assert.doesNotMatch(
    walmart,
    /bluecartCreditsRemaining|buildAndSubmitOne|checkFeed|getWalmartClient|createClient|WalmartRemediationQueue/,
  );
});

test("former runtime controls cannot revive retired Product Truth workers", async () => {
  const keys = [
    "CRON_SECRET",
    "SS_COGS_SWEEP_LEGACY_CANARY_ENABLED",
    "SS_REFERENCE_ENRICHMENT_WORKER_ENABLED",
    "SS_REFERENCE_HARVEST_WORKER_ENABLED",
    "SS_METERED_RUN_PERMIT",
    "SS_METERED_RUN_CONFIRM",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CRON_SECRET = "phase0-product-truth-retirement-test";
    process.env.SS_COGS_SWEEP_LEGACY_CANARY_ENABLED = "1";
    process.env.SS_REFERENCE_ENRICHMENT_WORKER_ENABLED = "1";
    process.env.SS_REFERENCE_HARVEST_WORKER_ENABLED = "1";
    process.env.SS_METERED_RUN_PERMIT = "fake-former-permit";
    process.env.SS_METERED_RUN_CONFIRM = "fake-former-confirmation";

    const cases = [
      {
        handler: retiredCogsSweep,
        code: "LEGACY_COGS_SWEEP_RETIRED",
        reason:
          "Legacy COGS sweep is disabled. Use the owner-gated, sealed Product Truth CLI.",
      },
      {
        handler: retiredReferenceEnrichmentWorker,
        code: "LEGACY_REFERENCE_ENRICHMENT_WORKER_RETIRED",
        reason:
          "Legacy enrichment worker is disabled. Use the owner-gated, sealed Product Truth CLI.",
      },
      {
        handler: retiredReferenceHarvestWorker,
        code: "LEGACY_REFERENCE_HARVEST_WORKER_RETIRED",
        reason:
          "Legacy harvest worker is disabled. Use the owner-gated, sealed Product Truth CLI.",
      },
    ];

    for (const item of cases) {
      const response = await item.handler();
      assert.equal(response.status, 410);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        ok: false,
        retired: true,
        code: item.code,
        reason: item.reason,
      });
    }
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("legacy Walmart remediation cannot be revived by its former runtime flag", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.SS_WALMART_REMEDIATION_WORKER_ENABLED;
  try {
    process.env.CRON_SECRET = "phase0-walmart-retirement-test";
    process.env.SS_WALMART_REMEDIATION_WORKER_ENABLED = "1";

    const response = await retiredWalmartRemediationWorker(
      new NextRequest("https://sscc.example/api/cron/walmart-remediation-worker", {
        headers: {
          authorization: "Bearer phase0-walmart-retirement-test",
        },
      }),
    );

    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: false,
      retired: true,
      code: "LEGACY_WALMART_REMEDIATION_RETIRED",
      reason:
        "Legacy paid sourcing and Walmart feed submission are disabled. Use the owner-gated Product Truth cutover path.",
    });
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) {
      delete process.env.SS_WALMART_REMEDIATION_WORKER_ENABLED;
    } else {
      process.env.SS_WALMART_REMEDIATION_WORKER_ENABLED = previousEnabled;
    }
  }
});

test("legacy Bundle Factory Studio cannot bypass the canonical Walmart pilot", async () => {
  const route = source("src/app/api/bundle-factory/studio/generate/route.ts");
  const engine = source("src/lib/bundle-factory/studio-engine.ts");
  const routeFence = route.indexOf("studioChannelRoute(channel)");
  const routeWrite = route.indexOf("prisma.generationJob.create");
  const tickStart = engine.indexOf("export async function tickBatch");
  const engineFence = engine.indexOf("studioChannelRoute(channel)", tickStart);
  const engineDonorRead = engine.indexOf("const donors = await sourceDonors", tickStart);

  assert.ok(routeFence >= 0 && routeFence < routeWrite);
  assert.ok(engineFence >= 0 && engineFence < engineDonorRead);

  const response = await legacyStudioGenerate(
    new NextRequest("https://sscc.example/api/bundle-factory/studio/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Create one shelf-stable multipack",
        channel: "WALMART",
      }),
    }),
  );
  assert.equal(response.status, 400);
  const body = await response.json() as { error?: string };
  assert.match(body.error ?? "", /canonical Bundle Factory Walmart pilot workflow/);
  assert.match(body.error ?? "", /walmart:new-sku/);
});

test("legacy Walmart generated-image apply has no executable feed path", () => {
  const apply = source("src/app/api/walmart/growth/remediation/apply-generated/route.ts");
  assert.match(apply, /LEGACY_WALMART_IMAGE_APPLY_RETIRED/);
  assert.match(apply, /status: 410/);
  assert.doesNotMatch(
    apply,
    /getWalmartClient|submitMainImageOnly|@\/lib\/walmart|request\.json|requestRaw|MP_MAINTENANCE/,
  );
});

test("legacy Walmart generated-image apply always returns a no-store tombstone", async () => {
  const response = await retiredWalmartGeneratedImageApply();
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: false,
    retired: true,
    code: "LEGACY_WALMART_IMAGE_APPLY_RETIRED",
    reason:
      "Legacy Walmart image apply is disabled. Use manifest-bound Product Truth plus a separate owner action gate.",
  });
});

test("legacy Walmart optimizer POST cannot add work to the retired queue", async () => {
  const route = source("src/app/api/walmart/growth/remediation/route.ts");
  const postSource = route.slice(route.indexOf("export async function POST"));
  assert.match(route, /LEGACY_WALMART_REMEDIATION_ENQUEUE_RETIRED/);
  assert.match(postSource, /status: 410/);
  assert.doesNotMatch(
    postSource,
    /request\.json|\$executeRawUnsafe|INSERT|randomUUID|WalmartRemediationQueue/,
  );

  const response = await retiredWalmartRemediationEnqueue();
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: false,
    retired: true,
    code: "LEGACY_WALMART_REMEDIATION_ENQUEUE_RETIRED",
    reason:
      "Legacy Walmart remediation enqueue is disabled. Use the manifest-bound Product Truth preview and a separate owner action gate.",
  });
});

test("manual enrichment and harvest POST handlers are unrevivable hard tombstones", async () => {
  const enqueue = source("src/app/api/reference-catalog/enqueue/route.ts");
  const enqueuePost = enqueue.slice(
    enqueue.indexOf("export async function POST"),
    enqueue.indexOf("export async function GET"),
  );
  assert.match(enqueuePost, /LEGACY_REFERENCE_ENRICHMENT_ENQUEUE_RETIRED/);
  assert.match(enqueuePost, /status: 410/);
  assert.doesNotMatch(
    enqueuePost,
    /request|requireAdmin|createClient|enqueueEnrichment|currentMeteredRunPermit|INSERT|UPDATE|DELETE|samsclub|costco/i,
  );
  assert.match(enqueue, /export async function GET\(request: NextRequest\)/);
  assert.match(enqueue, /requireAdmin\(request\)/);
  assert.match(enqueue, /SELECT id, targetType, target, listingKey, status/);

  const harvest = source("src/app/api/reference-catalog/harvest/route.ts");
  assert.match(harvest, /LEGACY_REFERENCE_HARVEST_SEED_RETIRED/);
  assert.match(harvest, /status: 410/);
  assert.doesNotMatch(
    harvest,
    /NextRequest|request|createClient|seedDonorHarvestState|decodeMeteredRunPermit|INSERT|UPDATE|DELETE|samsclub|costco/i,
  );

  const previous = {
    manualEnrichment: process.env.SS_REFERENCE_ENRICHMENT_MANUAL_ENABLED,
    manualHarvest: process.env.SS_REFERENCE_HARVEST_MANUAL_ENABLED,
    permit: process.env.SS_METERED_RUN_PERMIT,
    confirmation: process.env.SS_METERED_RUN_CONFIRM,
  };
  try {
    process.env.SS_REFERENCE_ENRICHMENT_MANUAL_ENABLED = "1";
    process.env.SS_REFERENCE_HARVEST_MANUAL_ENABLED = "1";
    process.env.SS_METERED_RUN_PERMIT = "fake-former-permit";
    process.env.SS_METERED_RUN_CONFIRM = "fake-former-confirmation";

    const enqueueResponse = await retiredReferenceEnrichmentEnqueue();
    assert.equal(enqueueResponse.status, 410);
    assert.equal(enqueueResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await enqueueResponse.json(), {
      ok: false,
      retired: true,
      code: "LEGACY_REFERENCE_ENRICHMENT_ENQUEUE_RETIRED",
      reason:
        "Legacy manual enrichment enqueue is disabled. Use the owner-gated, sealed Product Truth CLI.",
    });

    const harvestResponse = await retiredReferenceHarvestSeed();
    assert.equal(harvestResponse.status, 410);
    assert.equal(harvestResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await harvestResponse.json(), {
      ok: false,
      retired: true,
      code: "LEGACY_REFERENCE_HARVEST_SEED_RETIRED",
      reason:
        "Legacy manual harvest seeding is disabled. Use the owner-gated, sealed Product Truth CLI.",
    });
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("SS_REFERENCE_ENRICHMENT_MANUAL_ENABLED", previous.manualEnrichment);
    restore("SS_REFERENCE_HARVEST_MANUAL_ENABLED", previous.manualHarvest);
    restore("SS_METERED_RUN_PERMIT", previous.permit);
    restore("SS_METERED_RUN_CONFIRM", previous.confirmation);
  }
});

test("legacy Amazon repricer is a hard tombstone with no executable pricing path", () => {
  const repricer = source("src/app/api/cron/reprice-amazon/route.ts");
  assert.match(repricer, /CRON_SECRET is required/);
  assert.match(repricer, /LEGACY_AMAZON_REPRICER_RETIRED/);
  assert.match(repricer, /status: 410/);
  assert.doesNotMatch(repricer, /SS_AMAZON_REPRICER_/);
  assert.doesNotMatch(
    repricer,
    /repriceStore|getStoreCredentials|sendTelegramMessage|@\/lib\/reprice|@\/lib\/amazon-sp-api|@\/lib\/telegram/,
  );
});

test("former Amazon repricer flags and exact apply query cannot revive it", async () => {
  const previous = {
    cronSecret: process.env.CRON_SECRET,
    enabled: process.env.SS_AMAZON_REPRICER_PRODUCT_TRUTH_V3_ENABLED,
    runId: process.env.SS_AMAZON_REPRICER_RUN_ID,
    approvalId: process.env.SS_AMAZON_REPRICER_APPROVAL_ID,
  };
  try {
    process.env.CRON_SECRET = "phase0-amazon-repricer-retirement-test";
    process.env.SS_AMAZON_REPRICER_PRODUCT_TRUTH_V3_ENABLED = "1";
    process.env.SS_AMAZON_REPRICER_RUN_ID = "legacy-run";
    process.env.SS_AMAZON_REPRICER_APPROVAL_ID = "legacy-approval";

    const response = await retiredAmazonRepricer(
      new NextRequest(
        "https://sscc.example/api/cron/reprice-amazon?apply=true&runId=legacy-run&approvalId=legacy-approval",
        {
          headers: {
            authorization: "Bearer phase0-amazon-repricer-retirement-test",
          },
        },
      ),
    );

    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: false,
      retired: true,
      code: "LEGACY_AMAZON_REPRICER_RETIRED",
      reason:
        "Legacy raw-SKU/$1 repricing is disabled. Use manifest-bound Product Truth plus a separate owner action gate.",
    });
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("CRON_SECRET", previous.cronSecret);
    restore("SS_AMAZON_REPRICER_PRODUCT_TRUTH_V3_ENABLED", previous.enabled);
    restore("SS_AMAZON_REPRICER_RUN_ID", previous.runId);
    restore("SS_AMAZON_REPRICER_APPROVAL_ID", previous.approvalId);
  }
});

test("legacy Amazon listing-improvement execution boundaries are hard tombstones", () => {
  const helper = source("src/lib/amazon/growth/product-truth-containment.ts");
  assert.match(helper, /status: 410/);
  assert.match(helper, /cache-control": "no-store/);
  assert.match(helper, /LEGACY_AMAZON_LISTING_IMPROVEMENT_RETIRED_REASON/);

  const standalone = [
    ["src/app/api/cron/amazon-remediation/route.ts", "LEGACY_AMAZON_REMEDIATION_WORKER_RETIRED"],
    ["src/app/api/cron/amazon-auto-improve/route.ts", "LEGACY_AMAZON_AUTO_IMPROVE_RETIRED"],
    ["src/app/api/amazon/growth/optimizer/apply/route.ts", "LEGACY_AMAZON_OPTIMIZER_APPLY_RETIRED"],
    ["src/app/api/amazon/growth/advisor/apply/route.ts", "LEGACY_AMAZON_ADVISOR_APPLY_RETIRED"],
    ["src/app/api/amazon/growth/advisor/route.ts", "LEGACY_AMAZON_ADVISOR_PAID_EXECUTION_RETIRED"],
    ["src/app/api/amazon/growth/bulk-fix/drain/route.ts", "LEGACY_AMAZON_BULK_FIX_DRAIN_RETIRED"],
    ["src/app/api/amazon/growth/advisor-bulk/drain/route.ts", "LEGACY_AMAZON_ADVISOR_BULK_DRAIN_RETIRED"],
    ["src/app/api/amazon/growth/changelog/rollback/route.ts", "LEGACY_AMAZON_CHANGELOG_ROLLBACK_RETIRED"],
  ] as const;
  for (const [path, code] of standalone) {
    const text = source(path);
    assert.match(text, new RegExp(code));
    assert.match(text, /retiredAmazonListingImprovementResponse/);
    assert.doesNotMatch(text, /NextRequest|request\.json|CRON_SECRET/);
    assert.doesNotMatch(
      text,
      /patchListing|applyPlan|drainQueue|drainAdvisorQueue|adviseListing|getMerchantToken|amazon(?:Advisor|Remediation)Queue|@anthropic-ai\/sdk|messages\.create|prisma/i,
    );
  }
});

test("legacy Amazon queue producers and snapshot restore preserve reads but cannot write", () => {
  const advisorBulk = source("src/app/api/amazon/growth/advisor-bulk/route.ts");
  const advisorPost = advisorBulk.slice(
    advisorBulk.indexOf("export async function POST"),
    advisorBulk.indexOf("export async function GET"),
  );
  assert.match(advisorPost, /LEGACY_AMAZON_ADVISOR_BULK_ENQUEUE_RETIRED/);
  assert.doesNotMatch(advisorPost, /request|upsert|findMany|autoApply|REQUESTED/);
  assert.match(advisorBulk, /export async function GET\(request: NextRequest\)/);
  assert.match(advisorBulk, /amazonAdvisorQueue\.count/);

  const bulkFix = source("src/app/api/amazon/growth/bulk-fix/route.ts");
  const bulkPost = bulkFix.slice(
    bulkFix.indexOf("export async function POST"),
    bulkFix.indexOf("export async function GET"),
  );
  assert.match(bulkPost, /LEGACY_AMAZON_BULK_FIX_ENQUEUE_RETIRED/);
  assert.doesNotMatch(bulkPost, /request|upsert|findMany|scope|REQUESTED/);
  assert.match(bulkFix, /export async function GET\(request: NextRequest\)/);
  assert.match(bulkFix, /amazonRemediationQueue\.count/);

  const history = source("src/app/api/amazon/growth/history/route.ts");
  assert.match(history, /LEGACY_AMAZON_HISTORY_RESTORE_RETIRED/);
  assert.match(history, /action === "ingestLatest"/);
  assert.match(history, /action === "snapshot"/);
  assert.match(history, /action === "backfill"/);
  assert.match(history, /export async function GET\(request: NextRequest\)/);
  assert.doesNotMatch(
    history,
    /patchListing|getMerchantToken|ListingPatch|MARKETPLACE_ID|logChange|submissionId|restore-snapshot/,
  );
});

test("former Amazon listing-improvement flags and payloads cannot revive execution", async () => {
  const previous = {
    cronSecret: process.env.CRON_SECRET,
    remediation: process.env.SS_AMAZON_REMEDIATION_WORKER_ENABLED,
    autoImprove: process.env.SS_AMAZON_AUTO_IMPROVE_ENABLED,
  };
  try {
    process.env.CRON_SECRET = "phase0-amazon-listing-improvement-test";
    process.env.SS_AMAZON_REMEDIATION_WORKER_ENABLED = "1";
    process.env.SS_AMAZON_AUTO_IMPROVE_ENABLED = "1";

    const cases = [
      [retiredAmazonRemediationWorker, "LEGACY_AMAZON_REMEDIATION_WORKER_RETIRED"],
      [retiredAmazonAutoImprove, "LEGACY_AMAZON_AUTO_IMPROVE_RETIRED"],
      [retiredAmazonOptimizerApply, "LEGACY_AMAZON_OPTIMIZER_APPLY_RETIRED"],
      [retiredAmazonAdvisorApply, "LEGACY_AMAZON_ADVISOR_APPLY_RETIRED"],
      [retiredAmazonAdvisorPaidExecution, "LEGACY_AMAZON_ADVISOR_PAID_EXECUTION_RETIRED"],
      [retiredAmazonBulkFixDrain, "LEGACY_AMAZON_BULK_FIX_DRAIN_RETIRED"],
      [retiredAmazonAdvisorBulkDrain, "LEGACY_AMAZON_ADVISOR_BULK_DRAIN_RETIRED"],
      [retiredAmazonChangelogRollback, "LEGACY_AMAZON_CHANGELOG_ROLLBACK_RETIRED"],
      [retiredAmazonAdvisorBulkEnqueue, "LEGACY_AMAZON_ADVISOR_BULK_ENQUEUE_RETIRED"],
      [retiredAmazonBulkFixEnqueue, "LEGACY_AMAZON_BULK_FIX_ENQUEUE_RETIRED"],
    ] as const;

    for (const [handler, code] of cases) {
      const response = await handler();
      assert.equal(response.status, 410);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        ok: false,
        retired: true,
        code,
        reason: LEGACY_AMAZON_LISTING_IMPROVEMENT_RETIRED_REASON,
      });
    }

    const restore = await amazonHistoryPost(
      new NextRequest("https://sscc.example/api/amazon/growth/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "restoreSnapshot",
          storeIndex: 1,
          sku: "must-not-be-read",
          snapshotId: "must-not-be-read",
        }),
      }),
    );
    assert.equal(restore.status, 410);
    assert.equal(restore.headers.get("cache-control"), "no-store");
    assert.deepEqual(await restore.json(), {
      ok: false,
      retired: true,
      code: "LEGACY_AMAZON_HISTORY_RESTORE_RETIRED",
      reason: LEGACY_AMAZON_LISTING_IMPROVEMENT_RETIRED_REASON,
    });
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("CRON_SECRET", previous.cronSecret);
    restore("SS_AMAZON_REMEDIATION_WORKER_ENABLED", previous.remediation);
    restore("SS_AMAZON_AUTO_IMPROVE_ENABLED", previous.autoImprove);
  }
});

test("Jackie generic Amazon listing tool is preview-only and cannot PATCH", async () => {
  const sourceText = source("src/lib/jackie-mcp/tools/listings.ts");
  assert.match(sourceText, /LEGACY_AMAZON_MCP_LISTINGS_UPDATE_RETIRED/);
  assert.match(sourceText, /dry_run: \{ type: "boolean", default: true \}/);
  assert.doesNotMatch(sourceText, /\bpatchListing\b|validationPreview|stage: "submitted"/);

  const tool = amazonListingTools.find((item) => item.name === "listings_update");
  assert.ok(tool, "listings_update must remain available as a preview-only tool");

  const denied = await tool.handler(
    {
      channel: "AMAZON_SALUTEM",
      sku: "must-not-reach-amazon",
      patches: { title: "must-not-reach-amazon" },
      dry_run: false,
    },
    { actor: "phase0-containment" },
  );
  assert.deepEqual(denied, {
    ok: false,
    retired: true,
    code: "LEGACY_AMAZON_MCP_LISTINGS_UPDATE_RETIRED",
    reason:
      "Generic Amazon listing PATCH is disabled. Use manifest-bound Product Truth preview plus a separate owner action gate.",
  });

  const preview = await tool.handler(
    {
      channel: "AMAZON_SALUTEM",
      sku: "offline-preview-only",
      product_type: "PRODUCT",
      patches: { title: "Offline Preview" },
    },
    { actor: "phase0-containment" },
  ) as { dry_run?: boolean; would_patch?: unknown };
  assert.equal(preview.dry_run, true);
  assert.ok(preview.would_patch);
});

test("status endpoints contain no paid synthetic provider probes", () => {
  const health = source("src/lib/sourcing/service-health.ts");
  const integrations = source("src/app/api/settings/integrations/route.ts");
  assert.doesNotMatch(health, /data\.unwrangle\.com/);
  assert.doesNotMatch(integrations, /data\.unwrangle\.com/);
  assert.doesNotMatch(integrations, /api\.anthropic\.com\/v1\/messages/);
});

test("tracked direct metered HTTP call sites use the durable ledger wrapper or are quarantined", () => {
  const files = [
    ...tsFiles("src/lib/sourcing"),
    ...tsFiles("src/lib/walmart"),
    ...tsFiles("scripts"),
    "_trial100.ts",
    "_multi.ts",
    "_gimgres.ts",
    "_qavalidate.ts",
    "_gen.ts",
  ];
  const paidEndpoint = /data\.unwrangle\.com|api\.bluecartapi\.com\/request|realtime\.oxylabs\.io\/v1\/queries|generativelanguage\.googleapis\.com|api\.openai\.com\/v1\/(?:chat\/completions|images)/;
  const offenders: string[] = [];
  for (const file of files) {
    const text = source(file);
    if (!paidEndpoint.test(text)) continue;
    if (
      !text.includes("withMeteredProviderCall")
      && !text.includes("LEGACY_METERED_SCRIPT_DISABLED")
      && !text.includes("LEGACY_COGS_MUTATION_SCRIPT_DISABLED")
    ) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `unguarded metered HTTP call sites: ${offenders.join(", ")}`);
});

test("COGS Anthropic SDK calls use the durable ledger or are quarantined", () => {
  const offenders = tsFiles("scripts")
    .filter((file) => /cogs/i.test(file))
    .filter((file) => {
      const text = source(file);
      return /@anthropic-ai\/sdk|messages\.create/.test(text)
        && !text.includes("withMeteredProviderCall")
        && !text.includes("LEGACY_METERED_SCRIPT_DISABLED")
        && !text.includes("LEGACY_COGS_MUTATION_SCRIPT_DISABLED");
    });
  assert.deepEqual(offenders, [], `unguarded COGS Anthropic calls: ${offenders.join(", ")}`);
});

test("legacy synchronous permit guard is not an executable paid-call boundary", () => {
  const offenders = [
    ...tsFiles("src/lib/sourcing"),
    ...tsFiles("src/lib/walmart"),
    ...tsFiles("scripts"),
  ].filter((file) => {
    if (file.endsWith("metered-call-guard.ts") || file.endsWith("metered-provider-call.ts")) return false;
    const text = source(file);
    return text.includes("assertMeteredProviderCall")
      && !text.includes("LEGACY_METERED_SCRIPT_DISABLED")
      && !text.includes("LEGACY_COGS_MUTATION_SCRIPT_DISABLED");
  });
  assert.deepEqual(offenders, [], `legacy sync-only paid boundaries: ${offenders.join(", ")}`);
});

test("legacy COGS writers cannot rewrite immutable cost periods", () => {
  const offenders = tsFiles("scripts").filter((file) => {
    const text = source(file);
    const rewritesCost = /UPDATE\s+["']?SkuCost|ON\s+CONFLICT\s*\(sku,\s*source,\s*effectiveDate\)\s*DO\s+UPDATE/i.test(text);
    return rewritesCost && !text.includes("LEGACY_COGS_MUTATION_SCRIPT_DISABLED");
  });
  assert.deepEqual(offenders, [], `executable legacy SkuCost writers: ${offenders.join(", ")}`);
});

test("catalog automation cannot silently clear donor review state", () => {
  const offenders = [
    ...tsFiles("src/lib/sourcing"),
    ...tsFiles("scripts"),
  ].filter((file) => {
    const text = source(file);
    return /UPDATE\s+["']?DonorProduct["']?[\s\S]{0,500}?needsReview\s*=\s*0/i.test(text)
      && !text.includes("LEGACY_METERED_SCRIPT_DISABLED");
  });
  assert.deepEqual(offenders, [], `automatic donor approval writers: ${offenders.join(", ")}`);
});
