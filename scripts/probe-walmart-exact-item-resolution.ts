#!/usr/bin/env node
/**
 * Read-only Walmart exact-item resolution probe.
 *
 * Dry validation is the default and performs no network or filesystem writes:
 *   node ... scripts/probe-walmart-exact-item-resolution.ts --sku=FaisalX-1130
 *
 * `--run` authorizes two logical Walmart GET operations through the shared
 * authenticated client and one new immutable local report. The client may
 * perform OAuth and bounded transport retries; the report states those bounds
 * explicitly instead of mislabeling logical operations as HTTP attempts. It
 * never calls a PDP, database, R2, paid service, or model.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXACT_ITEM_RESOLUTION_SCHEMA,
  extractExactSellerCatalogLookup,
  resolveExactWalmartItemCandidate,
  type ExactWalmartItemResolution,
} from "../src/lib/walmart/exact-item-resolution.ts";

export const EXACT_ITEM_PROBE_SCHEMA =
  "walmart-exact-item-resolution-probe/v2" as const;
export const EXACT_ITEM_PROBE_CANONICALIZATION =
  "recursive-key-sort-json/v1" as const;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXACT_ITEM_PROBE_OUTPUT_ROOT = path.join(
  ROOT,
  "data/audits/walmart-exact-item-resolution",
);

type JsonObject = Record<string, unknown>;

export interface ExactItemProbeArgs {
  sku: string;
  store_index: number;
  run: boolean;
}

export interface ExactItemProbeReportBody {
  schema_version: typeof EXACT_ITEM_PROBE_SCHEMA;
  probe_id: string;
  captured_at: string;
  input: {
    sku: string;
    store_index: number;
  };
  execution: {
    mode: "read_only_run";
    walmart_logical_get_operations: 2;
    walmart_http_get_attempts_max: 10;
    oauth_token_posts_max: 3;
    actual_transport_attempts_observed: false;
    buyer_pdp_gets: 0;
    database_reads: 0;
    database_writes: 0;
    walmart_writes: 0;
    r2_writes: 0;
    paid_api_calls: 0;
    model_calls: 0;
  };
  requests: [
    {
      sequence: 1;
      method: "GET";
      contract: "walmart_marketplace_exact_sku_get";
      path: string;
      status: number;
      final_correlation_id: string;
    },
    {
      sequence: 2;
      method: "GET";
      contract: "walmart_catalog_search_exact_upc";
      path: string;
      status: number;
      final_correlation_id: string;
    },
  ];
  source_payloads: {
    seller: {
      canonical_sha256: string;
      payload: unknown;
    };
    catalog_search: {
      canonical_sha256: string;
      payload: unknown;
    };
  };
  resolution: ExactWalmartItemResolution;
}

export interface ExactItemProbeReport extends ExactItemProbeReportBody {
  seal: {
    algorithm: "sha256";
    canonicalization: typeof EXACT_ITEM_PROBE_CANONICALIZATION;
    body_sha256: string;
  };
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateSku(value: string | null): string {
  if (!value || value !== value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("--sku must be explicit, non-empty, trimmed, and contain no control characters");
  }
  return value;
}

function parseStoreIndex(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("--store-index must be an integer from 1 to 10");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("--store-index must be an integer from 1 to 10");
  }
  return parsed;
}

export function parseExactItemProbeArgs(argv: string[]): ExactItemProbeArgs {
  let sku: string | null = null;
  let storeIndex = 1;
  let run = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--run") {
      if (run) throw new Error("--run may be supplied only once");
      run = true;
    } else if (arg === "--sku") {
      if (sku !== null || index + 1 >= argv.length) {
        throw new Error("--sku must be supplied exactly once with a value");
      }
      sku = argv[++index]!;
    } else if (arg.startsWith("--sku=")) {
      if (sku !== null) throw new Error("--sku must be supplied exactly once");
      sku = arg.slice("--sku=".length);
    } else if (arg === "--store-index") {
      if (index + 1 >= argv.length) throw new Error("--store-index requires a value");
      storeIndex = parseStoreIndex(argv[++index]!);
    } else if (arg.startsWith("--store-index=")) {
      storeIndex = parseStoreIndex(arg.slice("--store-index=".length));
    } else {
      throw new Error(`unsupported argument: ${arg}`);
    }
  }
  return { sku: validateSku(sku), store_index: storeIndex, run };
}

function safeSkuSlug(sku: string): string {
  return sku.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100) || "sku";
}

function safeStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

export function buildExactItemProbeReport(
  args: Pick<ExactItemProbeArgs, "sku" | "store_index">,
  resolution: ExactWalmartItemResolution,
  responses: {
    seller: { status: number; correlation_id: string; payload: unknown };
    catalog_search: { status: number; correlation_id: string; payload: unknown };
  },
  capturedAt = new Date(),
): ExactItemProbeReport {
  const sku = validateSku(args.sku);
  if (!Number.isInteger(args.store_index) || args.store_index < 1 || args.store_index > 10) {
    throw new Error("store_index must be an integer from 1 to 10");
  }
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    throw new Error("capturedAt must be a valid Date");
  }
  if (resolution.schema_version !== EXACT_ITEM_RESOLUTION_SCHEMA
    || resolution.sku !== sku
    || resolution.buyer_facing_verified !== false
    || !/^\d+$/.test(resolution.catalog_search_candidate.item_id)) {
    throw new Error(`${sku}: invalid exact-item resolution for probe report`);
  }
  for (const [label, response] of Object.entries(responses)) {
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw new Error(`${label} response must be a successful HTTP status`);
    }
    if (!/^[0-9a-f-]{16,64}$/i.test(response.correlation_id)) {
      throw new Error(`${label} final correlation ID is invalid`);
    }
  }
  const sellerPayloadSha = sha256(canonicalJson(responses.seller.payload));
  const catalogPayloadSha = sha256(canonicalJson(responses.catalog_search.payload));
  if (sellerPayloadSha !== resolution.source_hashes.seller_payload_canonical_sha256
    || catalogPayloadSha !== resolution.source_hashes.catalog_search_payload_canonical_sha256) {
    throw new Error(`${sku}: raw source payload hashes do not match the exact resolution`);
  }

  const capturedAtIso = capturedAt.toISOString();
  const body: ExactItemProbeReportBody = {
    schema_version: EXACT_ITEM_PROBE_SCHEMA,
    probe_id: `walmart-exact-item-${safeSkuSlug(sku)}-${safeStamp(capturedAtIso)}`,
    captured_at: capturedAtIso,
    input: { sku, store_index: args.store_index },
    execution: {
      mode: "read_only_run",
      walmart_logical_get_operations: 2,
      walmart_http_get_attempts_max: 10,
      oauth_token_posts_max: 3,
      actual_transport_attempts_observed: false,
      buyer_pdp_gets: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_writes: 0,
      r2_writes: 0,
      paid_api_calls: 0,
      model_calls: 0,
    },
    requests: [
      {
        sequence: 1,
        method: "GET",
        contract: "walmart_marketplace_exact_sku_get",
        path: `/v3/items/${encodeURIComponent(sku)}`,
        status: responses.seller.status,
        final_correlation_id: responses.seller.correlation_id,
      },
      {
        sequence: 2,
        method: "GET",
        contract: "walmart_catalog_search_exact_upc",
        path: `/v3/items/walmart/search?upc=${encodeURIComponent(resolution.seller.upc)}`,
        status: responses.catalog_search.status,
        final_correlation_id: responses.catalog_search.correlation_id,
      },
    ],
    source_payloads: {
      seller: {
        canonical_sha256: sellerPayloadSha,
        payload: responses.seller.payload,
      },
      catalog_search: {
        canonical_sha256: catalogPayloadSha,
        payload: responses.catalog_search.payload,
      },
    },
    resolution,
  };
  return {
    ...body,
    seal: {
      algorithm: "sha256",
      canonicalization: EXACT_ITEM_PROBE_CANONICALIZATION,
      body_sha256: sha256(canonicalJson(body)),
    },
  };
}

export function verifyExactItemProbeReport(report: ExactItemProbeReport): boolean {
  const { seal, ...body } = report;
  return seal.algorithm === "sha256"
    && seal.canonicalization === EXACT_ITEM_PROBE_CANONICALIZATION
    && /^[a-f0-9]{64}$/.test(seal.body_sha256)
    && sha256(canonicalJson(body)) === seal.body_sha256;
}

export async function writeNewExactItemProbeReport(
  report: ExactItemProbeReport,
  outputRoot = EXACT_ITEM_PROBE_OUTPUT_ROOT,
): Promise<string> {
  if (!verifyExactItemProbeReport(report)) {
    throw new Error("probe report canonical seal verification failed before write");
  }
  await mkdir(outputRoot, { recursive: true });
  const filename = `${safeSkuSlug(report.input.sku)}-${safeStamp(report.captured_at)}-${report.seal.body_sha256.slice(0, 16)}.json`;
  const output = path.resolve(outputRoot, filename);
  if (path.dirname(output) !== path.resolve(outputRoot)) {
    throw new Error("resolved report path escaped the fixed output root");
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return output;
}

export function buildExactItemProbeDryPlan(args: ExactItemProbeArgs) {
  return {
    schema_version: EXACT_ITEM_PROBE_SCHEMA,
    mode: "dry_validation",
    sku: args.sku,
    store_index: args.store_index,
    run_authorized: false,
    planned_walmart_logical_get_operations_if_run: 2,
    walmart_http_get_attempts_max_if_run: 10,
    oauth_token_posts_max_if_run: 3,
    planned_buyer_pdp_gets: 0,
    database_writes: 0,
    walmart_writes: 0,
    r2_writes: 0,
    paid_api_calls: 0,
    model_calls: 0,
    output_root_if_run: path.relative(ROOT, EXACT_ITEM_PROBE_OUTPUT_ROOT),
    note: "No network or filesystem write occurred. Pass --run to authorize two logical GET operations; the shared client may use bounded OAuth/retries.",
  } as const;
}

async function runProbe(args: ExactItemProbeArgs): Promise<string> {
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
  const { getWalmartClient } = await import("../src/lib/walmart/client.ts");
  const client = getWalmartClient(args.store_index);

  const sellerPath = `/items/${encodeURIComponent(args.sku)}`;
  const sellerResponse = await client.requestRaw("GET", sellerPath);
  if (!sellerResponse.ok) {
    throw new Error(`${args.sku}: exact seller GET failed with HTTP ${sellerResponse.status}`);
  }
  const lookup = extractExactSellerCatalogLookup(args.sku, sellerResponse.body);

  const catalogResponse = await client.requestRaw("GET", "/items/walmart/search", {
    params: { upc: lookup.upc },
  });
  if (!catalogResponse.ok) {
    throw new Error(`${args.sku}: catalog search GET failed with HTTP ${catalogResponse.status}`);
  }
  const resolution = resolveExactWalmartItemCandidate(
    args.sku,
    sellerResponse.body,
    catalogResponse.body,
  );
  if (resolution.seller.gtin14 !== lookup.gtin14) {
    throw new Error(`${args.sku}: resolver GTIN changed between exact extraction and resolution`);
  }

  const report = buildExactItemProbeReport(args, resolution, {
    seller: {
      status: sellerResponse.status,
      correlation_id: sellerResponse.correlationId,
      payload: sellerResponse.body,
    },
    catalog_search: {
      status: catalogResponse.status,
      correlation_id: catalogResponse.correlationId,
      payload: catalogResponse.body,
    },
  });
  return writeNewExactItemProbeReport(report);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseExactItemProbeArgs(argv);
  if (!args.run) {
    console.log(JSON.stringify(buildExactItemProbeDryPlan(args), null, 2));
    return;
  }
  const output = await runProbe(args);
  console.log(`sealed read-only report: ${path.relative(ROOT, output)}`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
