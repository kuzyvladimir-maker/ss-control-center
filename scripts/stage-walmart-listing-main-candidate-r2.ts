#!/usr/bin/env node

/**
 * Stage one already-qualified Walmart Listing Integrity MAIN candidate at a
 * content-addressed R2 key and verify the exact bytes through both S3 custody
 * and the public URL. This command never calls Walmart, a model, or a database.
 */

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message: string): never {
  throw new Error(`Walmart MAIN R2 staging rejected input: ${message}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as JsonRecord;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(row[key])}`
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value !== value.trim()) fail(`${name} is missing`);
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

async function readJson(pathname: string, label: string): Promise<{
  bytes: Buffer;
  value: JsonRecord;
}> {
  const bytes = await readFile(pathname);
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) fail(`${label} exceeds its byte bound`);
  try {
    return { bytes, value: record(JSON.parse(bytes.toString("utf8")), label) };
  } catch {
    return fail(`${label} is not UTF-8 JSON`);
  }
}

async function boundedBody(
  body: { transformToByteArray(): Promise<Uint8Array> } | undefined,
  label: string,
): Promise<Buffer> {
  if (!body) fail(`${label} has no response body`);
  const bytes = Buffer.from(await body.transformToByteArray());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail(`${label} exceeds the image cap`);
  return bytes;
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

function parseArgs(argv: readonly string[]) {
  const flags = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) fail(`unsupported or duplicate argument: ${argument}`);
    flags.set(match[1]!, match[2]!);
  }
  const exact = ["candidate-dir", "qualification", "output-dir"] as const;
  if (flags.size !== exact.length || exact.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${exact.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    candidateDir: exactPath(flags.get("candidate-dir"), "--candidate-dir"),
    qualification: exactPath(flags.get("qualification"), "--qualification"),
    outputDir: exactPath(flags.get("output-dir"), "--output-dir"),
  };
}

function publicUrl(base: string, key: string): string {
  const normalized = base.replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(`${normalized}/${key}`);
  } catch {
    return fail("R2_PUBLIC_URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    fail("R2 public URL must be credential-free query-free HTTPS");
  }
  return parsed.toString();
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
  const [manifestArtifact, qualificationArtifact] = await Promise.all([
    readJson(manifestPath, "candidate manifest"),
    readJson(args.qualification, "candidate qualification"),
  ]);
  const manifest = manifestArtifact.value;
  const manifestBody = { ...manifest };
  delete manifestBody.body_sha256;
  const manifestBodySha = digest(manifest.body_sha256, "candidate manifest body_sha256");
  const curatedImageSet =
    manifest.schema_version === "walmart-listing-image-set-curated/v1";
  if ((manifest.schema_version !== "walmart-listing-main-candidate/v1"
      && !curatedImageSet)
    || bodySha256(manifestBody) !== manifestBodySha) {
    fail("candidate manifest seal is invalid");
  }
  const qualification = qualificationArtifact.value;
  const qualificationBody = { ...qualification };
  delete qualificationBody.body_sha256;
  const qualificationBodySha = digest(
    qualification.body_sha256,
    "candidate qualification body_sha256",
  );
  const standardQualification =
    qualification.schema_version === "walmart-listing-main-candidate-qualification/v1"
    && qualification.status === "PASS";
  const curatedQualification =
    curatedImageSet
    && qualification.schema_version === "walmart-listing-image-set-candidate-qualification/v1"
    && manifest.status === "PASS"
    && manifest.source_qualification_file_sha256 === sha256(qualificationArtifact.bytes)
    && manifest.source_qualification_body_sha256 === qualificationBodySha;
  if ((!standardQualification && !curatedQualification)
    || bodySha256(qualificationBody) !== qualificationBodySha) {
    fail("candidate qualification is not a sealed PASS");
  }
  const candidate = curatedImageSet
    ? record(
      (manifest.targets as unknown[] | undefined)?.[0],
      "curated candidate manifest.targets[0]",
    )
    : record(manifest.candidate, "candidate manifest.candidate");
  const candidateSha = digest(candidate.sha256, "candidate SHA");
  if (curatedImageSet) {
    const selections = manifest.selections;
    const mainSelection = Array.isArray(selections)
      ? record(selections[0], "curated candidate manifest.selections[0]")
      : fail("curated candidate selections are missing");
    const decision = record(mainSelection.decision, "curated MAIN decision");
    if (candidate.slot !== "main" || mainSelection.target_slot !== "main"
      || mainSelection.asset_sha256 !== candidateSha || decision.verdict !== "PASS") {
      fail("curated candidate MAIN is not a deterministic PASS");
    }
  } else if (qualification.candidate_sha256 !== candidateSha
    || qualification.candidate_manifest_file_sha256 !== sha256(manifestArtifact.bytes)
    || qualification.candidate_manifest_body_sha256 !== manifestBodySha) {
    fail("candidate qualification differs from the exact candidate manifest");
  }
  const candidateName = text(candidate.file, "candidate file", 200);
  if (candidateName !== (curatedImageSet ? "target-main.png" : "proposed-main-pack.png")) {
    fail("candidate file is unsupported");
  }
  const candidateBytes = await readFile(path.join(args.candidateDir, candidateName));
  if (!candidateBytes.length || candidateBytes.length > MAX_IMAGE_BYTES
    || sha256(candidateBytes) !== candidateSha) {
    fail("candidate bytes changed or exceed Walmart's image cap");
  }
  const listingKey = text(manifest.listing_key, "listing_key", 1_024);
  const sku = text(manifest.sku, "sku", 512);
  const safeSku = sku.replace(/[^A-Za-z0-9_-]/gu, "_");
  const key = `walmart-listing-integrity/${safeSku}/main/${candidateSha}.png`;

  const bucket = requiredEnv("R2_BUCKET_NAME");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${requiredEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });

  let objectPreviouslyPresent = false;
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    objectPreviouslyPresent = true;
    if (Number(head.ContentLength) !== candidateBytes.length
      || head.ContentType !== "image/png"
      || head.Metadata?.sha256 !== candidateSha) {
      fail("existing content-addressed R2 object metadata differs from candidate");
    }
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404) throw error;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: candidateBytes,
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: {
        sha256: candidateSha,
        listingkeysha256: sha256(Buffer.from(listingKey, "utf8")),
      },
      IfNoneMatch: "*",
    }));
  }

  const custody = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const custodyBytes = await boundedBody(custody.Body, "R2 read-after-write");
  if (sha256(custodyBytes) !== candidateSha) {
    fail("R2 read-after-write bytes differ from candidate");
  }
  const url = publicUrl(requiredEnv("R2_PUBLIC_URL"), key);
  const response = await fetch(url, {
    redirect: "error",
    headers: { accept: "image/png" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.url !== url) {
    fail(`public R2 verification returned HTTP ${response.status} or redirected`);
  }
  const publicBytes = Buffer.from(await response.arrayBuffer());
  if (!publicBytes.length || publicBytes.length > MAX_IMAGE_BYTES
    || sha256(publicBytes) !== candidateSha) {
    fail("public R2 bytes differ from candidate");
  }

  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  const body = {
    schema_version: curatedImageSet
      ? "walmart-listing-main-r2-staging/v2"
      : "walmart-listing-main-r2-staging/v1",
    created_at: new Date().toISOString(),
    status: "R2_VERIFIED_NOT_WALMART_PUBLISHED",
    listing_key: listingKey,
    sku,
    candidate: {
      sha256: candidateSha,
      bytes: candidateBytes.length,
      content_type: "image/png",
      candidate_manifest_file_sha256: sha256(manifestArtifact.bytes),
      candidate_manifest_body_sha256: manifestBodySha,
      qualification_file_sha256: sha256(qualificationArtifact.bytes),
      qualification_body_sha256: qualificationBodySha,
    },
    r2: {
      bucket_sha256: sha256(Buffer.from(bucket, "utf8")),
      key,
      public_url: url,
      object_previously_present: objectPreviouslyPresent,
      custody_read_sha256: sha256(custodyBytes),
      public_read_sha256: sha256(publicBytes),
    },
    safety: {
      r2_head_calls: 1,
      r2_put_calls: objectPreviouslyPresent ? 0 : 1,
      r2_get_calls: 1,
      public_image_gets: 1,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
      price_inventory_delist_actions: 0,
    },
  } as const;
  const report = { ...body, body_sha256: bodySha256(body) };
  await writeExclusive(
    path.join(args.outputDir, "r2-staging.json"),
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"),
  );
  await chmod(args.outputDir, 0o500);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    listing_key: listingKey,
    public_url: url,
    candidate_sha256: candidateSha,
    staging_path: path.join(args.outputDir, "r2-staging.json"),
    staging_body_sha256: report.body_sha256,
    safety: report.safety,
  }, null, 2)}\n`);
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
