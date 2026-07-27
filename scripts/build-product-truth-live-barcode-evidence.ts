import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCT_TRUTH_LIVE_IMAGE_BARCODE_EVIDENCE_VERSION,
  normalizeProductTruthBridgeGtin,
  type ProductTruthLiveImageBarcodeEvidence,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import { renderProductTruthOperationalJson } from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  listingKey: string;
  componentIndex: number;
  inspectDir: string;
  observeDir: string;
  slot: string;
  contentUrl: string;
  capturedAt: string;
  outDir: string;
};

type JsonObject = Record<string, unknown>;
const MAX_TARGET_CONTENT_BYTES = 5 * 1024 * 1024;
const TARGET_FETCH_TIMEOUT_MS = 15_000;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/build-product-truth-live-barcode-evidence.ts",
    "    --listing-key walmart:STORE:SKU --component-index N",
    "    --inspect-dir ABS_DIR --observe-dir ABS_DIR --slot gallery-N",
    "    --content-url HTTPS_TARGET_PRODUCT_URL",
    "    --captured-at ISO --out ABS_NEW_DIR",
    "",
    "Safety: local read-only source verification plus a native barcode decode.",
    "Makes exactly one direct read-only Target GET; no paid/provider/model/database/Walmart write.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (![
      "--listing-key",
      "--component-index",
      "--inspect-dir",
      "--observe-dir",
      "--slot",
      "--content-url",
      "--captured-at",
      "--out",
    ].includes(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
    if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const componentIndex = Number(required("--component-index"));
  if (!Number.isInteger(componentIndex) || componentIndex < 0) {
    fail("COMPONENT_INDEX_INVALID", String(componentIndex));
  }
  const inspectDir = required("--inspect-dir");
  const observeDir = required("--observe-dir");
  const outDir = required("--out");
  if (![inspectDir, observeDir, outDir].every(isAbsolute)) {
    fail("ABSOLUTE_PATH_REQUIRED", "--inspect-dir, --observe-dir and --out must be absolute");
  }
  const capturedAt = new Date(required("--captured-at"));
  if (!Number.isFinite(capturedAt.valueOf())) fail("CAPTURED_AT_INVALID", String(capturedAt));
  const contentUrl = required("--content-url");
  let parsedContentUrl: URL;
  try {
    parsedContentUrl = new URL(contentUrl);
  } catch {
    fail("CONTENT_URL_INVALID", contentUrl);
  }
  if (
    parsedContentUrl.protocol !== "https:"
    || !/(^|\.)target\.com$/i.test(parsedContentUrl.hostname)
  ) fail("CONTENT_URL_INVALID", "only an exact HTTPS Target product URL is accepted");
  return {
    listingKey: required("--listing-key"),
    componentIndex,
    inspectDir,
    observeDir,
    slot: required("--slot"),
    contentUrl: parsedContentUrl.href,
    capturedAt: capturedAt.toISOString(),
    outDir,
  };
}

function findTargetProductItems(value: unknown): JsonObject[] {
  const matches: JsonObject[] = [];
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (!Array.isArray(candidate)) {
      const row = candidate as JsonObject;
      if (
        typeof row.primary_barcode === "string"
        && row.product_description
        && row.enrichment
      ) matches.push(row);
    }
    for (const nested of Object.values(candidate)) visit(nested);
  };
  visit(value);
  return matches;
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail("TARGET_CONTENT_INVALID", `${label} must be a text array`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SOURCE_INVALID", `${label} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("SOURCE_INVALID", `${label} must be non-empty text`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) fail("SOURCE_INVALID", `${label} must be an integer`);
  return parsed;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path: string): Promise<{ value: JsonObject; bytes: Buffer; sha256: string }> {
  const bytes = await readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("SOURCE_JSON_INVALID", path);
  }
  return { value: object(parsed, path), bytes, sha256: sha256(bytes) };
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TARGET_CONTENT_BYTES) {
    fail("TARGET_CONTENT_TOO_LARGE", `declared=${declaredLength}`);
  }
  if (!response.body) fail("TARGET_CONTENT_INVALID", "response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_TARGET_CONTENT_BYTES) {
      await reader.cancel();
      fail("TARGET_CONTENT_TOO_LARGE", `streamed>${MAX_TARGET_CONTENT_BYTES}`);
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function fileEntry(index: JsonObject, role: string): JsonObject {
  const files = Array.isArray(index.files) ? index.files : [];
  const matches = files.filter((value) => object(value, "intake file").role === role);
  if (matches.length !== 1) fail("INTAKE_FILE_BINDING_INVALID", role);
  return object(matches[0], role);
}

function specificationMap(buyer: JsonObject): Map<string, string> {
  const product = object(buyer.product, "buyer.product");
  const rows = Array.isArray(product.specifications) ? product.specifications : [];
  const result = new Map<string, string>();
  for (const raw of rows) {
    const row = object(raw, "buyer specification");
    const name = nullableString(row.name)?.toLowerCase();
    const value = nullableString(row.value);
    if (name && value && !result.has(name)) result.set(name, value);
  }
  return result;
}

function detectIdentityModifiers(text: string): string[] {
  const folded = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const allowed = [
    ["top sliced", /\btop sliced\b/],
    ["side sliced", /\bside sliced\b/],
  ] as const;
  return allowed.filter(([, pattern]) => pattern.test(folded)).map(([label]) => label);
}

const SWIFT_DECODER = String.raw`
import Foundation
import Vision
import ImageIO

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path) as CFURL
guard let source = CGImageSourceCreateWithURL(url, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  fputs("IMAGE_LOAD_FAILED\n", stderr)
  exit(2)
}
let request = VNDetectBarcodesRequest()
request.symbologies = [.ean13, .upce, .ean8]
let handler = VNImageRequestHandler(cgImage: image, options: [:])
try handler.perform([request])
let rows = (request.results ?? []).map {
  [
    "symbology": $0.symbology.rawValue,
    "payload": $0.payloadStringValue ?? "",
    "confidence": String(format: "%.9f", $0.confidence)
  ]
}
let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
`;

async function decodeBarcode(imagePath: string): Promise<{
  symbology: string;
  payload: string;
  confidence: number;
}> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const exitCode = await new Promise<number>((resolveCode, reject) => {
    const child = spawn("swift", ["-", imagePath], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveCode(code ?? 1));
    child.stdin.end(SWIFT_DECODER);
  });
  if (exitCode !== 0) {
    fail("BARCODE_DECODER_FAILED", Buffer.concat(stderr).toString("utf8").trim());
  }
  let rows: unknown;
  try {
    rows = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  } catch {
    fail("BARCODE_DECODER_OUTPUT_INVALID", "decoder did not return JSON");
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail("BARCODE_CARDINALITY_INVALID", `expected one barcode, received ${Array.isArray(rows) ? rows.length : 0}`);
  }
  const row = object(rows[0], "barcode");
  const payload = string(row.payload, "barcode.payload");
  const confidence = Number(row.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.98 || confidence > 1) {
    fail("BARCODE_CONFIDENCE_INSUFFICIENT", String(confidence));
  }
  return {
    symbology: string(row.symbology, "barcode.symbology"),
    payload,
    confidence,
  };
}

async function writeNewFile(path: string, bytes: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const intakePath = resolve(options.inspectDir, "intake-index.json");
  const buyerPath = resolve(options.inspectDir, "buyer-pdp.json");
  const observerPlanPath = resolve(options.observeDir, "observer-plan.json");
  const observationsPath = resolve(options.observeDir, "observations.json");
  const executionIndexPath = resolve(options.observeDir, "execution-index.json");
  const [intake, buyer, observerPlan, observations, execution] = await Promise.all([
    readJson(intakePath),
    readJson(buyerPath),
    readJson(observerPlanPath),
    readJson(observationsPath),
    readJson(executionIndexPath),
  ]);

  if (
    intake.value.listing_key !== options.listingKey
    || observerPlan.value.listing_key !== options.listingKey
    || execution.value.listing_key !== options.listingKey
  ) fail("LISTING_KEY_MISMATCH", options.listingKey);

  const buyerEntry = fileEntry(intake.value, "buyer_pdp_payload");
  if (buyerEntry.file_sha256 !== buyer.sha256) fail("BUYER_PDP_SHA256_MISMATCH", buyerPath);
  if (execution.value.observer_plan_file_sha256 !== observerPlan.sha256) {
    fail("OBSERVER_PLAN_SHA256_MISMATCH", observerPlanPath);
  }
  if (execution.value.observations_file_sha256 !== observations.sha256) {
    fail("OBSERVATIONS_SHA256_MISMATCH", observationsPath);
  }

  const assets = Array.isArray(observerPlan.value.assets) ? observerPlan.value.assets : [];
  const assetMatches = assets.filter((value) => object(value, "observer asset").slot === options.slot);
  if (assetMatches.length !== 1) fail("OBSERVER_ASSET_BINDING_INVALID", options.slot);
  const asset = object(assetMatches[0], "observer asset");
  const modelAsset = object(asset.model_asset, "observer model_asset");
  const modelAssetPath = resolve(options.observeDir, string(modelAsset.path, "model_asset.path"));
  const modelAssetBytes = await readFile(modelAssetPath);
  const modelAssetSha256 = sha256(modelAssetBytes);
  if (modelAssetSha256 !== modelAsset.sha256) fail("MODEL_ASSET_SHA256_MISMATCH", modelAssetPath);

  const imageId = string(asset.image_id, "asset.image_id");
  const observationRows = Array.isArray(observations.value.observations)
    ? observations.value.observations
    : [];
  const observationMatches = observationRows.filter(
    (value) => object(value, "observation").image_id === imageId,
  );
  if (observationMatches.length !== 1) fail("OBSERVATION_BINDING_INVALID", imageId);
  const observation = object(observationMatches[0], "observation");
  const packageCount = object(observation.external_package_count, "external_package_count");
  if (
    observation.multiple_distinct_products !== "no"
    || observation.readable_identity !== "clear"
    || observation.grid_cell_kind !== "single_sellable_package"
    || packageCount.mode !== "exact"
    || integer(packageCount.value, "external_package_count.value") !== 1
  ) fail("VISUAL_IDENTITY_EVIDENCE_INSUFFICIENT", imageId);

  const barcode = await decodeBarcode(modelAssetPath);
  const normalizedGtin14 = normalizeProductTruthBridgeGtin(barcode.payload);
  if (!normalizedGtin14) fail("BARCODE_GTIN_INVALID", barcode.payload);

  const contentResponse = await fetch(options.contentUrl, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(TARGET_FETCH_TIMEOUT_MS),
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (compatible; SS-Product-Truth/1.0)",
    },
  });
  const contentHtml = await readBoundedResponse(contentResponse);
  const contentType = contentResponse.headers.get("content-type") ?? "";
  if (
    contentResponse.status !== 200
    || !contentType.toLowerCase().includes("text/html")
    || !/(^|\.)target\.com$/i.test(new URL(contentResponse.url).hostname)
  ) fail(
    "TARGET_CONTENT_FETCH_INVALID",
    `status=${contentResponse.status} content-type=${contentType} url=${contentResponse.url}`,
  );
  const nextDataMatch = contentHtml.toString("utf8").match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!nextDataMatch) fail("TARGET_CONTENT_INVALID", "__NEXT_DATA__ missing");
  let nextData: unknown;
  try {
    nextData = JSON.parse(nextDataMatch[1]);
  } catch {
    fail("TARGET_CONTENT_INVALID", "__NEXT_DATA__ is not valid JSON");
  }
  const targetItems = findTargetProductItems(nextData).filter(
    (item) => normalizeProductTruthBridgeGtin(String(item.primary_barcode))
      === normalizedGtin14,
  );
  if (targetItems.length !== 1) {
    fail(
      "TARGET_CONTENT_GTIN_CARDINALITY_INVALID",
      `expected one exact item, received ${targetItems.length}`,
    );
  }
  const targetItem = targetItems[0];
  const targetDescription = object(targetItem.product_description, "target product_description");
  const targetEnrichment = object(targetItem.enrichment, "target enrichment");
  const targetNutrition = object(targetEnrichment.nutrition_facts, "target nutrition_facts");
  const softBullets = object(targetDescription.soft_bullets, "target soft_bullets");
  const targetTitle = string(targetDescription.title, "target title");
  const targetDescriptionText = string(
    targetDescription.downstream_description,
    "target description",
  );
  const targetBullets = textArray(softBullets.bullets, "target bullets");
  const targetAttributes = textArray(
    targetDescription.bullet_descriptions,
    "target attributes",
  );
  const targetIngredients = string(targetNutrition.ingredients, "target ingredients");
  const targetAllergens = string(targetNutrition.warning, "target allergens");
  const retailerProductId = options.contentUrl.match(/\/A-(\d+)(?:[/?#]|$)/)?.[1] ?? null;
  if (!retailerProductId) fail("TARGET_RETAILER_PRODUCT_ID_MISSING", options.contentUrl);

  const product = object(buyer.value.product, "buyer.product");
  const specs = specificationMap(buyer.value);
  const title = string(product.title, "buyer.product.title");
  const observedProductText = string(
    observation.visible_product_text,
    "observation.visible_product_text",
  );
  const modifiers = detectIdentityModifiers(`${title} ${observedProductText}`);
  if (!modifiers.length) fail("IDENTITY_MODIFIER_UNPROVEN", "top/side sliced marker missing");

  const evidence: ProductTruthLiveImageBarcodeEvidence = {
    schemaVersion: PRODUCT_TRUTH_LIVE_IMAGE_BARCODE_EVIDENCE_VERSION,
    listingKey: options.listingKey,
    componentIndex: options.componentIndex,
    capturedAt: options.capturedAt,
    sourceImageFile: "barcode-source.jpeg",
    image: {
      imageId,
      slot: options.slot,
      sourceAssetSha256: string(asset.source_asset_sha256, "asset.source_asset_sha256"),
      modelAssetSha256,
    },
    barcode: {
      decoder: "APPLE_VISION_VNDETECTBARCODESREQUEST",
      symbology: barcode.symbology,
      payload: barcode.payload,
      normalizedGtin14,
      confidence: barcode.confidence,
    },
    visualObservation: {
      brandText: string(observation.visible_brand_text, "observation.visible_brand_text"),
      productText: observedProductText,
      readableIdentity: "clear",
      multipleDistinctProducts: "no",
      gridCellKind: "single_sellable_package",
      externalPackageCount: 1,
      identityModifiers: modifiers,
    },
    buyerPdp: {
      title,
      brand: specs.get("brand") ?? null,
      productType: specs.get("bread & bun type") ?? null,
      productLine: specs.get("product line") ?? null,
      flavor: specs.get("flavor") ?? null,
      count: specs.has("count") ? integer(specs.get("count"), "buyer count") : null,
      multipackQuantity: specs.has("multipack quantity")
        ? integer(specs.get("multipack quantity"), "buyer multipack quantity")
        : null,
      containerType: specs.get("container type") ?? null,
      netContent: specs.get("product net content parent") ?? null,
      foodCondition: specs.get("food condition") ?? null,
    },
    retailerContent: {
      retailer: "target",
      retailerProductId,
      productUrl: options.contentUrl,
      finalUrl: contentResponse.url,
      httpStatus: 200,
      fetchedAt: options.capturedAt,
      htmlFile: "retailer-content.html",
      htmlSha256: sha256(contentHtml),
      normalizedGtin14,
      title: targetTitle,
      description: targetDescriptionText,
      bullets: targetBullets,
      attributes: targetAttributes,
      nutritionFacts: targetNutrition,
      ingredients: targetIngredients,
      allergens: targetAllergens,
    },
    sourceHashes: {
      intakeIndexFileSha256: intake.sha256,
      intakeIndexBodySha256: string(intake.value.body_sha256, "intake.body_sha256"),
      buyerPdpFileSha256: buyer.sha256,
      observerPlanFileSha256: observerPlan.sha256,
      observerPlanBodySha256: string(observerPlan.value.body_sha256, "observerPlan.body_sha256"),
      observationsFileSha256: observations.sha256,
      executionIndexFileSha256: execution.sha256,
      executionIndexBodySha256: string(execution.value.body_sha256, "execution.body_sha256"),
    },
    safety: {
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerReads: 1,
      databaseWrites: 0,
      walmartWrites: 0,
    },
  };

  const evidenceJson = renderProductTruthOperationalJson(evidence);
  const evidenceSha256 = sha256(evidenceJson);
  const index = {
    schemaVersion: "product-truth-live-image-barcode-artifact-index/1.0.0",
    createdAt: options.capturedAt,
    listingKey: options.listingKey,
    componentIndex: options.componentIndex,
    artifacts: [
      { role: "evidence", file: "evidence.json", sha256: evidenceSha256 },
      { role: "source_image", file: "barcode-source.jpeg", sha256: modelAssetSha256 },
      {
        role: "retailer_content_html",
        file: "retailer-content.html",
        sha256: evidence.retailerContent.htmlSha256,
      },
    ],
    safety: evidence.safety,
  };
  const indexJson = renderProductTruthOperationalJson(index);

  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNewFile(resolve(options.outDir, "evidence.json"), evidenceJson),
    writeNewFile(resolve(options.outDir, "evidence.sha256"), `${evidenceSha256}\n`),
    copyFile(modelAssetPath, resolve(options.outDir, evidence.sourceImageFile)),
    writeNewFile(resolve(options.outDir, evidence.retailerContent.htmlFile), contentHtml),
    writeNewFile(resolve(options.outDir, "artifact-index.json"), indexJson),
    writeNewFile(resolve(options.outDir, "artifact-index.sha256"), `${sha256(indexJson)}\n`),
  ]);
  await Promise.all([
    import("node:fs/promises").then(({ chmod }) =>
      chmod(resolve(options.outDir, evidence.sourceImageFile), 0o400)),
    import("node:fs/promises").then(({ chmod }) =>
      chmod(resolve(options.outDir, evidence.retailerContent.htmlFile), 0o400)),
  ]);
  process.stdout.write(indexJson);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await run(parseOptions(argv));
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
