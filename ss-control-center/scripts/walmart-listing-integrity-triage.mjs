#!/usr/bin/env -S node --experimental-strip-types

/**
 * Bounded full-catalog visual-triage preparation and offline verification.
 *
 * This command has no Walmart client, database client, mutation command, or
 * model transport. `prepare` derives deterministic model views from one exact
 * captured partition. `verify` rechecks every byte and bound before a separate
 * observer is allowed to spend up to six subscription calls.
 */

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import { preprocessCatalogVisual } from "../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  buildWalmartListingCatalogTriagePlan,
  verifyWalmartListingCatalogTriagePlan,
} from "../src/lib/walmart/listing-integrity-catalog-triage.ts";
import {
  verifyWalmartListingIntegrityCatalogArtifacts,
} from "../src/lib/walmart/listing-integrity-catalog-orchestrator.ts";
import {
  verifyWalmartListingIntegrityCapture,
} from "./walmart-listing-integrity-catalog.mjs";

const WORKER_CONTRACT = Object.freeze({
  worker_build: "sha256:fed5fa5e49914c1df1ae2197c51be4d7c0342f2adad4d01819f792622614f0f9",
  model: "sonnet",
  reasoning_effort: null,
  cli_version: "2.1.179 (Claude Code)",
  node_version: "v20.20.1",
  runtime_platform: "linux",
  runtime_arch: "x64",
  vision_timeout_ms: 300000,
  reservation_ledger: {
    schema_version: "vision-call-reservation-ledger-contract/v1",
    ledger_id: "ledger-2c53fa5f-f761-4660-80b9-24e934e172aa",
    ledger_epoch: "epoch-986b9a13-740b-4403-b433-378f2613d4f0",
    state_directory_path_sha256: "ae43d594a2a43b6bc856529cfa729d73d9784d1dd3f3e4dffddf27feccfece53",
    directory_identity_sha256: "c0e7a611777a5b7063c36a94c3c4c27ea6943e34ba2622944c0426d7685c0db1",
    identity_artifact_sha256: "ffd380901c51e88205454d1ddd68141d94e811c286b62d556c60e335e84e3a68",
  },
});

const HELP = `Usage:
  npm run walmart-listing-triage -- prepare \
    --census=/absolute/catalog-census.json --expect-census-sha256=<sha256> \
    --plan=/absolute/scan-plan.json --expect-plan-sha256=<sha256> \
    --capture-index=/absolute/capture-index.json --expect-capture-index-sha256=<sha256> \
    --output-dir=/absolute/new/directory

  npm run walmart-listing-triage -- verify \
    --triage-plan=/absolute/triage-plan.json --expect-triage-plan-sha256=<sha256>

prepare/verify: local filesystem only; 0 model calls, 0 DB/Walmart reads or writes.
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be SHA-256`);
  }
  return value;
}

function parseArgs(argv) {
  if (argv.length === 1 && ["help", "--help"].includes(argv[0])) return { help: true };
  const command = argv[0];
  if (!["prepare", "prepare-subset", "verify"].includes(command)) {
    throw new Error("first argument must be prepare, prepare-subset, verify, or --help");
  }
  const flags = new Map();
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1])) throw new Error(`unsupported/duplicate argument: ${argument}`);
    flags.set(match[1], match[2]);
  }
  const expected = command === "prepare" || command === "prepare-subset"
    ? [
        "census", "expect-census-sha256", "plan", "expect-plan-sha256",
        "capture-index", "expect-capture-index-sha256", "output-dir",
        ...(command === "prepare-subset" ? ["listing-keys"] : []),
      ]
    : ["triage-plan", "expect-triage-plan-sha256"];
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    throw new Error(`${command} arguments must be exactly: ${expected.map((key) => `--${key}`).join(", ")}`);
  }
  const result = { help: false, command };
  for (const key of expected) {
    const value = flags.get(key);
    result[key.replaceAll("-", "_")] = key.includes("sha256")
      ? digest(value, `--${key}`)
      : key === "listing-keys" ? value : path.resolve(value);
  }
  return result;
}

async function readExactJson(pathname, expectedSha256, label, maximum = 100_000_000) {
  const bytes = await readFile(pathname);
  if (bytes.length < 2 || bytes.length > maximum || sha256(bytes) !== expectedSha256) {
    throw new Error(`${label} exact-file SHA-256/size mismatch`);
  }
  return { bytes, value: JSON.parse(bytes.toString("utf8")), sha256: expectedSha256 };
}

async function writeExclusive(pathname, bytes) {
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeAssetPath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)
    || relative.split("/").some((part) => !part || part === "..")) {
    throw new Error("asset path is not a safe relative path");
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error("asset path escapes its evidence root");
  }
  return resolved;
}

export async function prepareWalmartListingCatalogTriage(options) {
  await verifyWalmartListingIntegrityCapture({
    census: options.census,
    expect_census_sha256: options.expect_census_sha256,
    plan: options.plan,
    expect_plan_sha256: options.expect_plan_sha256,
    capture_index: options.capture_index,
    expect_capture_index_sha256: options.expect_capture_index_sha256,
  });
  const [censusArtifact, scanArtifact, captureArtifact] = await Promise.all([
    readExactJson(options.census, options.expect_census_sha256, "catalog census"),
    readExactJson(options.plan, options.expect_plan_sha256, "scan plan"),
    readExactJson(options.capture_index, options.expect_capture_index_sha256, "capture index"),
  ]);
  verifyWalmartListingIntegrityCatalogArtifacts({
    census: censusArtifact.value,
    plan: scanArtifact.value,
  });
  const capture = captureArtifact.value;
  if (capture.outcome?.complete !== true || !Array.isArray(capture.results)
    || capture.results.some((row) => row.status !== "CAPTURED")) {
    throw new Error("triage preparation requires one complete captured partition");
  }
  try {
    await lstat(options.output_dir);
    throw new Error("--output-dir must not already exist");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(options.output_dir, { recursive: false, mode: 0o700 });
  const modelRoot = path.join(options.output_dir, "model-assets");
  await mkdir(modelRoot, { recursive: false, mode: 0o700 });
  const selectedListingKeys = options.listing_keys
    ? options.listing_keys.split(",").map((value) => value.trim()).filter(Boolean)
    : null;
  if (selectedListingKeys && (!selectedListingKeys.length
    || new Set(selectedListingKeys).size !== selectedListingKeys.length)) {
    throw new Error("--listing-keys must contain unique comma-separated listing keys");
  }
  const selectedSet = selectedListingKeys ? new Set(selectedListingKeys) : null;
  const captureRows = selectedSet
    ? capture.results.filter((row) => selectedSet.has(row.task.listing_key))
    : capture.results;
  if (!captureRows.length || (selectedSet && [...selectedSet].some((listingKey) => (
    !captureRows.some((row) => row.task.listing_key === listingKey)
  )))) {
    throw new Error("selected listing keys are absent from the captured partition");
  }
  const captureRoot = path.dirname(options.capture_index);
  const prepared = [];
  for (const [index, row] of captureRows.entries()) {
    const sourcePath = safeAssetPath(captureRoot, row.asset.path);
    const sourceBytes = await readFile(sourcePath);
    if (sourceBytes.length !== row.asset.bytes || sha256(sourceBytes) !== row.asset.sha256) {
      throw new Error(`capture result ${index} changed after verification`);
    }
    const preprocessed = await preprocessCatalogVisual(sourceBytes, {
      full_max_edge: 1600,
      crop_max_edge: 1800,
      analysis_max_edge: 512,
      max_crop_upscale: 2,
      limit_input_pixels: 40_000_000,
    });
    const full = preprocessed.views.find((view) => view.role === "full");
    if (!full || full.media_type !== "image/jpeg" || sha256(full.bytes) !== full.sha256) {
      throw new Error(`capture result ${index} has no deterministic full JPEG view`);
    }
    const relative = `model-assets/${row.task.task_id}.jpeg`;
    await writeExclusive(path.join(options.output_dir, relative), full.bytes);
    prepared.push({
      task: row.task,
      source_asset_sha256: row.asset.sha256,
      model_asset: {
        path: relative,
        sha256: full.sha256,
        bytes: full.bytes.length,
        media_type: full.media_type,
        width: full.width,
        height: full.height,
      },
    });
  }
  const triagePlan = buildWalmartListingCatalogTriagePlan({
    created_at: new Date().toISOString(),
    census: censusArtifact.value,
    census_file_sha256: censusArtifact.sha256,
    scan_plan: scanArtifact.value,
    scan_plan_file_sha256: scanArtifact.sha256,
    capture_index_file_sha256: captureArtifact.sha256,
    capture_index_body_sha256: capture.body_sha256,
    partition_id: capture.partition_id,
    prepared_assets: prepared,
    worker_contract: WORKER_CONTRACT,
    ...(selectedListingKeys ? { selected_listing_keys: selectedListingKeys } : {}),
  });
  verifyWalmartListingCatalogTriagePlan(triagePlan);
  const planBytes = jsonBytes(triagePlan);
  const planSha256 = sha256(planBytes);
  await writeExclusive(path.join(options.output_dir, "triage-plan.json"), planBytes);
  await writeExclusive(
    path.join(options.output_dir, "triage-plan.sha256"),
    Buffer.from(`${planSha256}\n`, "utf8"),
  );
  await chmod(modelRoot, 0o500);
  await chmod(options.output_dir, 0o500);
  return {
    status: "TRIAGE_PLAN_READY",
    output_dir: options.output_dir,
    triage_plan_sha256: planSha256,
    partition_id: capture.partition_id,
    listings: triagePlan.listings.length,
    images: triagePlan.assets.length,
    calls: triagePlan.calls.length,
    largest_request_character_estimate: Math.max(...triagePlan.calls.map((call) => (
      call.request_character_estimate
    ))),
    policy: triagePlan.policy,
    external_effects: {
      filesystem_writes: triagePlan.assets.length + 2,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
      paid_api_calls: 0,
    },
  };
}

export async function verifyPreparedWalmartListingCatalogTriage(options) {
  const artifact = await readExactJson(
    options.triage_plan,
    options.expect_triage_plan_sha256,
    "triage plan",
  );
  const verified = verifyWalmartListingCatalogTriagePlan(artifact.value);
  const root = path.dirname(options.triage_plan);
  const modelRoot = path.join(root, "model-assets");
  const referenced = [];
  for (const [index, asset] of artifact.value.assets.entries()) {
    const pathname = safeAssetPath(root, asset.model_asset.path);
    const info = await lstat(pathname);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`model asset ${index} is not a regular file`);
    }
    const bytes = await readFile(pathname);
    if (bytes.length !== asset.model_asset.bytes || sha256(bytes) !== asset.model_asset.sha256) {
      throw new Error(`model asset ${index} exact bytes mismatch`);
    }
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (metadata.format !== "jpeg" || metadata.width !== asset.model_asset.width
      || metadata.height !== asset.model_asset.height) {
      throw new Error(`model asset ${index} decoded metadata mismatch`);
    }
    referenced.push(path.basename(pathname));
  }
  const actual = (await readdir(modelRoot)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(referenced.sort())) {
    throw new Error("model-assets contains missing or extra files");
  }
  return {
    ...verified,
    triage_plan_file_sha256: artifact.sha256,
    largest_request_character_estimate: Math.max(...artifact.value.calls.map((call) => (
      call.request_character_estimate
    ))),
    external_effects: {
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
      paid_api_calls: 0,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = options.command === "prepare" || options.command === "prepare-subset"
    ? await prepareWalmartListingCatalogTriage(options)
    : await verifyPreparedWalmartListingCatalogTriage(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
