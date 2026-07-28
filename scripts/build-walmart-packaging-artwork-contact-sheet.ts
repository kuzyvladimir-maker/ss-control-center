#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import sharp from "sharp";

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

function stringArray(value: unknown, label: string): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`);
  const values = parsed.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
  if (values.length === 0) throw new Error(`${label} cannot be empty`);
  return values;
}

function parseArgs(argv: string[]): {
  sourcePlan: string;
  out: string;
  manifest: string;
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
    if (!["--source-plan", "--out", "--manifest"].includes(flag)) {
      throw new Error(`unsupported flag ${flag}`);
    }
  }
  return {
    sourcePlan: resolve(
      textValue(values.get("--source-plan"), "--source-plan"),
    ),
    out: resolve(textValue(values.get("--out"), "--out")),
    manifest: resolve(textValue(values.get("--manifest"), "--manifest")),
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactImageUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`donor image must use HTTPS: ${raw}`);
  }
  if (url.hostname === "target.scene7.com") {
    url.searchParams.set("fmt", "pjpeg");
    url.searchParams.set("qlt", "92");
    url.searchParams.set("wid", "900");
    url.searchParams.set("hei", "900");
  }
  return url.toString();
}

function escapeSvg(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(exactImageUrl(url), {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`image GET returned HTTP ${response.status}: ${url}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`image GET returned ${contentType || "no Content-Type"}: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new Error(`image bytes are empty or exceed 10 MB: ${url}`);
  }
  await sharp(bytes, { failOn: "warning" }).metadata();
  return bytes;
}

async function buildTile(bytes: Buffer, index: number): Promise<Buffer> {
  const image = await sharp(bytes, { failOn: "warning" })
    .resize({
      width: 450,
      height: 450,
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();
  const label = Buffer.from(
    `<svg width="480" height="54" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="480" height="54" fill="#111827"/>` +
      `<text x="18" y="36" fill="white" font-family="Arial,sans-serif" ` +
      `font-size="26" font-weight="700">${escapeSvg(`#${index}`)}</text>` +
      `</svg>`,
  );
  return sharp({
    create: {
      width: 480,
      height: 520,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: image, left: 15, top: 8 },
      { input: label, left: 0, top: 466 },
    ])
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourcePlanBytes = await readFile(args.sourcePlan);
  const plan = record(
    JSON.parse(sourcePlanBytes.toString("utf8")),
    "source plan",
  );
  if (!Array.isArray(plan.targets) || plan.targets.length !== 1) {
    throw new Error("source plan must contain exactly one target");
  }
  const target = record(plan.targets[0], "target");
  const legacy = record(target.legacySnapshot, "target.legacySnapshot");
  const product = record(
    JSON.parse(textValue(legacy.donorProductRowJson, "donorProductRowJson")),
    "donorProductRow",
  );
  const mainImageUrl = textValue(product.mainImageUrl, "mainImageUrl");
  const urls = [...new Set([
    mainImageUrl,
    ...stringArray(product.imageUrls, "imageUrls"),
  ])];
  const sourceImages = await Promise.all(
    urls.map(async (url, index) => {
      const bytes = await downloadImage(url);
      return {
        index: index + 1,
        url,
        bytes,
        sha256: sha256(bytes),
        tile: await buildTile(bytes, index + 1),
      };
    }),
  );
  const columns = Math.min(4, sourceImages.length);
  const rows = Math.ceil(sourceImages.length / columns);
  const contactSheet = await sharp({
    create: {
      width: columns * 480,
      height: rows * 520,
      channels: 3,
      background: { r: 229, g: 231, b: 235 },
    },
  })
    .composite(sourceImages.map((image, index) => ({
      input: image.tile,
      left: (index % columns) * 480,
      top: Math.floor(index / columns) * 520,
    })))
    .png()
    .toBuffer();
  const manifest = {
    schema_version: "walmart-packaging-artwork-contact-sheet/1.0.0",
    source_plan_path: args.sourcePlan,
    source_plan_sha256: sha256(sourcePlanBytes),
    donor_product_id: textValue(target.donorProductId, "donorProductId"),
    canonical_variant_id: textValue(
      target.canonicalVariantId,
      "canonicalVariantId",
    ),
    product_title: textValue(product.title, "product title"),
    main_image_url: mainImageUrl,
    images: sourceImages.map((image) => ({
      index: image.index,
      url: image.url,
      downloaded_asset_sha256: image.sha256,
    })),
    contact_sheet_sha256: sha256(contactSheet),
    external_effects: {
      database_writes: 0,
      marketplace_writes: 0,
      provider_calls: 0,
      upc_reserved: false,
    },
  };
  await Promise.all([
    mkdir(dirname(args.out), { recursive: true }),
    mkdir(dirname(args.manifest), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(args.out, contactSheet),
    writeFile(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    image_count: sourceImages.length,
    contact_sheet_path: args.out,
    contact_sheet_sha256: manifest.contact_sheet_sha256,
    manifest_path: args.manifest,
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
