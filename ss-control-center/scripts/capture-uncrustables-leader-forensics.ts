import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { MARKETPLACE_ID, spApiGet } from "../src/lib/amazon-sp-api/client";
import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";

const ANALYSIS_SCHEMA = "uncrustables-historical-sales-analysis/v1";
const CAPTURE_SCHEMA = "uncrustables-leader-forensics-capture/v1";
const CATALOG_INCLUDED_DATA = [
  "attributes",
  "dimensions",
  "identifiers",
  "images",
  "productTypes",
  "relationships",
  "salesRanks",
  "summaries",
].join(",");
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

interface SalesIdentity {
  sku: string;
  asin: string | null;
  preferredTitle: string | null;
  units: number;
  distinctOrders: number;
  grossRevenue: number;
  firstOrderAt: string;
  lastOrderAt: string;
  channelMax: { isSelling: boolean | null; addedAt: string | null } | null;
}

interface SalesAnalysis {
  schemaVersion: string;
  salesByIdentity: SalesIdentity[];
}

interface CatalogImage {
  variant?: unknown;
  link?: unknown;
  width?: unknown;
  height?: unknown;
}

function fail(message: string): never {
  throw new Error(message);
}

function exactArg(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args.indexOf(name, index + 1) >= 0) {
    return fail(`${name} is required exactly once`);
  }
  const value = args[index + 1];
  if (!value || value !== value.trim() || value.startsWith("--")) {
    return fail(`${name} must have one exact value`);
  }
  return value;
}

function exactIntegerArg(args: string[], name: string, minimum: number, maximum: number): number {
  const value = Number(exactArg(args, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeNew(path: string, value: string | Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value);
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    fail(`output already exists: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function boundedImage(url: string): Promise<{ bytes: Buffer; mimeType: string; finalUrl: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "m.media-amazon.com") {
    fail(`catalog image host is not allowed: ${parsed.hostname}`);
  }
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "image/jpeg,image/png,image/webp" },
  });
  const finalUrl = new URL(response.url);
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  if (
    response.status !== 200
    || finalUrl.protocol !== "https:"
    || finalUrl.hostname !== "m.media-amazon.com"
    || !["image/jpeg", "image/png", "image/webp"].includes(mimeType)
  ) fail(`catalog image response is invalid: ${response.status} ${mimeType}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) fail("catalog image is too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) fail("catalog image byte length is invalid");
  return { bytes, mimeType, finalUrl: finalUrl.href };
}

function originalCatalogImages(catalog: Record<string, unknown>): CatalogImage[] {
  const groups = Array.isArray(catalog.images) ? catalog.images : [];
  const rows = groups.flatMap((group) => {
    if (!group || typeof group !== "object") return [];
    const images = (group as Record<string, unknown>).images;
    return Array.isArray(images) ? images as CatalogImage[] : [];
  }).filter((image) =>
    typeof image.variant === "string"
    && typeof image.link === "string"
    && !image.link.includes("._SL75_."));
  const byVariant = new Map<string, CatalogImage>();
  for (const image of rows) {
    const variant = image.variant as string;
    const existing = byVariant.get(variant);
    const area = Number(image.width ?? 0) * Number(image.height ?? 0);
    const existingArea = Number(existing?.width ?? 0) * Number(existing?.height ?? 0);
    if (!existing || area > existingArea) byVariant.set(variant, image);
  }
  return [...byVariant.values()].sort((left, right) =>
    String(left.variant).localeCompare(String(right.variant)));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Capture current Amazon catalog, seller contribution, and image bytes for historical sales leaders.\n"
      + "Required: --analysis ABS --analysis-sha256 SHA --limit 1..50 --out-dir ABS_NEW\n"
      + "Read-only evidence; current observation is not represented as historical listing bytes.",
    );
    return;
  }
  const allowed = new Set(["--analysis", "--analysis-sha256", "--limit", "--out-dir"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const analysisPath = exactArg(args, "--analysis");
  const expectedAnalysisSha = exactArg(args, "--analysis-sha256").toLowerCase();
  const limit = exactIntegerArg(args, "--limit", 1, 50);
  const outDir = exactArg(args, "--out-dir");
  for (const [name, path] of [["--analysis", analysisPath], ["--out-dir", outDir]]) {
    if (!isAbsolute(path) || normalize(path) !== path) fail(`${name} must be a normalized absolute path`);
  }
  const analysisBytes = await readFile(await realpath(analysisPath));
  if (sha256(analysisBytes) !== expectedAnalysisSha) fail("analysis SHA-256 mismatch");
  const analysis = JSON.parse(analysisBytes.toString("utf8")) as SalesAnalysis;
  if (analysis.schemaVersion !== ANALYSIS_SCHEMA || !Array.isArray(analysis.salesByIdentity)) {
    fail("sales analysis schema is invalid");
  }
  const targets = analysis.salesByIdentity
    .filter((row) => typeof row.asin === "string" && /^B0[A-Z0-9]{8}$/u.test(row.asin))
    .slice(0, limit);
  if (targets.length !== limit) fail(`analysis contains fewer than ${limit} ASIN-bound leaders`);
  if (new Set(targets.map((target) => target.asin)).size !== targets.length) {
    fail("leader target ASINs are not unique");
  }
  const parent = dirname(outDir);
  if (await realpath(parent) !== parent) fail("output parent must be a real path");
  await assertAbsent(outDir);
  const temporary = join(parent, `.${basename(outDir)}.tmp-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  const sellerId = process.env.AMAZON_SP_SELLER_ID_STORE1?.trim();
  if (!sellerId) fail("AMAZON_SP_SELLER_ID_STORE1 is required");
  const entries = [];
  let amazonCatalogGetCalls = 0;
  let amazonListingGetCalls = 0;
  let imageGetCalls = 0;
  try {
    for (const [index, sales] of targets.entries()) {
      const ordinal = index + 1;
      const prefix = `${String(ordinal).padStart(3, "0")}-${sales.asin}-${sales.sku}`;
      const entry: Record<string, unknown> = {
        ordinal,
        sales,
        observedAt: new Date().toISOString(),
        catalog: null,
        listingContribution: null,
        images: [],
      };
      try {
        const catalog = await spApiGet(
          `/catalog/2022-04-01/items/${encodeURIComponent(sales.asin ?? "")}`,
          {
            storeId: "store1",
            params: { marketplaceIds: MARKETPLACE_ID, includedData: CATALOG_INCLUDED_DATA },
            retries: 2,
            signal: AbortSignal.timeout(30_000),
            beforeRequest: () => { amazonCatalogGetCalls += 1; },
          },
        ) as Record<string, unknown>;
        const catalogJson = `${canonicalJson(catalog)}\n`;
        const catalogFile = `${prefix}-catalog.json`;
        await writeNew(resolve(temporary, catalogFile), catalogJson);
        entry.catalog = {
          status: "CAPTURED",
          file: catalogFile,
          sha256: sha256(catalogJson),
          byteLength: Buffer.byteLength(catalogJson),
        };
        const imageEntries = [];
        for (const image of originalCatalogImages(catalog)) {
          try {
            imageGetCalls += 1;
            const downloaded = await boundedImage(image.link as string);
            const extension = downloaded.mimeType === "image/png"
              ? "png"
              : downloaded.mimeType === "image/webp" ? "webp" : "jpg";
            const imageFile = `${prefix}-${String(image.variant)}.${extension}`;
            await writeNew(resolve(temporary, imageFile), downloaded.bytes);
            imageEntries.push({
              status: "CAPTURED",
              variant: image.variant,
              sourceUrl: image.link,
              finalUrl: downloaded.finalUrl,
              width: image.width ?? null,
              height: image.height ?? null,
              file: imageFile,
              sha256: sha256(downloaded.bytes),
              byteLength: downloaded.bytes.length,
              mimeType: downloaded.mimeType,
            });
          } catch (error) {
            imageEntries.push({
              status: "GET_FAILED",
              variant: image.variant,
              sourceUrl: image.link,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        entry.images = imageEntries;
      } catch (error) {
        entry.catalog = {
          status: "GET_FAILED",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        const listing = await spApiGet(
          `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sales.sku)}`,
          {
            storeId: "store1",
            params: {
              marketplaceIds: MARKETPLACE_ID,
              includedData: "summaries,attributes,issues,offers,fulfillmentAvailability,procurement",
            },
            retries: 1,
            signal: AbortSignal.timeout(30_000),
            beforeRequest: () => { amazonListingGetCalls += 1; },
          },
        ) as Record<string, unknown>;
        const listingJson = `${canonicalJson(listing)}\n`;
        const listingFile = `${prefix}-listing.json`;
        await writeNew(resolve(temporary, listingFile), listingJson);
        entry.listingContribution = {
          status: "CAPTURED",
          file: listingFile,
          sha256: sha256(listingJson),
          byteLength: Buffer.byteLength(listingJson),
        };
      } catch (error) {
        entry.listingContribution = {
          status: "GET_FAILED",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      entries.push(entry);
      console.log(JSON.stringify({ event: "FORENSICS_PROGRESS", captured: ordinal, target: sales.asin }));
      await sleep(500);
    }
    const capture = {
      schemaVersion: CAPTURE_SCHEMA,
      capturedAt: new Date().toISOString(),
      interpretationBoundary: {
        catalogAndListingState: "CURRENT_OBSERVATION_ONLY",
        historicalSales: "AMAZON_ALL_ORDERS_REPORT",
        currentCatalogMustNotBeClaimedAsHistoricalListingBytes: true,
      },
      source: {
        analysisPath,
        analysisSha256: expectedAnalysisSha,
        targetLimit: limit,
        marketplaceId: MARKETPLACE_ID,
      },
      counts: {
        targets: entries.length,
        catalogCaptured: entries.filter((entry) =>
          (entry.catalog as Record<string, unknown>)?.status === "CAPTURED").length,
        listingContributionCaptured: entries.filter((entry) =>
          (entry.listingContribution as Record<string, unknown>)?.status === "CAPTURED").length,
        imagesCaptured: entries.flatMap((entry) => entry.images as unknown[])
          .filter((image) => (image as Record<string, unknown>).status === "CAPTURED").length,
      },
      claims: {
        amazonCatalogGetCalls,
        amazonListingGetCalls,
        imageGetCalls,
        databaseWrites: 0,
        marketplaceMutations: 0,
      },
      entries,
    };
    const captureJson = `${JSON.stringify(capture, null, 2)}\n`;
    await Promise.all([
      writeNew(resolve(temporary, "forensics-capture.json"), captureJson),
      writeNew(resolve(temporary, "forensics-capture.sha256"), `${sha256(captureJson)}\n`),
    ]);
    await assertAbsent(outDir);
    await rename(temporary, outDir);
    console.log(JSON.stringify({
      status: "FORENSICS_CAPTURED",
      outDir,
      captureSha256: sha256(captureJson),
      ...capture.counts,
      ...capture.claims,
    }, null, 2));
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
