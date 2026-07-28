/**
 * Build local, labelled contact sheets for human review of a completed
 * Uncrustables cooler-hero manifest.
 *
 * This is a read-only marketplace operation: it downloads only the immutable
 * R2 assets referenced by the manifest and writes local QA artifacts. It never
 * calls Amazon or Prisma.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

interface HeroRow {
  sku: string;
  asin: string;
  status: string;
  result?: {
    ok?: boolean;
    image_url?: string;
    image_sha256?: string;
    expected_flavors?: string[];
    total_units?: number;
    qa?: { pass?: boolean; verified?: boolean };
  };
}

interface HeroManifest {
  immutable?: boolean;
  run_id?: string;
  summary?: { target?: number; succeeded?: number; failed?: number };
  rows?: HeroRow[];
}

interface Args {
  manifest: string;
  outputDir: string;
  columns: number;
  rows: number;
}

interface UniqueAsset {
  url: string;
  /** A resumed run can retain an older immutable R2 key for bytes that a later
   * row addresses through the canonical sha256/ key. Every distinct URL is
   * downloaded and digest-checked before the contact sheet is accepted. */
  urls: string[];
  sha256: string;
  skus: string[];
  asins: string[];
  totals: number[];
  flavors: string[];
}

const TILE_WIDTH = 560;
const IMAGE_SIZE = 520;
const LABEL_HEIGHT = 150;
const TILE_HEIGHT = IMAGE_SIZE + LABEL_HEIGHT;

function positiveInt(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 10) {
    throw new Error(`${flag} must be an integer from 1 to 10.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    manifest: "",
    outputDir: "data/audits/hero-contact-sheets",
    columns: 3,
    rows: 3,
  };
  for (const arg of argv) {
    if (arg.startsWith("--manifest=")) args.manifest = arg.slice(11).trim();
    else if (arg.startsWith("--output-dir=")) args.outputDir = arg.slice(13).trim();
    else if (arg.startsWith("--columns=")) args.columns = positiveInt("--columns", arg.slice(10));
    else if (arg.startsWith("--rows=")) args.rows = positiveInt("--rows", arg.slice(7));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/build-uncrustables-hero-contact-sheets.ts " +
        "--manifest=UHG-MANIFEST.json [--output-dir=PATH] [--columns=3] [--rows=3]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.manifest) throw new Error("--manifest=PATH is required.");
  if (!args.outputDir) throw new Error("--output-dir cannot be empty.");
  return args;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrap(value: string, width: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (words.join(" ").length > lines.join(" ").length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[. ]+$/, "")}...`;
  }
  return lines;
}

function labelSvg(asset: UniqueAsset): Buffer {
  const skuText = asset.skus.length <= 3
    ? asset.skus.join(", ")
    : `${asset.skus.slice(0, 3).join(", ")} +${asset.skus.length - 3}`;
  const totals = [...new Set(asset.totals)].sort((a, b) => a - b).join("/");
  const flavorText = asset.flavors.join(" + ");
  const lines = [
    `${skuText} | ${totals} Count | ${asset.sha256.slice(0, 10)}`,
    ...wrap(flavorText, 76, 3),
  ];
  const tspans = lines
    .map((line, index) =>
      `<tspan x="18" y="${34 + index * 30}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  return Buffer.from(
    `<svg width="${TILE_WIDTH}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#f4f6f4"/>` +
      `<text font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#102018">${tspans}</text>` +
    `</svg>`,
  );
}

async function fetchVerifiedImage(asset: UniqueAsset): Promise<Buffer> {
  let primary: Buffer | null = null;
  for (const url of asset.urls) {
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const image = Buffer.from(await response.arrayBuffer());
    const actual = sha256(image);
    if (actual !== asset.sha256) {
      throw new Error(`${url}: image SHA mismatch ${actual} != ${asset.sha256}`);
    }
    primary ??= image;
  }
  if (!primary) throw new Error(`${asset.sha256}: no image URL to verify`);
  return primary;
}

async function tile(asset: UniqueAsset): Promise<Buffer> {
  const image = await fetchVerifiedImage(asset);
  const resized = await sharp(image)
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "contain", background: "white" })
    .extend({
      top: 0,
      bottom: 0,
      left: (TILE_WIDTH - IMAGE_SIZE) / 2,
      right: (TILE_WIDTH - IMAGE_SIZE) / 2,
      background: "white",
    })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      channels: 3,
      background: "white",
    },
  })
    .composite([
      { input: resized, left: 0, top: 0 },
      { input: labelSvg(asset), left: 0, top: IMAGE_SIZE },
    ])
    .png()
    .toBuffer();
}

function uniqueAssets(manifest: HeroManifest): UniqueAsset[] {
  if (
    manifest.immutable !== true ||
    manifest.summary?.failed !== 0 ||
    manifest.summary?.succeeded !== manifest.summary?.target ||
    !Array.isArray(manifest.rows)
  ) {
    throw new Error("Hero manifest is not complete and immutable.");
  }
  const bySha = new Map<string, UniqueAsset>();
  for (const row of manifest.rows) {
    const result = row.result;
    if (
      row.status !== "SUCCEEDED" ||
      result?.ok !== true ||
      result.qa?.pass !== true ||
      result.qa?.verified !== true ||
      typeof result.image_url !== "string" ||
      !/^https:\/\//.test(result.image_url) ||
      typeof result.image_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.image_sha256) ||
      !Array.isArray(result.expected_flavors) ||
      result.expected_flavors.length === 0 ||
      !Number.isInteger(result.total_units) ||
      (result.total_units ?? 0) <= 0
    ) {
      throw new Error(`Manifest row ${row.sku} is not a QA-verified hero.`);
    }
    const existing = bySha.get(result.image_sha256);
    const asset = existing ?? {
      url: result.image_url,
      urls: [result.image_url],
      sha256: result.image_sha256,
      skus: [],
      asins: [],
      totals: [],
      flavors: [],
    };
    if (!asset.urls.includes(result.image_url)) asset.urls.push(result.image_url);
    asset.skus.push(row.sku);
    asset.asins.push(row.asin);
    asset.totals.push(result.total_units as number);
    asset.flavors.push(...result.expected_flavors);
    asset.flavors = [...new Set(asset.flavors)].sort();
    bySha.set(asset.sha256, asset);
  }
  return [...bySha.values()].sort((left, right) =>
    left.flavors.join("|").localeCompare(right.flavors.join("|")) ||
    left.sha256.localeCompare(right.sha256),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.manifest);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as HeroManifest;
  const assets = uniqueAssets(manifest);
  const perSheet = args.columns * args.rows;
  const outputDir = path.resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });

  const sheetFiles: string[] = [];
  for (let offset = 0; offset < assets.length; offset += perSheet) {
    const group = assets.slice(offset, offset + perSheet);
    const tiles = await Promise.all(group.map(tile));
    const width = args.columns * TILE_WIDTH;
    const height = args.rows * TILE_HEIGHT;
    const composites = tiles.map((input, index) => ({
      input,
      left: (index % args.columns) * TILE_WIDTH,
      top: Math.floor(index / args.columns) * TILE_HEIGHT,
    }));
    const number = String(sheetFiles.length + 1).padStart(2, "0");
    const name = `hero-contact-sheet-${number}.png`;
    await sharp({ create: { width, height, channels: 3, background: "white" } })
      .composite(composites)
      .png()
      .toFile(path.join(outputDir, name));
    sheetFiles.push(name);
  }

  const reportBody = {
    schema_version: "uncrustables-hero-contact-sheets/v1.0",
    immutable: true,
    created_at: new Date().toISOString(),
    source_manifest: {
      path: manifestPath,
      sha256: sha256(manifestBytes),
      run_id: manifest.run_id ?? null,
    },
    summary: {
      manifest_rows: manifest.rows?.length ?? 0,
      unique_assets: assets.length,
      contact_sheets: sheetFiles.length,
      amazon_calls: 0,
      database_calls: 0,
    },
    sheets: sheetFiles,
    assets,
  };
  const report = { ...reportBody, sha256: sha256(JSON.stringify(reportBody)) };
  const reportPath = path.join(outputDir, "manifest.json");
  const handle = await open(reportPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  console.log(JSON.stringify({ output_dir: outputDir, ...report.summary }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
