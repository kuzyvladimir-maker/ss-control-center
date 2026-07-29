#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS,
} from "@/lib/walmart/maruchan-roast-chicken-repair";
import { composeTiledMainImage } from "@/lib/walmart/multipack/composite";
import { uploadToR2 } from "@/lib/walmart/multipack/r2";

const MANIFEST_SCHEMA =
  "walmart-maruchan-roast-chicken-image-assets/1.0.0";

function fail(message: string): never {
  throw new Error(`Maruchan image asset build failed: ${message}`);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("canonical JSON rejects undefined");
  return encoded;
}

function exactAbsolute(value: string | undefined, label: string): string {
  if (!value) fail(`${label} is required`);
  const resolved = path.resolve(value);
  if (resolved !== value) fail(`${label} must be an exact absolute path`);
  return resolved;
}

function parseArgs(argv: string[]): { source: string; out: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) fail("arguments must be --key value");
    values.set(key, value);
  }
  return {
    source: exactAbsolute(values.get("--source"), "--source"),
    out: exactAbsolute(values.get("--out"), "--out"),
  };
}

async function verifyPublicBytes(url: string, expected: Buffer): Promise<void> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: { "accept-encoding": "identity" },
  });
  if (response.status !== 200) {
    fail(`public asset verification returned HTTP ${response.status}`);
  }
  const actual = Buffer.from(await response.arrayBuffer());
  if (sha256(actual) !== sha256(expected)) {
    fail("public asset bytes differ from uploaded bytes");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = await readFile(args.source);
  const metadata = await sharp(source).metadata();
  if (
    metadata.format !== "jpeg"
    || (metadata.width ?? 0) < 1500
    || (metadata.height ?? 0) < 1500
  ) {
    fail("exact source must be a zoom-capable JPEG of at least 1500px");
  }
  await mkdir(args.out, { recursive: false, mode: 0o700 });
  await chmod(args.out, 0o700);

  const sourceSha = sha256(source);
  const sourceFilename = `exact-roast-chicken-carton-${sourceSha.slice(0, 16)}.jpg`;
  await writeFile(path.join(args.out, sourceFilename), source, {
    mode: 0o400,
    flag: "wx",
  });
  const cartonKey =
    `walmart-listing-integrity/maruchan-roast-chicken/carton-${sourceSha}.jpg`;
  const cartonUrl = await uploadToR2(source, cartonKey, "image/jpeg");
  await verifyPublicBytes(cartonUrl, source);

  const images: Array<Record<string, unknown>> = [];
  for (const row of MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS) {
    const tiledPng = await composeTiledMainImage(source, row.carton_count);
    const main = await sharp(tiledPng)
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
      .toBuffer();
    const mainMetadata = await sharp(main).metadata();
    if (
      mainMetadata.format !== "jpeg"
      || mainMetadata.width !== mainMetadata.height
      || (mainMetadata.width ?? 0) < 1500
    ) {
      fail(`${row.sku} MAIN does not meet the square zoom-image contract`);
    }
    const mainSha = sha256(main);
    const filename = `${row.sku}-main-${mainSha.slice(0, 16)}.jpg`;
    await writeFile(path.join(args.out, filename), main, {
      mode: 0o400,
      flag: "wx",
    });
    const key =
      `walmart-listing-integrity/maruchan-roast-chicken/${row.sku}/main-${mainSha}.jpg`;
    const url = await uploadToR2(main, key, "image/jpeg");
    await verifyPublicBytes(url, main);
    images.push({
      sku: row.sku,
      represented_cartons: row.carton_count,
      represented_cups: row.cup_count,
      filename,
      sha256: mainSha,
      byte_length: main.byteLength,
      width: mainMetadata.width,
      height: mainMetadata.height,
      public_url: url,
      source_sha256: sourceSha,
      generation: "DETERMINISTIC_EXACT_CARTON_TILING",
    });
  }

  const body = {
    schema_version: MANIFEST_SCHEMA,
    created_at: new Date().toISOString(),
    exact_variant: {
      brand: "Maruchan",
      product_line: "Instant Lunch",
      flavor: "Roast Chicken Flavor",
      unit_size_oz: 2.25,
      manufacturer_carton_count: 12,
    },
    source: {
      filename: sourceFilename,
      sha256: sourceSha,
      byte_length: source.byteLength,
      width: metadata.width,
      height: metadata.height,
      public_url: cartonUrl,
      public_url_verified_exact_bytes: true,
    },
    images,
    claims: {
      image_generation_model_calls: 0,
      synthetic_product_or_packaging: false,
      exact_variant_source_only: true,
      public_bytes_verified: true,
    },
  };
  const manifest = {
    ...body,
    body_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
  await writeFile(
    path.join(args.out, "manifest.json"),
    Buffer.from(`${canonicalJson(manifest)}\n`, "utf8"),
    { mode: 0o400, flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify({
    status: "BUILT_AND_PUBLICLY_VERIFIED",
    output_directory: args.out,
    manifest_body_sha256: manifest.body_sha256,
    images: images.map((image) => ({
      sku: image.sku,
      sha256: image.sha256,
      public_url: image.public_url,
    })),
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
