#!/usr/bin/env node

import { config } from "dotenv";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { uploadToR2 } from "@/lib/walmart/multipack/r2";

config({ path: ".env.local" });
config({ path: ".env" });

const APPLY = process.argv.includes("--apply");
const SOURCE =
  "data/audits/uncrustables-owner-relaxed-main-publication-manifest-20260719-v1/" +
  "uncrustables-owner-relaxed-main-publication-manifest-20260719-v1.json";
const OUTPUT_DIR =
  "data/audits/uncrustables-owner-relaxed-main-r2-staging-20260719-v1";

interface SourceAsset {
  relative_path: string;
  sha256: string;
  byte_size: number;
}

interface SourceRow {
  ordinal: number;
  sku: string;
  asin: string;
  exact_recipe_signature: string;
  publication_asset: SourceAsset;
  rollback_main: SourceAsset;
}

interface SourceManifest {
  schema_version: string;
  rows: SourceRow[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mediaType(bytes: Buffer): { extension: "png" | "jpg"; contentType: string } {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return { extension: "png", contentType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  throw new Error("Only PNG and JPEG MAIN assets are allowed.");
}

async function verifiedPublicRead(url: string, expectedSha: string): Promise<boolean> {
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`R2 read failed for ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expectedSha) {
    throw new Error(`R2 content-addressed object has unexpected bytes: ${url}`);
  }
  return true;
}

async function main(): Promise<void> {
  const sourceBytes = await readFile(SOURCE);
  const source = JSON.parse(sourceBytes.toString("utf8")) as SourceManifest;
  if (
    source.schema_version !==
      "uncrustables-owner-relaxed-main-publication-manifest/v1" ||
    !Array.isArray(source.rows) ||
    source.rows.length !== 24
  ) {
    throw new Error("Unexpected owner-relaxed publication manifest.");
  }

  const publicBase = process.env.R2_PUBLIC_URL?.replace(/\/+$/, "");
  if (!publicBase || !/^https:\/\//.test(publicBase)) {
    throw new Error("R2_PUBLIC_URL is missing or is not HTTPS.");
  }

  const unique = new Map<
    string,
    { asset: SourceAsset; bytes: Buffer; key: string; url: string; contentType: string }
  >();
  for (const row of source.rows) {
    const bytes = await readFile(row.publication_asset.relative_path);
    const actualSha = sha256(bytes);
    if (
      actualSha !== row.publication_asset.sha256 ||
      bytes.length !== row.publication_asset.byte_size
    ) {
      throw new Error(`Local publication asset changed for ${row.sku}.`);
    }
    const type = mediaType(bytes);
    const key =
      `bundle-factory/uncrustables/main-repair/20260719-v1/` +
      `${actualSha}.${type.extension}`;
    unique.set(actualSha, {
      asset: row.publication_asset,
      bytes,
      key,
      url: `${publicBase}/${key}`,
      contentType: type.contentType,
    });
  }
  if (unique.size !== 23) throw new Error(`Expected 23 unique assets, got ${unique.size}.`);

  if (!APPLY) {
    console.log(
      JSON.stringify(
        {
          mode: "DRY_RUN",
          source_sha256: sha256(sourceBytes),
          rows: source.rows.length,
          unique_assets: unique.size,
          would_upload_or_verify: [...unique.values()].map((item) => ({
            sha256: item.asset.sha256,
            key: item.key,
            byte_size: item.asset.byte_size,
            content_type: item.contentType,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const staged = new Map<
    string,
    { r2_key: string; r2_url: string; sha256: string; uploaded: boolean }
  >();
  let uploads = 0;
  let reused = 0;
  for (const item of [...unique.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    let exists = await verifiedPublicRead(item.url, item.asset.sha256);
    const uploaded = !exists;
    if (!exists) {
      const returnedUrl = await uploadToR2(item.bytes, item.key, item.contentType);
      if (returnedUrl !== item.url) {
        throw new Error(`R2 helper returned an unexpected URL for ${item.key}.`);
      }
      exists = await verifiedPublicRead(item.url, item.asset.sha256);
      if (!exists) throw new Error(`R2 read-after-write returned 404 for ${item.key}.`);
      uploads += 1;
    } else {
      reused += 1;
    }
    staged.set(item.asset.sha256, {
      r2_key: item.key,
      r2_url: item.url,
      sha256: item.asset.sha256,
      uploaded,
    });
  }

  const rows = source.rows.map((row) => {
    const item = staged.get(row.publication_asset.sha256);
    if (!item) throw new Error(`Missing staged asset for ${row.sku}.`);
    return {
      ordinal: row.ordinal,
      sku: row.sku,
      asin: row.asin,
      exact_recipe_signature: row.exact_recipe_signature,
      main_r2_url: item.r2_url,
      main_sha256: item.sha256,
      rollback_main: row.rollback_main,
      amazon_status: "NOT_PUBLISHED",
    };
  });

  const result = {
    schema_version: "uncrustables-owner-relaxed-main-r2-staging/v1",
    generated_at: new Date().toISOString(),
    source_manifest: {
      path: SOURCE,
      sha256: sha256(sourceBytes),
    },
    summary: {
      rows: rows.length,
      unique_assets: unique.size,
      r2_uploads: uploads,
      r2_existing_verified: reused,
      amazon_mutations: 0,
    },
    status: "R2_VERIFIED_NOT_AMAZON_PUBLISHED",
    rows,
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  const output = path.join(OUTPUT_DIR, "uncrustables-owner-relaxed-main-r2-staging-20260719-v1.json");
  const body = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(output, body, { flag: "wx" });
  console.log(
    JSON.stringify(
      {
        ok: true,
        output,
        output_sha256: sha256(Buffer.from(body)),
        summary: result.summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
