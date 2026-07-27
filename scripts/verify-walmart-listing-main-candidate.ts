#!/usr/bin/env node

/**
 * Blind visual Qualification for one local Walmart MAIN candidate. The model
 * sees only the candidate pixels and an opaque image ID. Deterministic code
 * compares the signed observation to exact Product Truth.
 */

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  decideBlind,
  type AuditExpectedTruth,
  type AuditImageInput,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import { preprocessCatalogVisual } from "../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
  buildWalmartListingSingleObserverPlan,
  buildWalmartListingSingleObserverRequest,
  verifyWalmartListingSingleWorkerHealth,
  verifyWalmartListingSingleWorkerResponse,
} from "../src/lib/walmart/listing-integrity-single-observer.ts";
import { sshWorkerJson } from "./walmart-listing-integrity-process.ts";

type JsonRecord = Record<string, unknown>;
const MAX_JSON_BYTES = 100 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(`Walmart MAIN candidate Qualification failed: ${message}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key])}`
  ).join(",")}}`;
}

function bodySha256(value: unknown): string {
  return sha256(Buffer.from(canonical(value), "utf8"));
}

function exactPath(value: string | undefined, label: string): string {
  if (!value || value !== value.trim() || value.includes("\0")) {
    fail(`${label} must be an explicit path`);
  }
  return path.resolve(value);
}

function parseArgs(argv: readonly string[]) {
  const flags = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) fail(`unsupported or duplicate argument: ${argument}`);
    flags.set(match[1]!, match[2]!);
  }
  const expected = ["candidate-dir", "diagnosis", "output-dir"] as const;
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${expected.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    candidateDir: exactPath(flags.get("candidate-dir"), "--candidate-dir"),
    diagnosis: exactPath(flags.get("diagnosis"), "--diagnosis"),
    outputDir: exactPath(flags.get("output-dir"), "--output-dir"),
  };
}

async function readJson(pathname: string, label: string): Promise<{
  bytes: Buffer;
  value: JsonRecord;
}> {
  const bytes = await readFile(pathname);
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) fail(`${label} exceeds the byte bound`);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object`);
    return { bytes, value: value as JsonRecord };
  } catch {
    return fail(`${label} is not JSON`);
  }
}

async function writeExclusive(pathname: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args.outputDir);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifestPath = path.join(args.candidateDir, "manifest.json");
  const [manifestArtifact, diagnosisArtifact] = await Promise.all([
    readJson(manifestPath, "candidate manifest"),
    readJson(args.diagnosis, "diagnosis"),
  ]);
  const manifest = manifestArtifact.value;
  const claimedBody = manifest.body_sha256;
  const body = { ...manifest };
  delete body.body_sha256;
  if (manifest.schema_version !== "walmart-listing-main-candidate/v1"
    || typeof claimedBody !== "string"
    || bodySha256(body) !== claimedBody) {
    fail("candidate manifest seal is invalid");
  }
  const candidate = manifest.candidate as JsonRecord;
  const candidateFile = candidate?.file;
  const candidateSha = candidate?.sha256;
  if (typeof candidateFile !== "string" || candidateFile !== "proposed-main-pack.png"
    || typeof candidateSha !== "string" || !/^[a-f0-9]{64}$/u.test(candidateSha)) {
    fail("candidate manifest file identity is invalid");
  }
  const candidateBytes = await readFile(path.join(args.candidateDir, candidateFile));
  if (sha256(candidateBytes) !== candidateSha) fail("candidate bytes changed");
  const detector = diagnosisArtifact.value.detector_input as JsonRecord | undefined;
  const listing = detector?.listing as JsonRecord | undefined;
  const expected = detector?.expected as AuditExpectedTruth | undefined;
  if (diagnosisArtifact.value.listing_key !== manifest.listing_key
    || (diagnosisArtifact.value.outcome as JsonRecord | undefined)?.status !== "BAD"
    || listing?.listing_key !== manifest.listing_key
    || typeof listing?.item_id !== "string"
    || !expected
    || expected.outer_units !== manifest.represented_outer_units) {
    fail("diagnosis and candidate scope differ");
  }
  const preprocessed = await preprocessCatalogVisual(candidateBytes, {
    full_max_edge: 1600,
    crop_max_edge: 1800,
    analysis_max_edge: 512,
    max_crop_upscale: 2,
    limit_input_pixels: 40_000_000,
  });
  const full = preprocessed.views.find((view) => view.role === "full");
  if (!full || full.media_type !== "image/jpeg") fail("deterministic full JPEG is missing");
  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  const modelRoot = path.join(args.outputDir, "model-assets");
  await mkdir(modelRoot, { recursive: false, mode: 0o700 });
  const modelRelative = `model-assets/00-${candidateSha.slice(0, 16)}.jpeg`;
  await writeExclusive(path.join(args.outputDir, modelRelative), full.bytes);
  const plan = buildWalmartListingSingleObserverPlan({
    created_at: new Date().toISOString(),
    listing_key: String(manifest.listing_key),
    item_id: listing.item_id,
    intake_index_file_sha256: sha256(manifestArtifact.bytes),
    intake_index_body_sha256: String(claimedBody),
    prepared_assets: [{
      slot: "main",
      source_asset_sha256: candidateSha,
      model_asset: {
        path: modelRelative,
        sha256: full.sha256,
        bytes: full.bytes.length,
        media_type: "image/jpeg",
        width: full.width,
        height: full.height,
      },
    }],
  });
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeExclusive(path.join(args.outputDir, "observer-plan.json"), planBytes);
  const health = await sshWorkerJson("health", "", 30_000);
  if (health.status !== 200) fail(`worker health returned HTTP ${health.status}`);
  verifyWalmartListingSingleWorkerHealth(
    health.value,
    WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
  );
  await writeExclusive(path.join(args.outputDir, "worker-health.json"), health.bytes);
  const request = buildWalmartListingSingleObserverRequest(plan, 0, [full.bytes]);
  const requestBytes = Buffer.from(request.body, "utf8");
  await writeExclusive(path.join(args.outputDir, "call-00-request.json"), requestBytes);
  let response;
  try {
    response = await sshWorkerJson(
      "analyze",
      request.body,
      plan.worker_contract.vision_timeout_ms + 60_000,
    );
  } catch (error) {
    const unknown = {
      schema_version: "walmart-listing-main-candidate-qualification-unknown/v1",
      created_at: new Date().toISOString(),
      listing_key: manifest.listing_key,
      candidate_sha256: candidateSha,
      call_key: plan.calls[0]!.call_key,
      request_sha256: sha256(requestBytes),
      retry_allowed: false,
      error_fingerprint_sha256: sha256(Buffer.from(
        error instanceof Error ? `${error.name}:${error.message}` : String(error),
        "utf8",
      )),
    };
    await writeExclusive(
      path.join(args.outputDir, "UNKNOWN-OUTCOME.json"),
      Buffer.from(`${JSON.stringify(unknown, null, 2)}\n`, "utf8"),
    );
    return fail("worker outcome is unknown; the exact call must not be retried");
  }
  await writeExclusive(path.join(args.outputDir, "call-00-response.json"), response.bytes);
  const verified = verifyWalmartListingSingleWorkerResponse({
    plan,
    call_index: 0,
    request: request.value,
    http_status: response.status,
    response: response.value,
  });
  const observation = verified.observations[0]!;
  const image: AuditImageInput = {
    slot: "main",
    url: `https://candidate.invalid/${candidateSha}.png`,
    buyer_facing_verified: false,
    surface: "last_applied_artifact",
  };
  const decision = decideBlind({
    case_id: `candidate:${candidateSha}`,
    sku: String(manifest.sku),
    expected,
    images: [image],
  }, image, observation, { ocr_texts: [] });
  const reportBody = {
    schema_version: "walmart-listing-main-candidate-qualification/v1",
    created_at: new Date().toISOString(),
    status: decision.verdict === "PASS" ? "PASS" : "FAIL",
    listing_key: manifest.listing_key,
    candidate_sha256: candidateSha,
    candidate_manifest_file_sha256: sha256(manifestArtifact.bytes),
    candidate_manifest_body_sha256: claimedBody,
    diagnosis_file_sha256: sha256(diagnosisArtifact.bytes),
    observer_plan_body_sha256: plan.body_sha256,
    call_key: plan.calls[0]!.call_key,
    observation,
    decision,
    worker_receipt: verified.worker_receipt,
    safety: {
      subscription_calls_consumed: 1,
      transport_attempts: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      database_reads: 0,
      database_writes: 0,
      r2_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    },
  } as const;
  const report = { ...reportBody, body_sha256: bodySha256(reportBody) };
  await writeExclusive(
    path.join(args.outputDir, "qualification.json"),
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"),
  );
  await chmod(modelRoot, 0o500);
  await chmod(args.outputDir, 0o500);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    listing_key: report.listing_key,
    candidate_sha256: report.candidate_sha256,
    decision: report.decision,
    qualification_path: path.join(args.outputDir, "qualification.json"),
    qualification_body_sha256: report.body_sha256,
    safety: report.safety,
  }, null, 2)}\n`);
  if (report.status !== "PASS") process.exitCode = 2;
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
