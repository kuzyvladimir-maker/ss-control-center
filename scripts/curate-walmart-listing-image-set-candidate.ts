#!/usr/bin/env node

/**
 * Deterministically curate a previously signed target image-set observation.
 *
 * No model is called. MAIN is recomputed with the current comparator and only
 * gallery assets with an exact deterministic PASS are retained. Selected
 * gallery slots are renumbered contiguously for the final Walmart target.
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
  type BlindObservation,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import {
  auditGallerySlot,
  type GalleryAuditDecision,
} from "../src/lib/walmart/catalog-gallery-audit.ts";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 100 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(`Walmart image-set curation rejected input: ${message}`);
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
  const expected = [
    "candidate-dir",
    "qualification-dir",
    "diagnosis",
    "output-dir",
  ] as const;
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${expected.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    candidateDir: exactPath(flags.get("candidate-dir"), "--candidate-dir"),
    qualificationDir: exactPath(flags.get("qualification-dir"), "--qualification-dir"),
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
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${label} is not an object`);
    }
    return { bytes, value: value as JsonRecord };
  } catch {
    return fail(`${label} is not JSON`);
  }
}

function verifySeal(value: JsonRecord, label: string): string {
  if (typeof value.body_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.body_sha256)) {
    fail(`${label}.body_sha256 is invalid`);
  }
  const body = { ...value };
  delete body.body_sha256;
  if (bodySha256(body) !== value.body_sha256) fail(`${label} body SHA mismatch`);
  return value.body_sha256;
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
  const qualificationPath = path.join(args.qualificationDir, "qualification.json");
  const [manifestArtifact, qualificationArtifact, diagnosisArtifact] = await Promise.all([
    readJson(manifestPath, "source candidate manifest"),
    readJson(qualificationPath, "source qualification"),
    readJson(args.diagnosis, "diagnosis"),
  ]);
  const manifest = manifestArtifact.value;
  const qualification = qualificationArtifact.value;
  const manifestBodySha = verifySeal(manifest, "source candidate manifest");
  const qualificationBodySha = verifySeal(qualification, "source qualification");
  if (manifest.schema_version !== "walmart-listing-image-set-candidate/v1"
    || qualification.schema_version !== "walmart-listing-image-set-candidate-qualification/v1"
    || qualification.candidate_manifest_file_sha256 !== sha256(manifestArtifact.bytes)
    || qualification.candidate_manifest_body_sha256 !== manifestBodySha
    || qualification.diagnosis_file_sha256 !== sha256(diagnosisArtifact.bytes)
    || qualification.listing_key !== manifest.listing_key
    || diagnosisArtifact.value.listing_key !== manifest.listing_key) {
    fail("source manifest, signed qualification, and diagnosis do not bind together");
  }
  const sourceTargets = manifest.targets;
  const qualifiedTargets = qualification.targets;
  const detector = diagnosisArtifact.value.detector_input as JsonRecord | undefined;
  const expected = detector?.expected as AuditExpectedTruth | undefined;
  if (!Array.isArray(sourceTargets) || !Array.isArray(qualifiedTargets)
    || sourceTargets.length !== qualifiedTargets.length || sourceTargets.length < 2
    || !expected || expected.outer_units !== manifest.represented_outer_units) {
    fail("source target population or Product Truth is incomplete");
  }

  const observations: BlindObservation[] = [];
  for (const [index, value] of qualifiedTargets.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`qualified target ${index} is not an object`);
    }
    const row = value as JsonRecord;
    const source = sourceTargets[index] as JsonRecord;
    if (row.slot !== source.slot || row.asset_sha256 !== source.sha256
      || row.source_bytes_sha256 !== source.sha256
      || !row.observation || typeof row.observation !== "object") {
      fail(`qualified target ${index} differs from the exact source asset`);
    }
    observations.push(row.observation as unknown as BlindObservation);
  }

  const sourceMain = sourceTargets[0] as JsonRecord;
  const mainImage: AuditImageInput = {
    slot: "main",
    url: `https://candidate.invalid/${String(sourceMain.sha256)}.png`,
    buyer_facing_verified: false,
    surface: "last_applied_artifact",
  };
  const mainDecision = decideBlind({
    case_id: `curated:${qualificationBodySha}`,
    sku: String(manifest.sku),
    expected,
    images: [mainImage],
  }, mainImage, observations[0]!, { ocr_texts: [] });
  if (mainDecision.verdict !== "PASS") {
    fail(`MAIN did not recompute to PASS: ${mainDecision.hard_failures.join("; ")}`);
  }

  const galleryDecisions: GalleryAuditDecision[] = observations.slice(1).map((
    observation,
    index,
  ) => auditGallerySlot({
    slot: `gallery-${index + 1}`,
    expected,
    source: {
      state: "observed",
      observation,
      auxiliary_ocr: { ocr_texts: [] },
    },
  }));
  const selectedIndexes = galleryDecisions.flatMap((decision, index) => (
    decision.verdict === "PASS" ? [index + 1] : []
  ));
  if (selectedIndexes.length < 1) fail("no gallery asset recomputed to deterministic PASS");

  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  const targets: JsonRecord[] = [];
  const selections: JsonRecord[] = [];
  const sourceIndexes = [0, ...selectedIndexes];
  for (const [targetIndex, sourceIndex] of sourceIndexes.entries()) {
    const source = sourceTargets[sourceIndex] as JsonRecord;
    if (typeof source.file !== "string" || typeof source.sha256 !== "string") {
      fail(`source target ${sourceIndex} file/SHA is invalid`);
    }
    const sourceBytes = await readFile(path.join(args.candidateDir, source.file));
    if (sha256(sourceBytes) !== source.sha256 || sourceBytes.length !== source.bytes) {
      fail(`source target ${sourceIndex} bytes changed`);
    }
    const extension = path.extname(source.file);
    const file = targetIndex === 0
      ? `target-main${extension}`
      : `target-gallery-${String(targetIndex).padStart(2, "0")}${extension}`;
    const targetSlot = targetIndex === 0 ? "main" : `gallery-${targetIndex}`;
    await writeExclusive(path.join(args.outputDir, file), sourceBytes);
    targets.push({
      ...source,
      slot: targetSlot,
      file,
      source_slot: source.slot,
    });
    selections.push({
      target_slot: targetSlot,
      source_slot: source.slot,
      asset_sha256: source.sha256,
      observation: observations[sourceIndex],
      decision: sourceIndex === 0 ? mainDecision : galleryDecisions[sourceIndex - 1],
    });
  }
  const body = {
    schema_version: "walmart-listing-image-set-curated/v1",
    created_at: new Date().toISOString(),
    status: "PASS",
    listing_key: manifest.listing_key,
    sku: manifest.sku,
    canonical_variant_id: manifest.canonical_variant_id,
    content_observation_id: manifest.content_observation_id,
    content_hash: manifest.content_hash,
    represented_outer_units: manifest.represented_outer_units,
    product_truth_file_sha256: manifest.product_truth_file_sha256,
    diagnosis_file_sha256: sha256(diagnosisArtifact.bytes),
    source_candidate_manifest_file_sha256: sha256(manifestArtifact.bytes),
    source_candidate_manifest_body_sha256: manifestBodySha,
    source_qualification_file_sha256: sha256(qualificationArtifact.bytes),
    source_qualification_body_sha256: qualificationBodySha,
    selected_target_count: targets.length,
    targets,
    selections,
    excluded_gallery: galleryDecisions.flatMap((decision, index) => (
      decision.verdict === "PASS" ? [] : [{
        source_slot: `gallery-${index + 1}`,
        verdict: decision.verdict,
        hard_failures: decision.hard_failures,
        review_reasons: decision.review_reasons,
      }]
    )),
    safety: {
      model_calls: 0,
      reused_signed_observations: true,
      database_reads: 0,
      database_writes: 0,
      r2_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    },
  } as const;
  const curated = { ...body, body_sha256: bodySha256(body) };
  const outputPath = path.join(args.outputDir, "manifest.json");
  await writeExclusive(
    outputPath,
    Buffer.from(`${JSON.stringify(curated, null, 2)}\n`, "utf8"),
  );
  await chmod(args.outputDir, 0o500);
  process.stdout.write(`${JSON.stringify({
    status: curated.status,
    listing_key: curated.listing_key,
    selected_targets: selections.map((selection) => ({
      target_slot: selection.target_slot,
      source_slot: selection.source_slot,
      asset_sha256: selection.asset_sha256,
    })),
    excluded_gallery: curated.excluded_gallery,
    manifest_path: outputPath,
    manifest_body_sha256: curated.body_sha256,
    safety: curated.safety,
  }, null, 2)}\n`);
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
