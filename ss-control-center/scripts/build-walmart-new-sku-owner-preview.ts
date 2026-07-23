#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildWalmartNewSkuOwnerPreviewGallery } from
  "../src/lib/bundle-factory/walmart-new-sku-owner-preview";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function numberValue(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`);
  const values = parsed.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  if (values.length === 0) throw new Error(`${label} cannot be empty`);
  return values;
}

function parseArgs(argv: string[]): {
  source: string;
  sourceSha: string;
  out: string;
  generatedAt: string;
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
  const allowed = new Set(["--source", "--source-sha", "--out", "--generated-at"]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error(`unsupported flag ${flag}`);
  }
  return {
    source: resolve(textValue(values.get("--source"), "--source")),
    sourceSha: resolve(textValue(values.get("--source-sha"), "--source-sha")),
    out: resolve(textValue(values.get("--out"), "--out")),
    generatedAt: textValue(values.get("--generated-at"), "--generated-at"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [sourceBytes, expectedShaRaw] = await Promise.all([
    readFile(args.source),
    readFile(args.sourceSha, "utf8"),
  ]);
  const actualSha = createHash("sha256").update(sourceBytes).digest("hex");
  const expectedSha = expectedShaRaw.trim().split(/\s+/)[0] ?? "";
  if (actualSha !== expectedSha) {
    throw new Error(`source plan SHA mismatch: ${actualSha} != ${expectedSha}`);
  }
  const plan = record(JSON.parse(sourceBytes.toString("utf8")), "plan");
  const targets = plan.targets;
  if (!Array.isArray(targets) || targets.length !== 1) {
    throw new Error("preview source must contain exactly one Product Truth target");
  }
  const target = record(targets[0], "target");
  const legacy = record(target.legacySnapshot, "target.legacySnapshot");
  const product = record(
    JSON.parse(textValue(legacy.donorProductRowJson, "donorProductRowJson")),
    "donorProductRow",
  );
  const offer = record(
    JSON.parse(textValue(legacy.donorOfferRowJson, "donorOfferRowJson")),
    "donorOfferRow",
  );
  const artifact = buildWalmartNewSkuOwnerPreviewGallery({
    generatedAt: args.generatedAt,
    sourcePlanPath: args.source,
    sourcePlanSha256: actualSha,
    donorProductId: textValue(target.donorProductId, "donorProductId"),
    canonicalVariantId: textValue(
      target.canonicalVariantId,
      "canonicalVariantId",
    ),
    manufacturerUpc: textValue(product.upc, "manufacturer UPC"),
    productName: textValue(product.title, "product title"),
    brand: textValue(product.brand, "brand"),
    flavor: typeof product.flavor === "string" && product.flavor.trim()
      ? product.flavor.trim()
      : null,
    size: textValue(product.size, "size"),
    category: textValue(product.category, "category"),
    unitNetWeightOz: numberValue(product.unitAmount, "unit amount"),
    unitPriceCents: Math.round(
      numberValue(offer.pricePerUnit, "pricePerUnit") * 100,
    ),
    packagingCostCents: 150,
    shippingLabelCents: 878,
    description: textValue(product.description, "description"),
    ingredients: textValue(product.ingredients, "ingredients"),
    mainImageUrl: textValue(product.mainImageUrl, "mainImageUrl"),
    imageUrls: stringArray(product.imageUrls, "imageUrls"),
    packCounts: [2, 3],
  });
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "build-walmart-new-sku-owner-preview",
    output_path: args.out,
    artifact_sha256: artifact.artifact_sha256,
    listing_preview_count: artifact.listing_previews.length,
    marketplace_mutated: false,
    database_mutated: false,
    upc_reserved: false,
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
