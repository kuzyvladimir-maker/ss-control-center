#!/usr/bin/env -S node --env-file=.env --experimental-strip-types

/**
 * Read-only full-catalog entrypoint for Walmart Listing Integrity.
 *
 * `plan` reads the two existing catalog/evidence tables and prints summary JSON.
 * `snapshot` additionally creates one immutable local census + scan plan.
 * `verify` is offline and rebuilds the scan plan from the exact census bytes.
 * No command can mutate the database, Walmart, price, inventory, or listings.
 */

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import sharp from "sharp";

import {
  buildWalmartListingIntegrityCatalogCensus,
  buildWalmartListingIntegrityScanPlan,
  verifyWalmartListingIntegrityCatalogArtifacts,
} from "../src/lib/walmart/listing-integrity-catalog-orchestrator.ts";

const HELP = `Usage:
  npm run walmart-listing-catalog -- plan --store-index=1
  npm run walmart-listing-catalog -- snapshot --store-index=1 --output-dir=/absolute/new/directory
  npm run walmart-listing-catalog -- verify --census=/absolute/catalog-census.json --plan=/absolute/scan-plan.json
  npm run walmart-listing-catalog -- capture \
    --census=/absolute/catalog-census.json --expect-census-sha256=<file-sha256> \
    --plan=/absolute/scan-plan.json --expect-plan-sha256=<file-sha256> \
    --partition-id=<exact-partition-id> --output-dir=/absolute/new/directory
  npm run walmart-listing-catalog -- verify-capture \
    --census=/absolute/catalog-census.json --expect-census-sha256=<file-sha256> \
    --plan=/absolute/scan-plan.json --expect-plan-sha256=<file-sha256> \
    --capture-index=/absolute/capture-index.json --expect-capture-index-sha256=<file-sha256>

plan:     DB read-only, no filesystem writes, no Walmart/model calls.
snapshot: same two DB reads plus a new immutable local evidence directory.
verify:   offline; no DB, network, Walmart, or model calls.
capture:  exact plan-bound HTTPS image GETs, zero retries/model/Walmart writes.
verify-capture: offline exact-byte/source-plan verification of every captured image.
`;

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) return { help: true };
  const command = argv[0];
  if (!["plan", "snapshot", "verify", "capture", "verify-capture"].includes(command)) {
    throw new Error("first argument must be plan, snapshot, verify, capture, verify-capture, or --help");
  }
  const flags = new Map();
  for (const argument of argv.slice(1)) {
    const at = argument.indexOf("=");
    if (!argument.startsWith("--") || at < 3) throw new Error(`unsupported argument: ${argument}`);
    const key = argument.slice(2, at);
    if (flags.has(key)) throw new Error(`--${key} was repeated`);
    flags.set(key, argument.slice(at + 1));
  }
  const allowed = command === "snapshot"
    ? new Set(["store-index", "output-dir"])
    : command === "plan"
      ? new Set(["store-index"])
      : command === "verify"
        ? new Set(["census", "plan"])
        : command === "capture"
          ? new Set([
            "census", "expect-census-sha256", "plan", "expect-plan-sha256",
            "partition-id", "output-dir",
          ])
          : new Set([
              "census", "expect-census-sha256", "plan", "expect-plan-sha256",
              "capture-index", "expect-capture-index-sha256",
            ]);
  for (const key of flags.keys()) if (!allowed.has(key)) throw new Error(`unsupported flag: --${key}`);
  for (const key of allowed) if (!flags.has(key)) throw new Error(`${command} requires --${key}=...`);
  if (command === "verify") {
    return {
      help: false,
      command,
      census: absolutePath(flags.get("census"), "--census"),
      plan: absolutePath(flags.get("plan"), "--plan"),
    };
  }
  if (command === "capture") {
    return {
      help: false,
      command,
      census: absolutePath(flags.get("census"), "--census"),
      expect_census_sha256: exactSha(flags.get("expect-census-sha256"), "--expect-census-sha256"),
      plan: absolutePath(flags.get("plan"), "--plan"),
      expect_plan_sha256: exactSha(flags.get("expect-plan-sha256"), "--expect-plan-sha256"),
      partition_id: boundedText(flags.get("partition-id"), "--partition-id", 200),
      output_dir: absolutePath(flags.get("output-dir"), "--output-dir"),
    };
  }
  if (command === "verify-capture") {
    return {
      help: false,
      command,
      census: absolutePath(flags.get("census"), "--census"),
      expect_census_sha256: exactSha(flags.get("expect-census-sha256"), "--expect-census-sha256"),
      plan: absolutePath(flags.get("plan"), "--plan"),
      expect_plan_sha256: exactSha(flags.get("expect-plan-sha256"), "--expect-plan-sha256"),
      capture_index: absolutePath(flags.get("capture-index"), "--capture-index"),
      expect_capture_index_sha256: exactSha(
        flags.get("expect-capture-index-sha256"),
        "--expect-capture-index-sha256",
      ),
    };
  }
  const rawStore = flags.get("store-index");
  if (!/^[1-9]\d*$/u.test(rawStore)) throw new Error("--store-index must be a positive integer");
  const storeIndex = Number(rawStore);
  if (!Number.isSafeInteger(storeIndex)) throw new Error("--store-index is outside the safe range");
  return {
    help: false,
    command,
    store_index: storeIndex,
    output_dir: command === "snapshot"
      ? absolutePath(flags.get("output-dir"), "--output-dir")
      : null,
  };
}

function exactSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be bounded, trimmed, and non-empty`);
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function cleanEnv(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "");
}

async function readCatalog(db, storeIndex) {
  const result = await db.execute({
    sql: `SELECT sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt,mainImageUrl
            FROM WalmartCatalogItem WHERE storeIndex=? ORDER BY sku`,
    args: [storeIndex],
  });
  return result.rows;
}

async function readRemediationHistory(db, storeIndex) {
  const result = await db.execute({
    sql: `SELECT id,sku,runAt,feedStatus,ok,mainImageUrl,newTitle,packCount,changeSummary
            FROM WalmartListingRemediation WHERE storeIndex=? ORDER BY sku,datetime(runAt),id`,
    args: [storeIndex],
  });
  return result.rows;
}

async function buildFromDatabase(storeIndex, now = new Date()) {
  const url = cleanEnv(process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL);
  const authToken = cleanEnv(process.env.TURSO_AUTH_TOKEN) || undefined;
  if (!url) throw new Error("TURSO_DATABASE_URL or DATABASE_URL is required");
  const db = createClient({ url, authToken });
  try {
    const [catalogRows, remediationRows] = await Promise.all([
      readCatalog(db, storeIndex),
      readRemediationHistory(db, storeIndex),
    ]);
    const census = buildWalmartListingIntegrityCatalogCensus({
      store_index: storeIndex,
      captured_at: now.toISOString(),
      catalog_rows: catalogRows,
      remediation_rows: remediationRows,
    });
    const plan = buildWalmartListingIntegrityScanPlan(census);
    return { census, plan };
  } finally {
    db.close();
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeExclusive(file, bytes) {
  const handle = await open(file, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSnapshot(outputDir, artifacts) {
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const censusBytes = jsonBytes(artifacts.census);
  const planBytes = jsonBytes(artifacts.plan);
  const censusSha = sha256(censusBytes);
  const planSha = sha256(planBytes);
  await writeExclusive(path.join(outputDir, "catalog-census.json"), censusBytes);
  await writeExclusive(path.join(outputDir, "catalog-census.sha256"), Buffer.from(`${censusSha}\n`));
  await writeExclusive(path.join(outputDir, "scan-plan.json"), planBytes);
  await writeExclusive(path.join(outputDir, "scan-plan.sha256"), Buffer.from(`${planSha}\n`));
  await chmod(outputDir, 0o500);
  return { census_sha256: censusSha, plan_sha256: planSha };
}

function planSummary(census, plan) {
  return {
    status: "READ_ONLY_PLAN_READY",
    census_id: census.census_id,
    census_body_sha256: census.body_sha256,
    catalog: census.summary,
    reconciliation: census.reconciliation,
    scan: plan.coverage,
    policy: plan.policy,
    external_effects: census.external_effects,
    next_command: null,
  };
}

async function verifyFiles(options) {
  const [censusBytes, planBytes] = await Promise.all([
    readFile(options.census),
    readFile(options.plan),
  ]);
  const census = JSON.parse(censusBytes.toString("utf8"));
  const plan = JSON.parse(planBytes.toString("utf8"));
  return {
    ...verifyWalmartListingIntegrityCatalogArtifacts({ census, plan }),
    census_file_sha256: sha256(censusBytes),
    plan_file_sha256: sha256(planBytes),
    external_effects: {
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
      model_calls: 0,
      paid_api_calls: 0,
    },
  };
}

function approvedImageHost(hostname) {
  return hostname === "target.scene7.com"
    || hostname === "walmartimages.com"
    || hostname.endsWith(".walmartimages.com")
    || hostname.endsWith(".r2.dev");
}

function exactCaptureUrl(value, label) {
  const raw = boundedText(value, label, 4_096);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be an absolute URL`); }
  if (url.protocol !== "https:" || url.username || url.password || !approvedImageHost(url.hostname)) {
    throw new Error(`${label} uses an unapproved image origin`);
  }
  url.hash = "";
  return url.toString();
}

async function readShaBoundJson(file, expectedSha, label) {
  const bytes = await readFile(file);
  if (sha256(bytes) !== expectedSha) throw new Error(`${label} exact-file SHA-256 mismatch`);
  return JSON.parse(bytes.toString("utf8"));
}

async function fetchExactImage(url, fetchFn) {
  let current = exactCaptureUrl(url, "task.url");
  const redirects = [];
  for (let hop = 0; hop <= 3; hop += 1) {
    const response = await fetchFn(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        // The frozen downstream snapshot/vision contract accepts only these
        // three raster formats. Advertising AVIF made Target legitimately
        // return bytes that the engine must then reject.
        accept: "image/webp,image/png,image/jpeg,*/*;q=0.5",
        "accept-encoding": "identity",
        "user-agent": "SS-Command-Center-Walmart-Listing-Integrity/1.0",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 3) throw new Error("image redirect limit exceeded");
      const location = response.headers.get("location");
      if (!location) throw new Error("image redirect has no Location header");
      const next = exactCaptureUrl(new URL(location, current).toString(), "redirect location");
      redirects.push({ status: response.status, from: current, to: next });
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`image GET returned HTTP ${response.status}`);
    }
    const rawLength = response.headers.get("content-length");
    if (rawLength && (!/^\d+$/u.test(rawLength) || Number(rawLength) > 15 * 1024 * 1024)) {
      throw new Error("image Content-Length exceeds 15 MiB cap");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) {
      throw new Error("image body is empty or exceeds 15 MiB cap");
    }
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format)
      || !metadata.width || !metadata.height
      || metadata.width * metadata.height > 40_000_000) {
      throw new Error("image body is not a bounded JPEG/PNG/WebP raster");
    }
    return {
      bytes,
      final_url: current,
      redirects,
      http_status: response.status,
      content_type: response.headers.get("content-type"),
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
    };
  }
  throw new Error("unreachable image fetch state");
}

export async function captureWalmartListingIntegrityPartition(options, injected = {}) {
  const fetchFn = injected.fetch ?? globalThis.fetch;
  const now = injected.now ?? (() => new Date());
  const census = await readShaBoundJson(
    options.census,
    options.expect_census_sha256,
    "census",
  );
  const plan = await readShaBoundJson(options.plan, options.expect_plan_sha256, "scan plan");
  verifyWalmartListingIntegrityCatalogArtifacts({ census, plan });
  const matches = plan.partitions.filter((row) => row.partition_id === options.partition_id);
  if (matches.length !== 1) throw new Error("--partition-id must select exactly one sealed partition");
  const partition = matches[0];
  try {
    await lstat(options.output_dir);
    throw new Error("--output-dir must not already exist");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(options.output_dir, { recursive: false, mode: 0o700 });
  const assetsDir = path.join(options.output_dir, "assets");
  await mkdir(assetsDir, { recursive: false, mode: 0o700 });
  const results = [];
  let networkGets = 0;
  for (const task of partition.tasks) {
    try {
      const captured = await fetchExactImage(task.url, async (...args) => {
        networkGets += 1;
        return fetchFn(...args);
      });
      const assetSha = sha256(captured.bytes);
      const relativePath = `assets/${task.task_id}.${captured.format}`;
      await writeExclusive(path.join(options.output_dir, relativePath), captured.bytes);
      results.push({
        task,
        status: "CAPTURED",
        exact_source_url_match: task.url === captured.final_url,
        final_url: captured.final_url,
        redirects: captured.redirects,
        http_status: captured.http_status,
        content_type: captured.content_type,
        asset: {
          path: relativePath,
          sha256: assetSha,
          bytes: captured.bytes.length,
          format: captured.format,
          width: captured.width,
          height: captured.height,
        },
      });
    } catch (error) {
      results.push({
        task,
        status: "TECH_ERROR",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }
  const capturedAtValue = now();
  const capturedAt = capturedAtValue instanceof Date
    ? capturedAtValue.toISOString()
    : new Date(capturedAtValue).toISOString();
  const body = {
    schema_version: "walmart-listing-integrity-image-capture/v1",
    captured_at: capturedAt,
    census_file_sha256: options.expect_census_sha256,
    census_body_sha256: census.body_sha256,
    plan_file_sha256: options.expect_plan_sha256,
    plan_body_sha256: plan.body_sha256,
    partition_id: partition.partition_id,
    partition_index: partition.partition_index,
    execution: {
      mode: "READ_ONLY_IMAGE_CAPTURE",
      planned_tasks: partition.tasks.length,
      network_get_attempts: networkGets,
      retries: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_api_calls: 0,
      walmart_writes: 0,
      paid_api_calls: 0,
    },
    outcome: {
      captured: results.filter((row) => row.status === "CAPTURED").length,
      technical_errors: results.filter((row) => row.status === "TECH_ERROR").length,
      complete: results.every((row) => row.status === "CAPTURED"),
    },
    results,
  };
  const envelope = {
    ...body,
    body_sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
  const indexBytes = jsonBytes(envelope);
  const indexSha = sha256(indexBytes);
  await writeExclusive(path.join(options.output_dir, "capture-index.json"), indexBytes);
  await writeExclusive(
    path.join(options.output_dir, "capture-index.sha256"),
    Buffer.from(`${indexSha}\n`),
  );
  await chmod(assetsDir, 0o500);
  await chmod(options.output_dir, 0o500);
  return {
    status: body.outcome.complete ? "CAPTURE_COMPLETE" : "CAPTURE_PARTIAL",
    output_dir: options.output_dir,
    capture_index_sha256: indexSha,
    partition_id: partition.partition_id,
    outcome: body.outcome,
    execution: body.execution,
  };
}

export async function verifyWalmartListingIntegrityCapture(options) {
  const census = await readShaBoundJson(
    options.census,
    options.expect_census_sha256,
    "census",
  );
  const plan = await readShaBoundJson(options.plan, options.expect_plan_sha256, "scan plan");
  verifyWalmartListingIntegrityCatalogArtifacts({ census, plan });
  const capture = await readShaBoundJson(
    options.capture_index,
    options.expect_capture_index_sha256,
    "capture index",
  );
  if (capture.schema_version !== "walmart-listing-integrity-image-capture/v1"
    || capture.census_file_sha256 !== options.expect_census_sha256
    || capture.census_body_sha256 !== census.body_sha256
    || capture.plan_file_sha256 !== options.expect_plan_sha256
    || capture.plan_body_sha256 !== plan.body_sha256) {
    throw new Error("capture index source binding mismatch");
  }
  const captureBody = { ...capture };
  delete captureBody.body_sha256;
  const rebuiltBodySha = createHash("sha256")
    .update(JSON.stringify(captureBody))
    .digest("hex");
  if (rebuiltBodySha !== capture.body_sha256) throw new Error("capture body seal mismatch");
  const partitions = plan.partitions.filter((row) => row.partition_id === capture.partition_id);
  if (partitions.length !== 1) throw new Error("capture partition is absent from the sealed plan");
  const partition = partitions[0];
  if (!Array.isArray(capture.results)
    || capture.results.length !== partition.tasks.length
    || capture.results.some((row, index) => (
      JSON.stringify(row.task) !== JSON.stringify(partition.tasks[index])
    ))) {
    throw new Error("capture task population/order differs from the sealed partition");
  }
  const captureRoot = path.dirname(options.capture_index);
  const assetsRoot = path.join(captureRoot, "assets");
  const referenced = new Set();
  let capturedCount = 0;
  let technicalErrors = 0;
  for (const row of capture.results) {
    if (row.status === "TECH_ERROR") {
      technicalErrors += 1;
      if (typeof row.error !== "string" || !row.error) {
        throw new Error("TECH_ERROR capture row lacks an error");
      }
      continue;
    }
    if (row.status !== "CAPTURED" || !row.asset || typeof row.asset !== "object") {
      throw new Error("capture result has an unsupported state");
    }
    capturedCount += 1;
    const relative = boundedText(row.asset.path, "capture asset path", 500);
    if (!/^assets\/image-[a-f0-9]{20}\.(?:jpeg|png|webp)$/u.test(relative)) {
      throw new Error("capture asset path is not canonical");
    }
    const file = path.resolve(captureRoot, relative);
    if (!file.startsWith(`${assetsRoot}${path.sep}`) || referenced.has(file)) {
      throw new Error("capture asset path escapes or is duplicated");
    }
    referenced.add(file);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("capture asset must be a regular file");
    const bytes = await readFile(file);
    if (bytes.length !== row.asset.bytes || sha256(bytes) !== row.asset.sha256) {
      throw new Error("capture asset exact bytes differ from the index");
    }
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (metadata.format !== row.asset.format
      || metadata.width !== row.asset.width
      || metadata.height !== row.asset.height) {
      throw new Error("capture asset decoded metadata differs from the index");
    }
  }
  const actualFiles = (await readdir(assetsRoot)).sort();
  const expectedFiles = [...referenced].map((file) => path.basename(file)).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("capture assets directory contains missing or extra files");
  }
  if (capture.outcome?.captured !== capturedCount
    || capture.outcome?.technical_errors !== technicalErrors
    || capture.outcome?.complete !== (technicalErrors === 0)
    || capture.execution?.network_get_attempts < partition.tasks.length
    || capture.execution?.retries !== 0
    || capture.execution?.model_calls !== 0
    || capture.execution?.database_writes !== 0
    || capture.execution?.walmart_writes !== 0) {
    throw new Error("capture outcome/execution counters are inconsistent");
  }
  return {
    verified: true,
    partition_id: partition.partition_id,
    tasks: partition.tasks.length,
    captured: capturedCount,
    technical_errors: technicalErrors,
    complete: technicalErrors === 0,
    external_effects: {
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
      model_calls: 0,
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
  if (options.command === "verify") {
    process.stdout.write(`${JSON.stringify(await verifyFiles(options), null, 2)}\n`);
    return;
  }
  if (options.command === "capture") {
    process.stdout.write(`${JSON.stringify(
      await captureWalmartListingIntegrityPartition(options),
      null,
      2,
    )}\n`);
    return;
  }
  if (options.command === "verify-capture") {
    process.stdout.write(`${JSON.stringify(
      await verifyWalmartListingIntegrityCapture(options),
      null,
      2,
    )}\n`);
    return;
  }
  const artifacts = await buildFromDatabase(options.store_index);
  const output = planSummary(artifacts.census, artifacts.plan);
  if (options.command === "snapshot") {
    output.local_artifacts = {
      output_dir: options.output_dir,
      ...await writeSnapshot(options.output_dir, artifacts),
    };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
