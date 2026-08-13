import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";
import { veeqoFetch } from "../src/lib/veeqo/client";

const ANALYSIS_SCHEMA = "uncrustables-historical-sales-analysis/v1";
const CAPTURE_SCHEMA = "uncrustables-veeqo-historical-catalog-capture/v1";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

interface SalesIdentity {
  sku: string;
  asin: string | null;
  preferredTitle: string | null;
  units: number;
  grossRevenue: number;
  firstOrderAt: string;
  lastOrderAt: string;
}

interface SalesAnalysis {
  schemaVersion: string;
  salesByIdentity: SalesIdentity[];
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function objects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(objectValue).filter((row) => row !== null) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

async function cachedImage(url: string): Promise<{ bytes: Buffer; mimeType: string; finalUrl: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "thumbnails.veeqo.com") {
    fail(`Veeqo image host is not allowed: ${parsed.hostname}`);
  }
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "image/jpeg,image/png,image/webp" },
  });
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  const finalUrl = new URL(response.url);
  if (response.status !== 200
    || finalUrl.protocol !== "https:"
    || finalUrl.hostname !== "thumbnails.veeqo.com"
    || !["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    fail(`Veeqo image response is invalid: ${response.status} ${mimeType} ${finalUrl.hostname}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) fail("Veeqo image is too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) fail("Veeqo image byte length is invalid");
  return { bytes, mimeType, finalUrl: finalUrl.href };
}

function exactProduct(products: Array<Record<string, unknown>>, sku: string): {
  product: Record<string, unknown>;
  sellable: Record<string, unknown>;
} | null {
  for (const product of products) {
    for (const sellable of objects(product.sellables)) {
      if (sellable.sku_code === sku) return { product, sellable };
    }
  }
  return null;
}

function channelProjection(
  product: Record<string, unknown>,
  sku: string,
  asin: string | null,
): Array<Record<string, unknown>> {
  return objects(product.channel_products)
    .filter((channel) => {
      const sellables = objects(channel.channel_sellables);
      return channel.channel_type_code === "amazon"
        && (channel.remote_id === asin || sellables.some((row) => row.remote_sku === sku));
    })
    .map((channel) => ({
      id: channel.id ?? null,
      channelShortName: channel.channel_short_name ?? null,
      channelTypeCode: channel.channel_type_code ?? null,
      remoteId: channel.remote_id ?? null,
      remoteTitle: channel.remote_title ?? null,
      remoteDescription: channel.remote_description ?? null,
      status: channel.status ?? null,
      inactiveAfter: channel.inactive_after ?? null,
      channelSellables: objects(channel.channel_sellables)
        .filter((row) => row.remote_sku === sku)
        .map((row) => ({
          id: row.id ?? null,
          remoteSku: row.remote_sku ?? null,
          remoteTitle: row.remote_title ?? null,
          imageUrl: row.image_url ?? null,
          url: row.url ?? null,
          channelProductStatus: row.channel_product_status ?? null,
          failures: row.failures ?? null,
        })),
    }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Capture a PII-free Veeqo product/channel projection and cached main image for every historical Uncrustables identity.\n"
      + "Required: --analysis ABS --analysis-sha256 SHA --out-dir ABS_NEW",
    );
    return;
  }
  const allowed = new Set(["--analysis", "--analysis-sha256", "--out-dir"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const analysisPath = exactArg(args, "--analysis");
  const expectedAnalysisSha = exactArg(args, "--analysis-sha256").toLowerCase();
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
  const parent = dirname(outDir);
  if (await realpath(parent) !== parent) fail("output parent must be a real path");
  await assertAbsent(outDir);
  const temporary = join(parent, `.${basename(outDir)}.tmp-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  const entries = [];
  let veeqoProductGetCalls = 0;
  let imageGetCalls = 0;
  try {
    for (const [index, sales] of analysis.salesByIdentity.entries()) {
      const ordinal = index + 1;
      const entry: Record<string, unknown> = {
        ordinal,
        sales,
        observedAt: new Date().toISOString(),
        status: "NOT_FOUND",
        product: null,
        sellable: null,
        amazonChannels: [],
        cachedMainImage: null,
      };
      try {
        veeqoProductGetCalls += 1;
        const response = await veeqoFetch(`/products?query=${encodeURIComponent(sales.sku)}`);
        const products = objects(response);
        const exact = exactProduct(products, sales.sku);
        if (exact) {
          const { product, sellable } = exact;
          const imageUrl = text(sellable.image_url)
            ?? text(product.main_image_src)
            ?? text(product.image)
            ?? text(product.thumbnail_url);
          entry.status = "CAPTURED";
          entry.product = {
            id: product.id ?? null,
            title: product.title ?? null,
            description: product.description ?? null,
            createdAt: product.created_at ?? null,
            updatedAt: product.updated_at ?? null,
            deletedAt: product.deleted_at ?? null,
            mainImageSrc: product.main_image_src ?? null,
            image: product.image ?? null,
            thumbnailUrl: product.thumbnail_url ?? null,
          };
          entry.sellable = {
            id: sellable.id ?? null,
            skuCode: sellable.sku_code ?? null,
            fullTitle: sellable.full_title ?? null,
            productTitle: sellable.product_title ?? null,
            sellableTitle: sellable.sellable_title ?? null,
            createdAt: sellable.created_at ?? null,
            updatedAt: sellable.updated_at ?? null,
            deletedAt: sellable.deleted_at ?? null,
            imageUrl: sellable.image_url ?? null,
            mainThumbnailUrl: sellable.main_thumbnail_url ?? null,
          };
          entry.amazonChannels = channelProjection(product, sales.sku, sales.asin);
          if (imageUrl?.startsWith("https://thumbnails.veeqo.com/")) {
            try {
              imageGetCalls += 1;
              const image = await cachedImage(imageUrl);
              const extension = image.mimeType === "image/png"
                ? "png" : image.mimeType === "image/webp" ? "webp" : "jpg";
              const file = `${String(ordinal).padStart(4, "0")}-${sales.asin ?? "NOASIN"}-${sales.sku}.${extension}`;
              await writeNew(resolve(temporary, file), image.bytes);
              entry.cachedMainImage = {
                status: "CAPTURED",
                sourceUrl: imageUrl,
                finalUrl: image.finalUrl,
                file,
                sha256: sha256(image.bytes),
                byteLength: image.bytes.length,
                mimeType: image.mimeType,
              };
            } catch (error) {
              entry.cachedMainImage = {
                status: "GET_FAILED",
                sourceUrl: imageUrl,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
        }
      } catch (error) {
        entry.status = "GET_FAILED";
        entry.error = error instanceof Error ? error.message : String(error);
      }
      entries.push(entry);
      console.log(JSON.stringify({ event: "VEEQO_PROGRESS", captured: ordinal, sku: sales.sku, status: entry.status }));
      await sleep(250);
    }
    const capture = {
      schemaVersion: CAPTURE_SCHEMA,
      capturedAt: new Date().toISOString(),
      interpretationBoundary: {
        veeqoState: "CURRENT_VEEQO_RECORD_OBSERVATION",
        inactiveAfter: "VEEQO_CHANNEL_INACTIVATION_TIMESTAMP_NOT_AMAZON_REASON_CODE",
        descriptionAndImage: "VEEQO_RETAINED_RECORD_NOT_DATE_VERSIONED_BYTES",
      },
      source: { analysisPath, analysisSha256: expectedAnalysisSha },
      counts: {
        targets: entries.length,
        productsCaptured: entries.filter((entry) => entry.status === "CAPTURED").length,
        amazonChannelRecords: entries.flatMap((entry) => entry.amazonChannels as unknown[]).length,
        inactiveAmazonChannelRecords: entries.flatMap((entry) => entry.amazonChannels as Array<Record<string, unknown>>)
          .filter((channel) => channel.inactiveAfter !== null).length,
        cachedMainImagesCaptured: entries.filter((entry) =>
          (entry.cachedMainImage as Record<string, unknown> | null)?.status === "CAPTURED").length,
      },
      claims: { veeqoProductGetCalls, imageGetCalls, databaseWrites: 0, externalMutations: 0 },
      entries,
    };
    const json = `${JSON.stringify(capture, null, 2)}\n`;
    await writeNew(resolve(temporary, "veeqo-capture.json"), json);
    await writeNew(resolve(temporary, "veeqo-capture.sha256"), `${sha256(json)}\n`);
    await assertAbsent(outDir);
    await rename(temporary, outDir);
    console.log(JSON.stringify({
      status: "CAPTURED",
      outDir,
      captureSha256: sha256(json),
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
