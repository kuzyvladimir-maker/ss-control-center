import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  buildWalmartListingCatalogTriagePlan,
} from "../../src/lib/walmart/listing-integrity-catalog-triage.ts";
import {
  buildWalmartListingIntegrityCatalogCensus,
  buildWalmartListingIntegrityScanPlan,
} from "../../src/lib/walmart/listing-integrity-catalog-orchestrator.ts";
import {
  executeWalmartListingCatalogTriage,
  verifyWalmartListingCatalogTriageExecution,
} from "../walmart-listing-integrity-triage-observer.mjs";

const require = createRequire(import.meta.url);
const visionContract = require("../../ops/codex-image-worker/vision-contract.js");

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(root) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = visionContract.createVisionReceiptSigner(
    privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    "test-listing-vision-key",
  );
  const workerContract = {
    worker_build: `sha256:${sha("test-worker")}`,
    model: "sonnet",
    reasoning_effort: null,
    cli_version: "test-claude-cli",
    node_version: "v20.20.1",
    runtime_platform: "linux",
    runtime_arch: "x64",
    vision_timeout_ms: 180000,
    reservation_ledger: {
      schema_version: "vision-call-reservation-ledger-contract/v1",
      ledger_id: "ledger-2c53fa5f-f761-4660-80b9-24e934e172aa",
      ledger_epoch: "epoch-986b9a13-740b-4403-b433-378f2613d4f0",
      state_directory_path_sha256: sha("path"),
      directory_identity_sha256: sha("directory"),
      identity_artifact_sha256: sha("identity"),
    },
  };
  const census = buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: "2026-07-23T12:00:00.000Z",
    catalog_rows: [{
      sku: "SKU-A",
      itemId: "item-a",
      title: "Alpha Potato Chips (Pack of 6)",
      lifecycleStatus: "ACTIVE",
      publishedStatus: "PUBLISHED",
      syncedAt: "2026-07-23T11:30:00.000Z",
      mainImageUrl: null,
    }],
    remediation_rows: [{
      id: "r-a",
      sku: "SKU-A",
      runAt: "2026-07-23T10:00:00.000Z",
      feedStatus: "APPLIED",
      ok: 1,
      mainImageUrl: "https://images.example.test/a.png",
      newTitle: null,
      packCount: 6,
      changeSummary: null,
    }],
  });
  const scanPlan = buildWalmartListingIntegrityScanPlan(census);
  const modelRoot = path.join(root, "model-assets");
  await mkdir(modelRoot);
  const imageBytes = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "white" },
  }).jpeg().toBuffer();
  const task = scanPlan.partitions[0].tasks[0];
  const relative = `model-assets/${task.task_id}.jpeg`;
  await writeFile(path.join(root, relative), imageBytes);
  const plan = buildWalmartListingCatalogTriagePlan({
    created_at: "2026-07-23T12:30:00.000Z",
    census,
    census_file_sha256: sha("census-file"),
    scan_plan: scanPlan,
    scan_plan_file_sha256: sha("scan-file"),
    capture_index_file_sha256: sha("capture-file"),
    capture_index_body_sha256: sha("capture-body"),
    partition_id: scanPlan.partitions[0].partition_id,
    prepared_assets: [{
      task,
      source_asset_sha256: sha("source-image"),
      model_asset: {
        path: relative,
        sha256: sha(imageBytes),
        bytes: imageBytes.length,
        media_type: "image/jpeg",
        width: 32,
        height: 32,
      },
    }],
    worker_contract: workerContract,
  });
  const planBytes = jsonBytes(plan);
  const planPath = path.join(root, "triage-plan.json");
  await writeFile(planPath, planBytes);
  return {
    signer,
    workerContract,
    plan,
    planPath,
    planSha256: sha(planBytes),
    trust: {
      key_id: signer.key_id,
      public_key_spki_sha256: signer.public_key_spki_sha256,
    },
  };
}

function observation(imageId) {
  return {
    image_id: imageId,
    visual_role: "tiled_main",
    visible_brand_text: "Alpha",
    visible_product_text: "Potato Chips",
    visible_variant_text: null,
    visible_size_texts: [],
    external_package_count: { mode: "exact", value: 6, min: null, max: null },
    outer_package_claims: [],
    inner_contents_claims: [],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "single_sellable_package",
    front_visibility: "all",
    background: "white",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["six packages visible"],
    flags: [],
  };
}

test("observer executes one signed subscription call and offline verification rebuilds the report", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "walmart-catalog-triage-observer-"));
  let executionDir = path.join(root, "execution");
  t.after(async () => {
    await chmod(executionDir, 0o700).catch(() => {});
    await rm(root, { recursive: true });
  });
  const preparedRoot = path.join(root, "prepared");
  await mkdir(preparedRoot);
  const setup = await fixture(preparedRoot);
  let calls = 0;
  const fakeFetch = async (_url, init) => {
    calls += 1;
    if (init.method === "GET") {
      const value = {
        ok: true,
        health_authorization_verified: true,
        genDir: "/test",
        vision: true,
        worker_build: setup.workerContract.worker_build,
        vision_providers: ["codex_cli_subscription", "claude_cli_subscription"],
        vision_contracts: {
          claude_cli_subscription: {
            model: setup.workerContract.model,
            reasoning_effort: null,
            cli_version: setup.workerContract.cli_version,
          },
        },
        vision_timeout_ms: setup.workerContract.vision_timeout_ms,
        signed_vision_receipts: {
          schema_version: "vision-worker-receipt/v2",
          key_id: setup.signer.key_id,
          public_key_spki_sha256: setup.signer.public_key_spki_sha256,
        },
        durable_call_key_reservations: true,
        reservation_ledger: setup.workerContract.reservation_ledger,
      };
      const bytes = Buffer.from(JSON.stringify(value));
      return { status: 200, bytes, value, sha256: sha(bytes) };
    }
    const request = JSON.parse(init.body);
    assert.equal(request.prompt, setup.plan.calls[0].prompt);
    const result = {
      schema_version: "wm_visual_observation_batch/v3",
      observations: [observation(setup.plan.calls[0].image_ids[0])],
    };
    const reservedAt = "2026-07-23T12:31:00.000Z";
    const receipt = setup.signer.sign({
      issued_at: "2026-07-23T12:31:01.000Z",
      reservation_reserved_at: reservedAt,
      request_attestation: request.request_attestation,
      result_canonical_sha256: sha(Buffer.from(visionContract.canonicalJson(result), "utf8")),
      worker_contract: {
        input_image_count: 1,
        vision_provider: "claude_cli_subscription",
        vision_model: setup.workerContract.model,
        vision_reasoning_effort: null,
        cli_version: setup.workerContract.cli_version,
        node_version: setup.workerContract.node_version,
        runtime_platform: setup.workerContract.runtime_platform,
        runtime_arch: setup.workerContract.runtime_arch,
        worker_build: setup.workerContract.worker_build,
        vision_timeout_ms: setup.workerContract.vision_timeout_ms,
        reservation_ledger: setup.workerContract.reservation_ledger,
      },
      subscription_policy: {
        auth_mode: "claude_subscription_oauth",
        paid_api_environment_absent: true,
        alternate_cloud_routing_absent: true,
      },
    });
    const value = {
      ok: true,
      result,
      input_image_count: 1,
      vision_provider: "claude_cli_subscription",
      vision_model: setup.workerContract.model,
      vision_reasoning_effort: null,
      cli_version: setup.workerContract.cli_version,
      node_version: setup.workerContract.node_version,
      runtime_platform: setup.workerContract.runtime_platform,
      runtime_arch: setup.workerContract.runtime_arch,
      worker_build: setup.workerContract.worker_build,
      reservation_ledger: setup.workerContract.reservation_ledger,
      vision_timeout_ms: setup.workerContract.vision_timeout_ms,
      request_attestation_verified: true,
      worker_receipt: receipt,
    };
    const bytes = Buffer.from(JSON.stringify(value));
    return { status: 200, bytes, value, sha256: sha(bytes) };
  };
  const options = {
    triage_plan: setup.planPath,
    expect_triage_plan_sha256: setup.planSha256,
    output_dir: executionDir,
  };
  const executed = await executeWalmartListingCatalogTriage(options, {
    connection: { url: new URL("http://127.0.0.1:8791/analyze-claude"), token: "test" },
    fetch: fakeFetch,
    trust: setup.trust,
  });
  assert.equal(calls, 2);
  assert.equal(executed.execution.subscription_calls_consumed, 1);
  assert.equal(executed.execution.walmart_writes, 0);
  assert.deepEqual(executed.outcome, {
    listings: 1,
    suspected_bad: 0,
    review_required: 0,
    no_defect_observed_not_pass: 1,
  });
  const verified = await verifyWalmartListingCatalogTriageExecution({
    triage_plan: setup.planPath,
    expect_triage_plan_sha256: setup.planSha256,
    execution_dir: executionDir,
  }, { trust: setup.trust });
  assert.equal(verified.verified, true);
  assert.equal(verified.calls, 1);
  assert.equal(verified.execution.walmart_writes, 0);

  const reportPath = path.join(executionDir, "triage-report.json");
  await chmod(reportPath, 0o600);
  const report = await readFile(reportPath);
  await writeFile(reportPath, Buffer.concat([report, Buffer.from(" ")]));
  await assert.rejects(
    verifyWalmartListingCatalogTriageExecution({
      triage_plan: setup.planPath,
      expect_triage_plan_sha256: setup.planSha256,
      execution_dir: executionDir,
    }, { trust: setup.trust }),
    /triage report does not rebuild exactly/,
  );
});
