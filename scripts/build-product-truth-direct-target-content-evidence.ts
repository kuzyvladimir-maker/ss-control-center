import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  normalizeProductTruthBridgeGtin,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  donorProductId: string;
  offerId: string;
  expectedGtin: string;
  contentUrl: string;
  capturedAt: string;
  outDir: string;
};

type JsonObject = Record<string, unknown>;

const PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION =
  "product-truth-direct-target-content-evidence/1.0.0" as const;

interface ProductTruthDirectTargetContentEvidence {
  schemaVersion: typeof PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION;
  donorProductId: string;
  offerId: string;
  capturedAt: string;
  retailerContent: {
    retailer: "target";
    retailerProductId: string;
    productUrl: string;
    finalUrl: string;
    httpStatus: 200;
    fetchedAt: string;
    htmlFile: string;
    htmlSha256: string;
    normalizedGtin14: string;
    title: string;
    description: string;
    bullets: string[];
    attributes: string[];
    nutritionFacts: Record<string, unknown>;
    ingredients: string;
    allergens: string;
    mainImageUrl: string;
    imageUrls: string[];
    category: string;
    classificationEvidence: {
      departmentName: string;
      productTypeName: string;
      itemTypeName: string;
      storageClass: "Shelf Stable";
      storageRuleVersion: "target-grocery-crackers-shelf-stable/1.0.0";
    };
  };
  safety: {
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerReads: 1;
    databaseWrites: 0;
    walmartWrites: 0;
  };
}

const MAX_TARGET_CONTENT_BYTES = 5 * 1024 * 1024;
const TARGET_FETCH_TIMEOUT_MS = 15_000;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/build-product-truth-direct-target-content-evidence.ts",
    "    --donor-product-id ID --offer-id ID --expected-gtin GTIN",
    "    --content-url HTTPS_TARGET_PRODUCT_URL --captured-at ISO --out ABS_NEW_DIR",
    "",
    "Safety: exactly one bounded first-party Target GET, zero paid/provider/model/database/",
    "marketplace calls. The resulting immutable evidence is donor/offer/GTIN/item-bound.",
  ].join("\n");
}

function targetRetailerProductId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)target\.com$/i.test(url.hostname)) return null;
    return url.pathname.match(/\/A-(\d+)(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  const flags = [
    "--donor-product-id",
    "--offer-id",
    "--expected-gtin",
    "--content-url",
    "--captured-at",
    "--out",
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.includes(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
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
  const outDir = required("--out");
  if (!isAbsolute(outDir)) fail("ABSOLUTE_PATH_REQUIRED", "--out must be absolute");
  const capturedAt = new Date(required("--captured-at"));
  if (!Number.isFinite(capturedAt.valueOf())) {
    fail("CAPTURED_AT_INVALID", required("--captured-at"));
  }
  const contentUrl = new URL(required("--content-url")).href;
  if (!targetRetailerProductId(contentUrl)) {
    fail("CONTENT_URL_INVALID", "exact HTTPS Target /A-{itemId} URL required");
  }
  const expectedGtin = normalizeProductTruthBridgeGtin(required("--expected-gtin"));
  if (!expectedGtin) fail("EXPECTED_GTIN_INVALID", required("--expected-gtin"));
  return {
    donorProductId: required("--donor-product-id"),
    offerId: required("--offer-id"),
    expectedGtin,
    contentUrl,
    capturedAt: capturedAt.toISOString(),
    outDir,
  };
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("TARGET_CONTENT_INVALID", `${label} must be an object`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("TARGET_CONTENT_INVALID", `${label} must be non-empty text`);
  }
  return value.trim();
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail("TARGET_CONTENT_INVALID", `${label} must be a text array`);
  }
  const result = value.map((item) => item.trim()).filter(Boolean);
  if (!result.length) fail("TARGET_CONTENT_INVALID", `${label} must not be empty`);
  return result;
}

function httpsImage(value: unknown, label: string): string {
  const raw = text(value, label);
  const url = new URL(raw);
  if (url.protocol !== "https:" || !/(^|\.)target\.scene7\.com$/i.test(url.hostname)) {
    fail("TARGET_CONTENT_INVALID", `${label} must be an HTTPS Target Scene7 URL`);
  }
  url.hash = "";
  return url.toString();
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function findTargetProductItems(value: unknown): JsonObject[] {
  const matches: JsonObject[] = [];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
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

async function writeNewFile(path: string, bytes: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const response = await fetch(options.contentUrl, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(TARGET_FETCH_TIMEOUT_MS),
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (compatible; SS-Product-Truth/1.0)",
    },
  });
  const html = await readBoundedResponse(response);
  const contentType = response.headers.get("content-type") ?? "";
  const expectedItemId = targetRetailerProductId(options.contentUrl);
  if (
    response.status !== 200
    || !contentType.toLowerCase().includes("text/html")
    || targetRetailerProductId(response.url) !== expectedItemId
  ) {
    fail(
      "TARGET_CONTENT_FETCH_INVALID",
      `status=${response.status} content-type=${contentType} url=${response.url}`,
    );
  }
  const nextDataMatch = html.toString("utf8").match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!nextDataMatch) fail("TARGET_CONTENT_INVALID", "__NEXT_DATA__ missing");
  let nextData: unknown;
  try {
    nextData = JSON.parse(nextDataMatch[1]);
  } catch {
    fail("TARGET_CONTENT_INVALID", "__NEXT_DATA__ is not valid JSON");
  }
  const exactItems = findTargetProductItems(nextData).filter(
    (item) =>
      normalizeProductTruthBridgeGtin(String(item.primary_barcode))
      === options.expectedGtin,
  );
  if (exactItems.length !== 1) {
    fail(
      "TARGET_CONTENT_GTIN_CARDINALITY_INVALID",
      `expected one exact GTIN item, received ${exactItems.length}`,
    );
  }
  const item = exactItems[0];
  const description = object(item.product_description, "product_description");
  const enrichment = object(item.enrichment, "enrichment");
  const nutrition = object(enrichment.nutrition_facts, "nutrition_facts");
  const softBullets = object(description.soft_bullets, "soft_bullets");
  const imageInfo = object(enrichment.image_info, "image_info");
  const primaryImage = object(imageInfo.primary_image, "primary_image");
  const alternateImages = Array.isArray(imageInfo.alternate_images)
    ? imageInfo.alternate_images.map((entry, index) =>
        httpsImage(object(entry, `alternate_images[${index}]`).url, `alternate_images[${index}].url`))
    : [];
  const mainImageUrl = httpsImage(primaryImage.url, "primary_image.url");
  const imageUrls = Array.from(new Set([mainImageUrl, ...alternateImages]));
  if (imageUrls.length < 2) {
    fail("TARGET_CONTENT_INVALID", "exact Target gallery must contain at least two images");
  }
  const merchandise = object(item.merchandise_classification, "merchandise_classification");
  const productClassification = object(item.product_classification, "product_classification");
  const itemType = object(productClassification.item_type, "product_classification.item_type");
  const departmentName = text(merchandise.department_name, "merchandise_classification.department_name");
  const productTypeName = text(productClassification.product_type_name, "product_classification.product_type_name");
  const itemTypeName = text(itemType.name, "product_classification.item_type.name");
  if (
    departmentName.toLocaleUpperCase("en-US") !== "SNACKS"
    || productTypeName.toLocaleUpperCase("en-US") !== "GROCERY"
    || itemTypeName.toLocaleLowerCase("en-US") !== "crackers"
  ) {
    fail(
      "TARGET_CONTENT_STORAGE_CLASSIFICATION_BLOCKED",
      `expected Target SNACKS/GROCERY/Crackers, received ${departmentName}/${productTypeName}/${itemTypeName}`,
    );
  }
  const evidence: ProductTruthDirectTargetContentEvidence = {
    schemaVersion: PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION,
    donorProductId: options.donorProductId,
    offerId: options.offerId,
    capturedAt: options.capturedAt,
    retailerContent: {
      retailer: "target",
      retailerProductId: expectedItemId!,
      productUrl: options.contentUrl,
      finalUrl: response.url,
      httpStatus: 200,
      fetchedAt: options.capturedAt,
      htmlFile: "retailer-content.html",
      htmlSha256: sha256(html),
      normalizedGtin14: options.expectedGtin,
      title: text(description.title, "title"),
      description: text(description.downstream_description, "description"),
      bullets: textArray(softBullets.bullets, "bullets"),
      attributes: textArray(description.bullet_descriptions, "attributes"),
      nutritionFacts: nutrition,
      ingredients: text(nutrition.ingredients, "ingredients"),
      allergens: text(nutrition.warning, "allergens"),
      mainImageUrl,
      imageUrls,
      category: itemTypeName,
      classificationEvidence: {
        departmentName,
        productTypeName,
        itemTypeName,
        storageClass: "Shelf Stable",
        storageRuleVersion: "target-grocery-crackers-shelf-stable/1.0.0",
      },
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
    schemaVersion: "product-truth-direct-target-content-artifact-index/1.0.0",
    createdAt: options.capturedAt,
    donorProductId: options.donorProductId,
    offerId: options.offerId,
    retailerProductId: expectedItemId,
    artifacts: [
      { role: "evidence", file: "evidence.json", sha256: evidenceSha256 },
      {
        role: "retailer_content_html",
        file: evidence.retailerContent.htmlFile,
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
    writeNewFile(resolve(options.outDir, evidence.retailerContent.htmlFile), html),
    writeNewFile(resolve(options.outDir, "artifact-index.json"), indexJson),
    writeNewFile(resolve(options.outDir, "artifact-index.sha256"), `${sha256(indexJson)}\n`),
  ]);
  await chmod(resolve(options.outDir, evidence.retailerContent.htmlFile), 0o400);
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
