#!/usr/bin/env node

/**
 * Build one deterministic Walmart multipack MAIN candidate from exact
 * canonical Product Truth content. This command performs one bounded image GET
 * and local immutable writes only. It never calls a model, database, R2 or
 * Walmart mutation endpoint.
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

import { composeTiledMainImage } from "../src/lib/walmart/multipack/composite.ts";
import type { ProductTruthSnapshot } from "../src/lib/sourcing/product-truth-read-contract.ts";

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`Walmart MAIN candidate rejected input: ${message}`);
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
  const expected = ["product-truth", "diagnosis", "output-dir"] as const;
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${expected.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    productTruth: exactPath(flags.get("product-truth"), "--product-truth"),
    diagnosis: exactPath(flags.get("diagnosis"), "--diagnosis"),
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

async function fetchExactImage(url: string): Promise<{
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
}> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("canonical MAIN source URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail("canonical MAIN source URL must be credential-free HTTPS");
  }
  const response = await fetch(parsed, {
    redirect: "error",
    headers: { accept: "image/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`canonical MAIN source returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    fail("canonical MAIN source exceeds the byte bound");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    fail("canonical MAIN source is empty or exceeds the byte bound");
  }
  const finalUrl = response.url;
  if (finalUrl !== parsed.toString()) fail("canonical MAIN source redirected");
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!contentType.startsWith("image/")) fail("canonical MAIN source is not an image");
  await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 }).metadata();
  return { bytes, contentType, finalUrl };
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
  const [truthArtifact, diagnosisArtifact] = await Promise.all([
    readJson<ProductTruthSnapshot>(args.productTruth, "Product Truth"),
    readJson<JsonRecord>(args.diagnosis, "diagnosis"),
  ]);
  const truth = truthArtifact.value;
  const components = truth.views?.listingImprovement?.components ?? [];
  if (!truth.views?.listingImprovement?.ready || components.length !== 1) {
    fail("Listing Improvement Product Truth is not exact one-component READY");
  }
  const component = components[0]!;
  if (!component.content || component.contentBlockers.length
    || component.content.canonicalVariantId !== component.targetCanonicalVariantId
    || component.content.identity.outerPackCount !== 1
    || !Number.isSafeInteger(component.qty) || component.qty < 2 || component.qty > 24) {
    fail("Product Truth does not authorize one same-product multipack candidate");
  }
  if (diagnosisArtifact.value.listing_key !== truth.snapshot.listingKey
    || (diagnosisArtifact.value.outcome as JsonRecord | undefined)?.status !== "BAD") {
    fail("diagnosis is not a BAD result for the same listing");
  }
  const sourceUrl = component.content.facts.mainImageUrl;
  if (!sourceUrl) fail("exact canonical content has no MAIN source image");
  const fetched = await fetchExactImage(sourceUrl);
  const candidate = await composeTiledMainImage(fetched.bytes, component.qty);
  const candidateMeta = await sharp(candidate, {
    failOn: "error",
    limitInputPixels: 100_000_000,
  }).metadata();
  if (candidateMeta.width !== 2200 || candidateMeta.height !== 2200
    || candidateMeta.format !== "png") {
    fail("candidate is not the required 2200x2200 PNG");
  }
  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  const sourceName = "exact-single-unit-source.bin";
  const candidateName = "proposed-main-pack.png";
  await writeExclusive(path.join(args.outputDir, sourceName), fetched.bytes);
  await writeExclusive(path.join(args.outputDir, candidateName), candidate);
  const createdAt = new Date().toISOString();
  const body = {
    schema_version: "walmart-listing-main-candidate/v1",
    created_at: createdAt,
    listing_key: truth.snapshot.listingKey,
    sku: truth.snapshot.sku,
    component_index: component.componentIndex,
    canonical_variant_id: component.targetCanonicalVariantId,
    represented_outer_units: component.qty,
    source: {
      url: fetched.finalUrl,
      content_type: fetched.contentType,
      file: sourceName,
      sha256: sha256(fetched.bytes),
      bytes: fetched.bytes.length,
      product_truth_file_sha256: sha256(truthArtifact.bytes),
      content_observation_id: component.content.provenance.contentObservationId,
      content_hash: component.content.provenance.contentHash,
    },
    candidate: {
      file: candidateName,
      sha256: sha256(candidate),
      bytes: candidate.length,
      width: candidateMeta.width,
      height: candidateMeta.height,
      format: candidateMeta.format,
      derivation: "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE",
    },
    diagnosis: {
      file_sha256: sha256(diagnosisArtifact.bytes),
      required_defect: "MAIN_OUTER_QUANTITY_MISMATCH",
    },
    safety: {
      image_gets: 1,
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
  await writeExclusive(
    path.join(args.outputDir, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
  await chmod(args.outputDir, 0o700);
  process.stdout.write(`${JSON.stringify({
    status: "CANDIDATE_READY_FOR_VISUAL_QUALIFICATION",
    listing_key: truth.snapshot.listingKey,
    represented_outer_units: component.qty,
    candidate_path: path.join(args.outputDir, candidateName),
    candidate_sha256: manifest.candidate.sha256,
    manifest_path: path.join(args.outputDir, "manifest.json"),
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
