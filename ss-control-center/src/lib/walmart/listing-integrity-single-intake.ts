/**
 * Read-only intake boundary for one Walmart Listing Integrity SKU.
 *
 * Product Truth is checked before any Walmart/PDP/image work. A blocked source
 * therefore becomes SOURCE_REQUIRED without wasting network or vision calls.
 * The exact live chain is seller SKU -> normalized UPC/GTIN -> unique numeric
 * catalog itemId -> exact buyer PDP echo -> every buyer-facing image.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  rename,
} from "node:fs/promises";
import path from "node:path";

import {
  captureWalmartBuyerSnapshot,
  writeImmutableWalmartBuyerSnapshot,
  type ReadOnlyImageResponse,
  type WalmartBuyerSnapshotDraft,
} from "./buyer-facing-snapshot.ts";
import {
  extractExactSellerCatalogLookup,
  resolveExactWalmartItemCandidate,
  type ExactWalmartItemResolution,
} from "./exact-item-resolution.ts";
import {
  projectWalmartPublicBuyerPdpHtml,
  type WalmartPublicBuyerPdpPayload,
} from "./public-buyer-pdp.ts";
import {
  projectProductTruthForWalmartSingleListing,
  type WalmartListingSingleTruthProjection,
} from "./listing-integrity-single-pipeline.ts";
import type { ProductTruthSnapshot } from "../sourcing/product-truth-read-contract.ts";
import { walmartListingIntegritySha256 } from "./listing-integrity-audit.ts";

export const WALMART_LISTING_SINGLE_INTAKE_INDEX_SCHEMA =
  "walmart-listing-single-intake-index/v1" as const;

export interface WalmartListingSingleIntakeTarget {
  sku: string;
  store_index: number;
}

export interface WalmartListingSingleReadAdapters {
  readProductTruth(target: WalmartListingSingleIntakeTarget): Promise<ProductTruthSnapshot>;
  getExactSellerItem(sku: string): Promise<unknown>;
  getCatalogSearchByUpc(upc: string): Promise<unknown>;
  getBuyerPdpHtml(itemId: string): Promise<string>;
  getImage(url: string): Promise<ReadOnlyImageResponse>;
}

export type WalmartListingSingleIntakeResult =
  | {
      status: "SOURCE_REQUIRED";
      target: WalmartListingSingleIntakeTarget;
      product_truth: ProductTruthSnapshot;
      truth: Extract<WalmartListingSingleTruthProjection, { status: "SOURCE_REQUIRED" }>;
      execution: {
        product_truth_reads: 1;
        walmart_logical_gets: 0;
        buyer_pdp_gets: 0;
        image_gets: 0;
        model_calls: 0;
        database_writes: 0;
        walmart_writes: 0;
      };
    }
  | {
      status: "BUYER_CAPTURE_REQUIRED";
      target: WalmartListingSingleIntakeTarget & { item_id: string };
      product_truth: ProductTruthSnapshot;
      truth: WalmartListingSingleTruthProjection;
      exact_resolution: ExactWalmartItemResolution;
      seller_item_payload: unknown;
      catalog_search_payload: unknown;
      buyer_capture_request: {
        requested_url: string;
        failure_stage: "GET" | "STRICT_PROJECTION";
        failure_message: string;
        rejected_html: string | null;
      };
      execution: {
        product_truth_reads: 1;
        walmart_logical_gets: 2;
        buyer_pdp_gets: 0 | 1;
        image_gets: 0;
        model_calls: 0;
        database_writes: 0;
        walmart_writes: 0;
      };
    }
  | {
      status: "CAPTURED" | "CAPTURED_SOURCE_REQUIRED";
      target: WalmartListingSingleIntakeTarget & { item_id: string };
      product_truth: ProductTruthSnapshot;
      truth: WalmartListingSingleTruthProjection;
      exact_resolution: ExactWalmartItemResolution;
      seller_item_payload: unknown;
      catalog_search_payload: unknown;
      buyer_pdp_html: string;
      buyer_pdp_payload: WalmartPublicBuyerPdpPayload;
      buyer_snapshot: WalmartBuyerSnapshotDraft;
      execution: {
        product_truth_reads: 1;
        walmart_logical_gets: 2;
        buyer_pdp_gets: 0 | 1;
        image_gets: number;
        model_calls: 0;
        database_writes: 0;
        walmart_writes: 0;
      };
    };

export interface SealedWalmartListingSingleIntakeIndex {
  schema_version: typeof WALMART_LISTING_SINGLE_INTAKE_INDEX_SCHEMA;
  created_at: string;
  listing_key: string;
  status: WalmartListingSingleIntakeResult["status"];
  files: Array<{
    role: string;
    path: string;
    file_sha256: string;
    bytes: number;
  }>;
  buyer_snapshot_id: string | null;
  buyer_snapshot_body_sha256: string | null;
  execution: WalmartListingSingleIntakeResult["execution"];
  body_sha256: string;
}

function validateTarget(
  target: WalmartListingSingleIntakeTarget,
): WalmartListingSingleIntakeTarget {
  if (!target || typeof target !== "object"
    || typeof target.sku !== "string"
    || !target.sku
    || target.sku !== target.sku.trim()
    || target.sku.length > 200
    || /[\u0000-\u001f\u007f]/u.test(target.sku)) {
    throw new Error("target SKU must be explicit, trimmed, and contain no control characters");
  }
  if (!Number.isSafeInteger(target.store_index)
    || target.store_index < 1
    || target.store_index > 10) {
    throw new Error("target store_index must be an integer from 1 to 10");
  }
  return { ...target };
}

export async function captureWalmartListingSingleIntake(
  rawTarget: WalmartListingSingleIntakeTarget,
  adapters: WalmartListingSingleReadAdapters,
  capturedAt = new Date(),
  options: {
    /**
     * Continue the read-only marketplace capture when canonical truth is
     * missing. The resulting evidence may expose self-contradictions and feed
     * enrichment, but it can never become repair authority.
     */
    continue_when_source_required?: boolean;
    /**
     * Imported browser HTML is a local read, not a buyer-PDP network GET.
     * The strict item-ID projection is identical in both modes.
     */
    buyer_pdp_gets?: 0 | 1;
  } = {},
): Promise<WalmartListingSingleIntakeResult> {
  const target = validateTarget(rawTarget);
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    throw new Error("capturedAt must be a valid Date");
  }
  const productTruth = await adapters.readProductTruth(target);
  if (productTruth.snapshot.sku !== target.sku
    || productTruth.snapshot.storeIndex !== target.store_index
    || productTruth.snapshot.channel.toLowerCase() !== "walmart") {
    throw new Error("Product Truth point read does not match the exact Walmart target");
  }
  const truth = projectProductTruthForWalmartSingleListing(productTruth);
  if (truth.status === "SOURCE_REQUIRED" && !options.continue_when_source_required) {
    return {
      status: "SOURCE_REQUIRED",
      target,
      product_truth: productTruth,
      truth,
      execution: {
        product_truth_reads: 1,
        walmart_logical_gets: 0,
        buyer_pdp_gets: 0,
        image_gets: 0,
        model_calls: 0,
        database_writes: 0,
        walmart_writes: 0,
      },
    };
  }

  const sellerPayload = await adapters.getExactSellerItem(target.sku);
  const lookup = extractExactSellerCatalogLookup(target.sku, sellerPayload);
  const catalogPayload = await adapters.getCatalogSearchByUpc(lookup.upc);
  const resolution = resolveExactWalmartItemCandidate(
    target.sku,
    sellerPayload,
    catalogPayload,
  );
  if (resolution.seller.gtin14 !== lookup.gtin14) {
    throw new Error("exact Walmart resolution changed the normalized seller GTIN");
  }
  const itemId = resolution.catalog_search_candidate.item_id;
  const requestedUrl = `https://www.walmart.com/ip/${encodeURIComponent(itemId)}`;
  const buyerPdpGets = options.buyer_pdp_gets ?? 1;
  let buyerHtml: string;
  try {
    buyerHtml = await adapters.getBuyerPdpHtml(itemId);
  } catch (error) {
    return {
      status: "BUYER_CAPTURE_REQUIRED",
      target: { ...target, item_id: itemId },
      product_truth: productTruth,
      truth,
      exact_resolution: resolution,
      seller_item_payload: sellerPayload,
      catalog_search_payload: catalogPayload,
      buyer_capture_request: {
        requested_url: requestedUrl,
        failure_stage: "GET",
        failure_message: String(
          error instanceof Error ? error.message : error,
        ).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1_000),
        rejected_html: null,
      },
      execution: {
        product_truth_reads: 1,
        walmart_logical_gets: 2,
        buyer_pdp_gets: buyerPdpGets,
        image_gets: 0,
        model_calls: 0,
        database_writes: 0,
        walmart_writes: 0,
      },
    };
  }
  let buyerPdp: WalmartPublicBuyerPdpPayload;
  try {
    buyerPdp = projectWalmartPublicBuyerPdpHtml(buyerHtml, itemId);
  } catch (error) {
    return {
      status: "BUYER_CAPTURE_REQUIRED",
      target: { ...target, item_id: itemId },
      product_truth: productTruth,
      truth,
      exact_resolution: resolution,
      seller_item_payload: sellerPayload,
      catalog_search_payload: catalogPayload,
      buyer_capture_request: {
        requested_url: requestedUrl,
        failure_stage: "STRICT_PROJECTION",
        failure_message: String(
          error instanceof Error ? error.message : error,
        ).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1_000),
        rejected_html: buyerHtml,
      },
      execution: {
        product_truth_reads: 1,
        walmart_logical_gets: 2,
        buyer_pdp_gets: buyerPdpGets,
        image_gets: 0,
        model_calls: 0,
        database_writes: 0,
        walmart_writes: 0,
      },
    };
  }
  const buyerSnapshot = await captureWalmartBuyerSnapshot({
    sku: target.sku,
    item_id: itemId,
  }, {
    async getExactItemResolution() {
      return resolution;
    },
    async getBuyerPdpByItemId() {
      return buyerPdp;
    },
    getImage: adapters.getImage,
  }, capturedAt);

  return {
    status: truth.status === "READY" ? "CAPTURED" : "CAPTURED_SOURCE_REQUIRED",
    target: { ...target, item_id: itemId },
    product_truth: productTruth,
    truth,
    exact_resolution: resolution,
    seller_item_payload: sellerPayload,
    catalog_search_payload: catalogPayload,
    buyer_pdp_html: buyerHtml,
    buyer_pdp_payload: buyerPdp,
    buyer_snapshot: buyerSnapshot,
    execution: {
      product_truth_reads: 1,
      walmart_logical_gets: 2,
      buyer_pdp_gets: buyerPdpGets,
      image_gets: buyerSnapshot.assets.length,
      model_calls: 0,
      database_writes: 0,
      walmart_writes: 0,
    },
  };
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeExclusive(
  pathname: string,
  value: string | Uint8Array,
): Promise<{ file_sha256: string; bytes: number }> {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { file_sha256: sha256Bytes(bytes), bytes: bytes.length };
}

function outputDirectory(value: string): string {
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new Error("intake output directory must be an explicit path");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || path.basename(resolved).length < 3) {
    throw new Error("intake output directory is too broad");
  }
  return resolved;
}

/**
 * Atomically persist one read-only intake. This writes only local immutable
 * evidence and never opens a database, Walmart, PDP, image, or model client.
 */
export async function writeWalmartListingSingleIntake(
  rawOutputDirectory: string,
  result: WalmartListingSingleIntakeResult,
): Promise<{
  directory: string;
  index_path: string;
  index: SealedWalmartListingSingleIntakeIndex;
}> {
  const directory = outputDirectory(rawOutputDirectory);
  const parent = path.dirname(directory);
  const temporary = path.join(
    parent,
    `.${path.basename(directory)}.tmp-${process.pid}-${Date.now()}`,
  );
  await mkdir(parent, { recursive: true });
  await mkdir(temporary, { recursive: false, mode: 0o700 });
  const files: SealedWalmartListingSingleIntakeIndex["files"] = [];
  const addJson = async (role: string, filename: string, value: unknown) => {
    const encoded = `${JSON.stringify(value, null, 2)}\n`;
    const written = await writeExclusive(path.join(temporary, filename), encoded);
    files.push({ role, path: filename, ...written });
  };

  await addJson("product_truth", "product-truth.json", result.product_truth);
  await addJson("truth_projection", "truth-projection.json", result.truth);
  let buyerSnapshotId: string | null = null;
  let buyerSnapshotBodySha256: string | null = null;
  if (result.status !== "SOURCE_REQUIRED") {
    await addJson("exact_resolution", "exact-resolution.json", result.exact_resolution);
    await addJson("seller_item_payload", "seller-item.json", result.seller_item_payload);
    await addJson("catalog_search_payload", "catalog-search.json", result.catalog_search_payload);
  }
  if (result.status === "BUYER_CAPTURE_REQUIRED") {
    const { rejected_html: rejectedHtml, ...captureRequest } = result.buyer_capture_request;
    await addJson("buyer_capture_request", "buyer-capture-required.json", captureRequest);
    if (rejectedHtml !== null) {
      const rejected = await writeExclusive(
        path.join(temporary, "rejected-buyer-pdp.html"),
        rejectedHtml,
      );
      files.push({
        role: "rejected_buyer_pdp_html",
        path: "rejected-buyer-pdp.html",
        ...rejected,
      });
    }
  }
  if (result.status === "CAPTURED" || result.status === "CAPTURED_SOURCE_REQUIRED") {
    await addJson("buyer_pdp_payload", "buyer-pdp.json", result.buyer_pdp_payload);
    const html = await writeExclusive(
      path.join(temporary, "buyer-pdp.html"),
      result.buyer_pdp_html,
    );
    files.push({ role: "buyer_pdp_html", path: "buyer-pdp.html", ...html });
    const sealed = await writeImmutableWalmartBuyerSnapshot(
      path.join(temporary, "buyer-snapshots"),
      result.buyer_snapshot,
    );
    buyerSnapshotId = sealed.snapshot.snapshot_id;
    buyerSnapshotBodySha256 = sealed.snapshot.body_sha256;
    const snapshotPath = path.relative(temporary, sealed.manifest_path);
    const snapshotBytes = Buffer.from(JSON.stringify(sealed.snapshot, null, 2) + "\n", "utf8");
    files.push({
      role: "buyer_snapshot_manifest",
      path: snapshotPath,
      file_sha256: sha256Bytes(snapshotBytes),
      bytes: snapshotBytes.length,
    });
    for (const asset of sealed.snapshot.assets) {
      const bytes = result.buyer_snapshot.binary_assets.get(asset.sha256);
      if (!bytes) throw new Error(`${asset.slot}: intake binary disappeared before index seal`);
      files.push({
        role: `buyer_image_${asset.slot.toLowerCase()}`,
        path: path.join(
          path.dirname(snapshotPath),
          asset.local_path,
        ),
        file_sha256: asset.sha256,
        bytes: asset.bytes,
      });
    }
  }
  const indexBody = {
    schema_version: WALMART_LISTING_SINGLE_INTAKE_INDEX_SCHEMA,
    created_at: new Date().toISOString(),
    listing_key: result.product_truth.snapshot.listingKey,
    status: result.status,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    buyer_snapshot_id: buyerSnapshotId,
    buyer_snapshot_body_sha256: buyerSnapshotBodySha256,
    execution: result.execution,
  };
  const index: SealedWalmartListingSingleIntakeIndex = {
    ...indexBody,
    body_sha256: walmartListingIntegritySha256(indexBody),
  };
  await writeExclusive(
    path.join(temporary, "intake-index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  await rename(temporary, directory);
  return {
    directory,
    index_path: path.join(directory, "intake-index.json"),
    index,
  };
}
