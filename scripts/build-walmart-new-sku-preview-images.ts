#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { buildDeterministicWalmartMultipackImage } from
  "../src/lib/bundle-factory/walmart-new-sku-multipack-image";

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("--slug must contain letters or numbers");
  return slug;
}

function parseArgs(argv: string[]): {
  source: string;
  outDir: string;
  slug: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`expected --flag value near ${flag ?? "end"}`);
    }
    if (values.has(flag)) throw new Error(`duplicate flag ${flag}`);
    values.set(flag, value);
  }
  for (const flag of values.keys()) {
    if (!["--source", "--out-dir", "--slug"].includes(flag)) {
      throw new Error(`unsupported flag ${flag}`);
    }
  }
  const source = values.get("--source")?.trim();
  const outDir = values.get("--out-dir")?.trim();
  if (!source || !outDir) {
    throw new Error("--source and --out-dir are required");
  }
  return {
    source: resolve(source),
    outDir: resolve(outDir),
    slug: safeSlug(values.get("--slug") ?? basename(source).replace(/\.[^.]+$/, "")),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceBytes = await readFile(args.source);
  const [pack2, pack3] = await Promise.all([
    buildDeterministicWalmartMultipackImage({
      sourceUnitImageBytes: sourceBytes,
      packCount: 2,
    }),
    buildDeterministicWalmartMultipackImage({
      sourceUnitImageBytes: sourceBytes,
      packCount: 3,
    }),
  ]);
  await mkdir(args.outDir, { recursive: true });
  const pack2Name = `${args.slug}-pack-of-2.png`;
  const pack3Name = `${args.slug}-pack-of-3.png`;
  await Promise.all([
    writeFile(resolve(args.outDir, pack2Name), pack2.bytes),
    writeFile(resolve(args.outDir, pack3Name), pack3.bytes),
    writeFile(
      resolve(args.outDir, "multipack-image-manifest.json"),
      `${JSON.stringify({
        schema_version: "walmart-preview-multipack-images/1.0.0",
        product_slug: args.slug,
        source_file: basename(args.source),
        source_asset_sha256: pack2.source_asset_sha256,
        outputs: [
          {
            file: pack2Name,
            output_sha256: pack2.output_sha256,
            represented_unit_count: 2,
          },
          {
            file: pack3Name,
            output_sha256: pack3.output_sha256,
            represented_unit_count: 3,
          },
        ],
        construction_method: pack2.construction_method,
        canvas: pack2.canvas,
      }, null, 2)}\n`,
      "utf8",
    ),
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    source_asset_sha256: pack2.source_asset_sha256,
    pack_2_output_sha256: pack2.output_sha256,
    pack_3_output_sha256: pack3.output_sha256,
    marketplace_mutated: false,
    database_mutated: false,
  }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    marketplace_mutated: false,
    database_mutated: false,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
