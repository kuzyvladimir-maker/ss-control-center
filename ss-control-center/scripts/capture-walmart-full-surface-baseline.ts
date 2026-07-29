#!/usr/bin/env node

/**
 * One-shot, read-only semantic baseline for an exact Walmart listing group.
 *
 * POST is permitted only for Walmart's synchronous read APIs: Get Spec, Get
 * Item Associations, and Get Pricing Insights. There is no feed, price,
 * inventory, shipping-association, repricer, lag-time or lifecycle write path.
 * Every HTTP request is attempted once with redirects disabled.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION } from
  "../src/lib/bundle-factory/validation/walmart-prepublication-policy.ts";
import { computeWalmartSellerAccountFingerprint } from
  "../src/lib/walmart/item-report-capture-session.ts";

const SCHEMA = "walmart-listing-full-surface-baseline/v1" as const;
const ORIGIN = "https://marketplace.walmartapis.com";
const MAX_TOKEN_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

interface Args {
  store_index: number;
  skus: string[];
  output_dir: string;
}

interface CapturedExchange {
  sequence: number;
  semantic: string;
  method: "GET" | "POST";
  path: string;
  query: Record<string, string>;
  request_content_type: string | null;
  request_payload_sha256: string;
  request_byte_length: number;
  response_http_status: number;
  response_content_type: string | null;
  response_headers_sha256: string;
  response_payload_sha256: string;
  response_byte_length: number;
  response_file: string;
  correlation_id_sha256: string;
  attempted_once: true;
  retries: 0;
  redirects: 0;
}

function fail(message: string): never {
  throw new Error(`Walmart full-surface baseline rejected input: ${message}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("canonical JSON rejects undefined");
  return encoded;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSku(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)
    || value.includes("//")
    || value.endsWith("/")
  ) {
    fail(`invalid SKU: ${value}`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string[]>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match) fail(`unsupported argument: ${argument}`);
    const values = flags.get(match[1]!) ?? [];
    values.push(match[2]!);
    flags.set(match[1]!, values);
  }
  const allowed = new Set(["store-index", "sku", "output-dir"]);
  if ([...flags.keys()].some((key) => !allowed.has(key))) {
    fail("arguments must be --store-index, repeated --sku and --output-dir");
  }
  const storeRaw = flags.get("store-index");
  const outputRaw = flags.get("output-dir");
  const skuRaw = flags.get("sku");
  if (
    storeRaw?.length !== 1
    || outputRaw?.length !== 1
    || !skuRaw?.length
    || skuRaw.length > 20
  ) {
    fail("one store, 1-20 SKUs and one output directory are required");
  }
  const storeIndex = Number(storeRaw[0]);
  if (!Number.isSafeInteger(storeIndex) || storeIndex < 1 || storeIndex > 10) {
    fail("--store-index must be 1..10");
  }
  const skus = [...new Set(skuRaw.map(exactSku))].sort();
  if (skus.length !== skuRaw.length) fail("--sku values must be unique");
  const outputDir = path.resolve(outputRaw[0]!);
  return { store_index: storeIndex, skus, output_dir: outputDir };
}

function credentials(storeIndex: number) {
  const clientId = process.env[`WALMART_CLIENT_ID_STORE${storeIndex}`];
  const clientSecret =
    process.env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`];
  const sellerId = process.env[`WALMART_STORE${storeIndex}_SELLER_ID`];
  if (!clientId || !clientSecret || !sellerId) {
    fail(`Walmart store ${storeIndex} credentials are incomplete`);
  }
  return { client_id: clientId, client_secret: clientSecret, seller_id: sellerId };
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

async function boundedBytes(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximum)
  ) {
    fail("response Content-Length exceeds the bound");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximum) fail("response bytes exceed the bound");
  if (declared !== null && Number(declared) !== bytes.byteLength) {
    fail("response Content-Length differs from captured bytes");
  }
  return bytes;
}

function parsedObject(bytes: Uint8Array, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return fail(`${label} is not UTF-8 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label} is not an object`);
  }
  return parsed as JsonRecord;
}

function selectedHeaders(response: Response): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of [
    "content-encoding",
    "content-length",
    "content-type",
    "retry-after",
    "wm-qos-correlation-id",
    "wm_qos.correlation_id",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) selected[name] = value;
  }
  return selected;
}

async function writeExclusive(
  filePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args.output_dir);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credential = credentials(args.store_index);
  const sellerAccountFingerprint = computeWalmartSellerAccountFingerprint({
    store_index: args.store_index,
    client_id: credential.client_id,
    seller_id: credential.seller_id,
  });
  const authorization = Buffer.from(
    `${credential.client_id}:${credential.client_secret}`,
    "utf8",
  ).toString("base64");
  const oauthCorrelation = randomUUID();
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(`${ORIGIN}/v3/token`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        authorization: `Basic ${authorization}`,
        "content-type": "application/x-www-form-urlencoded",
        "wm_qos.correlation_id": oauthCorrelation,
        "wm_svc.name": "Walmart Marketplace",
      },
      body: "grant_type=client_credentials",
    });
  } catch {
    return fail("OAuth failed after one attempt; no retry was performed");
  }
  const tokenBytes = await boundedBytes(tokenResponse, MAX_TOKEN_BYTES);
  if (tokenResponse.status !== 200) {
    fail(`OAuth returned HTTP ${tokenResponse.status}`);
  }
  const token = parsedObject(tokenBytes, "OAuth response").access_token;
  if (
    typeof token !== "string"
    || !token
    || token.length > 8192
    || /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    fail("OAuth access_token is invalid");
  }
  const exchanges: Array<{
    receipt: CapturedExchange;
    bytes: Buffer;
  }> = [];
  const parsedResponses = new Map<string, JsonRecord>();

  const capture = async (input: {
    semantic: string;
    method: "GET" | "POST";
    pathname: string;
    query?: Record<string, string>;
    body?: unknown;
  }): Promise<JsonRecord> => {
    const query = input.query ?? {};
    const url = new URL(`${ORIGIN}${input.pathname}`);
    for (const key of Object.keys(query).sort()) {
      url.searchParams.set(key, query[key]!);
    }
    const requestBytes = input.body === undefined
      ? Buffer.alloc(0)
      : canonicalBytes(input.body);
    const correlationId = randomUUID();
    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-encoding": "identity",
      authorization: `Bearer ${token}`,
      "wm_sec.access_token": token,
      "wm_qos.correlation_id": correlationId,
      "wm_svc.name": "Walmart Marketplace",
      "wm_global_version": "3.1",
      "wm_market": "us",
    };
    if (requestBytes.byteLength) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers,
        body: requestBytes.byteLength ? requestBytes : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return fail(`${input.semantic} failed after one attempt; no retry was performed`);
    }
    const responseBytes = await boundedBytes(response, MAX_RESPONSE_BYTES);
    const responseHeaders = selectedHeaders(response);
    const sequence = exchanges.length + 1;
    const responseFile =
      `${String(sequence).padStart(2, "0")}-${input.semantic}.response.bin`;
    const receipt: CapturedExchange = {
      sequence,
      semantic: input.semantic,
      method: input.method,
      path: input.pathname,
      query,
      request_content_type:
        requestBytes.byteLength ? "application/json" : null,
      request_payload_sha256: sha256(requestBytes),
      request_byte_length: requestBytes.byteLength,
      response_http_status: response.status,
      response_content_type:
        response.headers.get("content-type")?.split(";")[0]?.trim() ?? null,
      response_headers_sha256: sha256(canonicalJson(responseHeaders)),
      response_payload_sha256: sha256(responseBytes),
      response_byte_length: responseBytes.byteLength,
      response_file: responseFile,
      correlation_id_sha256: sha256(correlationId),
      attempted_once: true,
      retries: 0,
      redirects: 0,
    };
    exchanges.push({ receipt, bytes: responseBytes });
    const parsed = responseBytes.byteLength
      ? parsedObject(responseBytes, `${input.semantic} response`)
      : {};
    parsedResponses.set(input.semantic, parsed);
    return parsed;
  };

  for (const sku of args.skus) {
    await capture({
      semantic: `item-${sku}`,
      method: "GET",
      pathname: `/v3/items/${encodeURIComponent(sku)}`,
    });
  }
  const itemRows = args.skus.map((sku) => {
    const response = parsedResponses.get(`item-${sku}`)!;
    if (
      !Array.isArray(response.ItemResponse)
      || response.ItemResponse.length !== 1
    ) {
      fail(`${sku} exact item response does not contain one row`);
    }
    const row = response.ItemResponse[0] as JsonRecord;
    if (
      row.sku !== sku
      || row.publishedStatus !== "PUBLISHED"
      || row.lifecycleStatus !== "ACTIVE"
    ) {
      fail(`${sku} is not the exact PUBLISHED/ACTIVE seller item`);
    }
    return row;
  });
  const productTypes = [...new Set(itemRows.map((row) => row.productType))];
  const variantGroupIds = [...new Set(itemRows.map((row) => row.variantGroupId))];
  if (
    productTypes.length !== 1
    || typeof productTypes[0] !== "string"
    || !productTypes[0]
    || variantGroupIds.length !== 1
    || typeof variantGroupIds[0] !== "string"
    || !variantGroupIds[0]
  ) {
    fail("exact items do not share one product type and variant group");
  }
  await capture({
    semantic: "variant-group",
    method: "GET",
    pathname: "/v3/items",
    query: {
      variantGroupId: variantGroupIds[0],
      limit: "200",
      offset: "0",
    },
  });
  await capture({
    semantic: "item-spec",
    method: "POST",
    pathname: "/v3/items/spec",
    body: {
      feedType: "MP_MAINTENANCE",
      version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
      productTypes,
    },
  });
  await capture({
    semantic: "item-associations",
    method: "POST",
    pathname: "/v3/items/associations",
    body: { items: args.skus.map((sku) => ({ sku })) },
  });
  for (const sku of args.skus) {
    await capture({
      semantic: `inventory-${sku}`,
      method: "GET",
      pathname: "/v3/inventory",
      query: { sku },
    });
  }
  for (const sku of args.skus) {
    await capture({
      semantic: `lagtime-${sku}`,
      method: "GET",
      pathname: "/v3/lagtime",
      query: { sku },
    });
  }
  await capture({
    semantic: "pricing-insights",
    method: "POST",
    pathname: "/v3/price/getPricingInsights",
    body: {
      pageNumber: 0,
      searchCriteria: {
        searchField: "SKU",
        searchValue: args.skus,
      },
    },
  });

  const capturedAt = new Date().toISOString();
  const body = {
    schema_version: SCHEMA,
    captured_at: capturedAt,
    store_index: args.store_index,
    exact_skus: args.skus,
    seller_account_fingerprint_sha256: sellerAccountFingerprint,
    product_type: productTypes[0],
    variant_group_id: variantGroupIds[0],
    recommended_mp_maintenance_spec_version:
      WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
    exchanges: exchanges.map(({ receipt }) => receipt),
    scope_receipt: Object.fromEntries(
      exchanges.map(({ receipt }) => [
        receipt.semantic,
        {
          method: receipt.method,
          path: receipt.path,
          http_status: receipt.response_http_status,
          response_payload_sha256: receipt.response_payload_sha256,
        },
      ]),
    ),
    effects: {
      oauth_token_calls: 1,
      read_semantic_get_calls: exchanges.filter(
        ({ receipt }) => receipt.method === "GET",
      ).length,
      read_semantic_post_calls: exchanges.filter(
        ({ receipt }) => receipt.method === "POST",
      ).length,
      walmart_mutation_calls: 0,
      retries: 0,
      redirects: 0,
      database_reads: 0,
      database_writes: 0,
      model_calls: 0,
    },
  };
  const manifest = {
    ...body,
    body_sha256: sha256(canonicalJson(body)),
  };
  await mkdir(path.dirname(args.output_dir), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(args.output_dir, { recursive: false, mode: 0o700 });
  for (const exchange of exchanges) {
    await writeExclusive(
      path.join(args.output_dir, exchange.receipt.response_file),
      exchange.bytes,
    );
  }
  await writeExclusive(
    path.join(args.output_dir, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
  await chmod(args.output_dir, 0o700);
  process.stdout.write(`${JSON.stringify({
    status: "READ_ONLY_BASELINE_CAPTURED",
    output_dir: args.output_dir,
    manifest_body_sha256: manifest.body_sha256,
    scope_statuses: Object.fromEntries(
      exchanges.map(({ receipt }) => [
        receipt.semantic,
        receipt.response_http_status,
      ]),
    ),
    effects: manifest.effects,
  }, null, 2)}\n`);
}

if (
  process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
