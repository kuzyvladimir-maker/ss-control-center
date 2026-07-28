#!/usr/bin/env node

/**
 * Build one exact Walmart target image set for a same-product multipack.
 *
 * MAIN is the already-built deterministic multipack candidate. Gallery assets
 * are downloaded only from the exact Product Truth content observation for the
 * same canonical variant. This command performs bounded GETs and local
 * immutable writes only; it never calls a model, database, R2, or Walmart
 * mutation endpoint.
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

import sharp from "sharp";

import type { ProductTruthSnapshot } from "../src/lib/sourcing/product-truth-read-contract.ts";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GALLERY_IMAGES = 19;

function fail(message: string): never {
  throw new Error(`Walmart image-set candidate rejected input: ${message}`);
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
    "product-truth",
    "diagnosis",
    "main-candidate-dir",
    "output-dir",
  ] as const;
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${expected.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    productTruth: exactPath(flags.get("product-truth"), "--product-truth"),
    diagnosis: exactPath(flags.get("diagnosis"), "--diagnosis"),
    mainCandidateDir: exactPath(flags.get("main-candidate-dir"), "--main-candidate-dir"),
    outputDir: exactPath(flags.get("output-dir"), "--output-dir"),
  };
}

async function readJson<T>(pathname: string, label: string): Promise<{
  bytes: Buffer;
  value: T;
}> {
  const bytes = await readFile(pathname);
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) fail(`${label} exceeds the byte bound`);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
  } catch {
    return fail(`${label} is not JSON`);
  }
}

function exactHttps(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(`${label} is not a URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.search || parsed.hash || parsed.toString() !== value) {
    fail(`${label} must be canonical query-free HTTPS`);
  }
  return value;
}

async function fetchExactImage(url: string, label: string): Promise<{
  bytes: Buffer;
  contentType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}> {
  const exactUrl = exactHttps(url, label);
  const response = await fetch(exactUrl, {
    redirect: "error",
    cache: "no-store",
    headers: { accept: "image/jpeg,image/png" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.url !== exactUrl) {
    fail(`${label} returned HTTP ${response.status} or redirected`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    fail(`${label} exceeds the byte bound`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    fail(`${label} is empty or exceeds the byte bound`);
  }
  const metadata = await sharp(bytes, {
    failOn: "error",
    limitInputPixels: 100_000_000,
  }).metadata();
  const contentType = metadata.format === "png"
    ? "image/png" as const
    : metadata.format === "jpeg"
      ? "image/jpeg" as const
      : fail(`${label} is not PNG/JPEG`);
  if (!metadata.width || !metadata.height || metadata.width < 400 || metadata.height < 400) {
    fail(`${label} dimensions are missing or too small`);
  }
  return {
    bytes,
    contentType,
    width: metadata.width,
    height: metadata.height,
  };
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
  const mainManifestPath = path.join(args.mainCandidateDir, "manifest.json");
  const mainAssetPath = path.join(args.mainCandidateDir, "proposed-main-pack.png");
  const [truthArtifact, diagnosisArtifact, mainManifestArtifact, mainBytes] =
    await Promise.all([
      readJson<ProductTruthSnapshot>(args.productTruth, "Product Truth"),
      readJson<JsonRecord>(args.diagnosis, "diagnosis"),
      readJson<JsonRecord>(mainManifestPath, "MAIN candidate manifest"),
      readFile(mainAssetPath),
    ]);
  const truth = truthArtifact.value;
  const components = truth.views?.listingImprovement?.components ?? [];
  if (!truth.views?.listingImprovement?.ready || components.length !== 1) {
    fail("Listing Improvement Product Truth is not exact one-component READY");
  }
  const component = components[0]!;
  const content = component.content;
  if (!content || component.contentBlockers.length
    || content.canonicalVariantId !== component.targetCanonicalVariantId
    || !Number.isSafeInteger(component.qty) || component.qty < 2 || component.qty > 24) {
    fail("Product Truth component/count/content is incomplete");
  }
  if (diagnosisArtifact.value.listing_key !== truth.snapshot.listingKey
    || (diagnosisArtifact.value.outcome as JsonRecord | undefined)?.status !== "BAD") {
    fail("diagnosis is not BAD for the same listing");
  }
  const mainManifest = mainManifestArtifact.value;
  const mainCandidate = mainManifest.candidate as JsonRecord | undefined;
  const mainSource = mainManifest.source as JsonRecord | undefined;
  if (mainManifest.schema_version !== "walmart-listing-main-candidate/v1"
    || mainManifest.listing_key !== truth.snapshot.listingKey
    || mainManifest.canonical_variant_id !== component.targetCanonicalVariantId
    || mainManifest.represented_outer_units !== component.qty
    || mainSource?.product_truth_file_sha256 !== sha256(truthArtifact.bytes)
    || mainCandidate?.sha256 !== sha256(mainBytes)
    || mainCandidate?.file !== "proposed-main-pack.png") {
    fail("MAIN candidate does not bind to this exact Product Truth");
  }
  const sourceGallery = (content.facts.imageUrls ?? [])
    .filter((url) => url !== content.facts.mainImageUrl);
  const galleryUrls = [...new Set(sourceGallery)].slice(0, MAX_GALLERY_IMAGES);
  if (galleryUrls.length < 1) fail("exact Product Truth has no gallery images");
  const downloaded = await Promise.all(galleryUrls.map((url, index) => (
    fetchExactImage(url, `Product Truth gallery ${index + 1}`)
  )));
  const mainMetadata = await sharp(mainBytes, {
    failOn: "error",
    limitInputPixels: 100_000_000,
  }).metadata();
  if (mainMetadata.format !== "png" || mainMetadata.width !== 2200
    || mainMetadata.height !== 2200) {
    fail("MAIN candidate is not the exact 2200x2200 PNG");
  }

  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  const targets = [{
    slot: "main" as const,
    file: "target-main.png",
    source_url: null,
    source_role: "DETERMINISTIC_MULTIPACK_MAIN" as const,
    sha256: sha256(mainBytes),
    bytes: mainBytes.length,
    content_type: "image/png" as const,
    width: 2200,
    height: 2200,
    derivation: "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE" as const,
  }];
  await writeExclusive(path.join(args.outputDir, "target-main.png"), mainBytes);
  for (const [index, image] of downloaded.entries()) {
    const ordinal = index + 1;
    const extension = image.contentType === "image/png" ? "png" : "jpg";
    const file = `target-gallery-${String(ordinal).padStart(2, "0")}.${extension}`;
    await writeExclusive(path.join(args.outputDir, file), image.bytes);
    targets.push({
      slot: `gallery-${ordinal}` as `gallery-${number}`,
      file,
      source_url: galleryUrls[index]!,
      source_role: "EXACT_PRODUCT_TRUTH_GALLERY" as const,
      sha256: sha256(image.bytes),
      bytes: image.bytes.length,
      content_type: image.contentType,
      width: image.width,
      height: image.height,
      derivation: "DIRECT_EXACT_PRODUCT_TRUTH_ASSET" as const,
    });
  }
  const body = {
    schema_version: "walmart-listing-image-set-candidate/v1",
    created_at: new Date().toISOString(),
    listing_key: truth.snapshot.listingKey,
    sku: truth.snapshot.sku,
    canonical_variant_id: component.targetCanonicalVariantId,
    content_observation_id: content.provenance.contentObservationId,
    content_hash: content.provenance.contentHash,
    represented_outer_units: component.qty,
    product_truth_file_sha256: sha256(truthArtifact.bytes),
    diagnosis_file_sha256: sha256(diagnosisArtifact.bytes),
    main_candidate_manifest_file_sha256: sha256(mainManifestArtifact.bytes),
    targets,
    safety: {
      image_gets: downloaded.length,
      model_calls: 0,
      paid_calls: 0,
      database_reads: 0,
      database_writes: 0,
      r2_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    },
  } as const;
  const manifest = { ...body, body_sha256: bodySha256(body) };
  const manifestPath = path.join(args.outputDir, "manifest.json");
  await writeExclusive(
    manifestPath,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
  await chmod(args.outputDir, 0o700);
  process.stdout.write(`${JSON.stringify({
    status: "IMAGE_SET_READY_FOR_VISUAL_QUALIFICATION",
    listing_key: manifest.listing_key,
    target_count: targets.length,
    target_main_sha256: targets[0]!.sha256,
    manifest_path: manifestPath,
    manifest_body_sha256: manifest.body_sha256,
    safety: manifest.safety,
  }, null, 2)}\n`);
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
