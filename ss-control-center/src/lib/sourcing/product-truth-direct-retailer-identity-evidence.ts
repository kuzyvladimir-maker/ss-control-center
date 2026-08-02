import { createHash } from "node:crypto";

import {
  normalizeProductTruthBridgeGtin,
} from "./product-truth-legacy-bridge";
import {
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_DIRECT_RETAILER_IDENTITY_EVIDENCE_VERSION =
  "product-truth-direct-retailer-identity-evidence/1.0.0" as const;

export type ProductTruthDirectRetailerIdentityEvidenceRetailer =
  | "walmart"
  | "target";

export interface ProductTruthDirectRetailerPackageFormEvidence {
  normalizedForm: string;
  source:
    | "WALMART_IDML_CONTAINER_TYPE"
    | "WALMART_IDML_DIRECTIONS_EXACT_PACKAGE_USAGE"
    | "TARGET_PRODUCT_DESCRIPTION_CONTAINER_TYPE";
  sourcePath: string;
  rawValue: string;
}

export interface ProductTruthDirectRetailerIdentityEvidence {
  schemaVersion:
    typeof PRODUCT_TRUTH_DIRECT_RETAILER_IDENTITY_EVIDENCE_VERSION;
  targetCanonicalVariantId: string;
  donorProductId: string;
  offerId: string;
  capturedAt: string;
  retailerContent: {
    retailer: ProductTruthDirectRetailerIdentityEvidenceRetailer;
    retailerProductId: string;
    productUrl: string;
    finalUrl: string;
    httpStatus: 200;
    htmlFile: string;
    htmlSha256: string;
    title: string;
    normalizedGtin14: string;
    packageFormEvidence: ProductTruthDirectRetailerPackageFormEvidence | null;
  };
  safety: {
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerReads: 1;
    databaseWrites: 0;
    marketplaceMutations: 0;
  };
}

export class ProductTruthDirectRetailerIdentityEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthDirectRetailerIdentityEvidenceError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

const EXACT_PACKAGE_FORMS = new Set([
  "bag",
  "bottle",
  "box",
  "can",
  "carton",
  "jar",
  "packet",
  "pouch",
  "tub",
]);

function fail(code: string, message: string): never {
  throw new ProductTruthDirectRetailerIdentityEvidenceError(code, message);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("DIRECT_RETAILER_IDENTITY_HTML_INVALID", `${label} must be an object`);
  }
  return value as JsonObject;
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("DIRECT_RETAILER_IDENTITY_HTML_INVALID", `${label} must be text`);
  }
  return value.trim();
}

function canonicalInstant(value: string): string {
  const parsed = Date.parse(value);
  if (
    !value
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    fail("DIRECT_RETAILER_IDENTITY_INPUT_INVALID", "capturedAt must be canonical UTC");
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseNextData(html: string): JsonObject {
  const match = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/iu,
  );
  if (!match) {
    fail("DIRECT_RETAILER_IDENTITY_HTML_INVALID", "__NEXT_DATA__ is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    fail("DIRECT_RETAILER_IDENTITY_HTML_INVALID", "__NEXT_DATA__ is not JSON");
  }
  return object(parsed, "__NEXT_DATA__");
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (_, code: string) =>
      String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&quot;/giu, "\"")
    .replace(/&amp;/giu, "&")
    .replace(/&nbsp;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function exactPackageForm(value: string): string | null {
  const normalized = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
  return EXACT_PACKAGE_FORMS.has(normalized) ? normalized : null;
}

function retailerProductId(
  retailer: ProductTruthDirectRetailerIdentityEvidenceRetailer,
  value: string,
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (retailer === "walmart") {
    if (!/(^|\.)walmart\.com$/iu.test(url.hostname)) return null;
    return url.pathname.match(/\/ip\/(?:[^/]+\/)?(\d+)(?:\/|$)/u)?.[1]
      ?? null;
  }
  if (!/(^|\.)target\.com$/iu.test(url.hostname)) return null;
  return url.pathname.match(/\/A-(\d+)(?:\/|$)/u)?.[1] ?? null;
}

function packageFormFromRows(
  rows: unknown,
  source:
    | "WALMART_IDML_CONTAINER_TYPE"
    | "TARGET_PRODUCT_DESCRIPTION_CONTAINER_TYPE",
  sourcePath: string,
): ProductTruthDirectRetailerPackageFormEvidence | null {
  if (!Array.isArray(rows)) return null;
  const values = rows.flatMap((candidate): string[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const row = candidate as { name?: unknown; value?: unknown };
    if (
      typeof row.name !== "string"
      || row.name.trim().toLocaleLowerCase("en-US") !== "container type"
      || typeof row.value !== "string"
    ) return [];
    return [row.value.trim()];
  });
  const observed = values.map((rawValue) => ({
    rawValue,
    normalizedForm: exactPackageForm(rawValue),
  })).filter((row): row is { rawValue: string; normalizedForm: string } =>
    Boolean(row.normalizedForm));
  const forms = [...new Set(observed.map((row) => row.normalizedForm))];
  if (forms.length > 1) {
    fail("DIRECT_RETAILER_IDENTITY_FORM_CONTRADICTION", sourcePath);
  }
  if (!forms.length) return null;
  const normalizedForm = forms[0]!;
  const rawValue = observed
    .filter((row) => row.normalizedForm === normalizedForm)
    .map((row) => row.rawValue)
    .sort((left, right) => left.localeCompare(right, "en-US"))[0]!;
  return { source, sourcePath, rawValue, normalizedForm };
}

function packageFormFromWalmartDirections(
  rows: unknown,
): ProductTruthDirectRetailerPackageFormEvidence | null {
  if (!Array.isArray(rows)) return null;
  const instructions = rows.flatMap((candidate): string[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const row = candidate as { name?: unknown; value?: unknown };
    if (
      typeof row.name !== "string"
      || row.name.trim().toLocaleLowerCase("en-US") !== "instructions"
      || typeof row.value !== "string"
    ) return [];
    return [decodeHtmlText(row.value)];
  });
  const proofs = instructions.filter((value) =>
    /\b1\s*\/\s*2\s+box\b/iu.test(value)
    && /\bfull\s+box\b/iu.test(value));
  if (!proofs.length) return null;
  const contradiction = instructions.some((value) =>
    /\b(?:full|half|1\s*\/\s*2)\s+(?:bag|bottle|can|carton|jar|packet|pouch|tub)\b/iu
      .test(value));
  if (contradiction) {
    fail(
      "DIRECT_RETAILER_IDENTITY_FORM_CONTRADICTION",
      "Walmart instructions contain conflicting package forms",
    );
  }
  return {
    source: "WALMART_IDML_DIRECTIONS_EXACT_PACKAGE_USAGE",
    sourcePath: "props.pageProps.initialData.data.idml.directions",
    rawValue: proofs.sort((left, right) =>
      left.localeCompare(right, "en-US"))[0]!,
    normalizedForm: "box",
  };
}

function compileWalmartObservation(input: {
  html: string;
  expectedRetailerProductId: string;
}): Pick<
  ProductTruthDirectRetailerIdentityEvidence["retailerContent"],
  "title" | "normalizedGtin14" | "packageFormEvidence"
> {
  const nextData = parseNextData(input.html);
  const props = object(nextData.props, "props");
  const pageProps = object(props.pageProps, "props.pageProps");
  const initialData = object(pageProps.initialData, "initialData");
  const data = object(initialData.data, "initialData.data");
  const product = object(data.product, "initialData.data.product");
  if (String(product.usItemId) !== input.expectedRetailerProductId) {
    fail(
      "DIRECT_RETAILER_IDENTITY_ITEM_MISMATCH",
      `Walmart item ${String(product.usItemId)}`,
    );
  }
  const normalizedGtin14 = normalizeProductTruthBridgeGtin(String(product.upc));
  if (!normalizedGtin14) {
    fail("DIRECT_RETAILER_IDENTITY_GTIN_INVALID", String(product.upc));
  }
  const idml = object(data.idml, "initialData.data.idml");
  const explicitForm = packageFormFromRows(
    idml.specifications,
    "WALMART_IDML_CONTAINER_TYPE",
    "props.pageProps.initialData.data.idml.specifications",
  );
  const directionsForm = packageFormFromWalmartDirections(idml.directions);
  if (
    explicitForm
    && directionsForm
    && explicitForm.normalizedForm !== directionsForm.normalizedForm
  ) {
    fail(
      "DIRECT_RETAILER_IDENTITY_FORM_CONTRADICTION",
      "Walmart specifications and directions disagree",
    );
  }
  return {
    title: decodeHtmlText(nonEmptyText(product.name, "product.name")),
    normalizedGtin14,
    packageFormEvidence: explicitForm ?? directionsForm,
  };
}

function findTargetItems(value: unknown): JsonObject[] {
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

function compileTargetObservation(input: {
  html: string;
}): Pick<
  ProductTruthDirectRetailerIdentityEvidence["retailerContent"],
  "title" | "normalizedGtin14" | "packageFormEvidence"
> {
  const items = findTargetItems(parseNextData(input.html));
  if (items.length !== 1) {
    fail(
      "DIRECT_RETAILER_IDENTITY_ITEM_CARDINALITY_INVALID",
      `Target items=${items.length}`,
    );
  }
  const item = items[0]!;
  const normalizedGtin14 = normalizeProductTruthBridgeGtin(
    String(item.primary_barcode),
  );
  if (!normalizedGtin14) {
    fail("DIRECT_RETAILER_IDENTITY_GTIN_INVALID", String(item.primary_barcode));
  }
  const description = object(item.product_description, "product_description");
  const packageFormEvidence = packageFormFromRows(
    description.bullet_descriptions,
    "TARGET_PRODUCT_DESCRIPTION_CONTAINER_TYPE",
    "product_description.bullet_descriptions",
  );
  return {
    title: decodeHtmlText(nonEmptyText(description.title, "product_description.title")),
    normalizedGtin14,
    packageFormEvidence,
  };
}

export function compileProductTruthDirectRetailerIdentityEvidence(input: {
  targetCanonicalVariantId: string;
  donorProductId: string;
  offerId: string;
  retailer: ProductTruthDirectRetailerIdentityEvidenceRetailer;
  productUrl: string;
  finalUrl: string;
  httpStatus: number;
  capturedAt: string;
  htmlFile?: string;
  htmlBytes: Uint8Array;
}): ProductTruthDirectRetailerIdentityEvidence {
  const capturedAt = canonicalInstant(input.capturedAt);
  const expectedRetailerProductId = retailerProductId(
    input.retailer,
    input.productUrl,
  );
  const finalRetailerProductId = retailerProductId(
    input.retailer,
    input.finalUrl,
  );
  if (
    !input.targetCanonicalVariantId.startsWith("cpv1:")
    || !input.donorProductId
    || !input.offerId
    || !expectedRetailerProductId
    || finalRetailerProductId !== expectedRetailerProductId
    || input.httpStatus !== 200
  ) {
    fail(
      "DIRECT_RETAILER_IDENTITY_INPUT_INVALID",
      "target/donor/offer/URL/status binding is invalid",
    );
  }
  const htmlFile = input.htmlFile ?? "retailer-content.html";
  if (!htmlFile || htmlFile.includes("/") || htmlFile.includes("\\")) {
    fail("DIRECT_RETAILER_IDENTITY_INPUT_INVALID", "htmlFile must be a basename");
  }
  const html = Buffer.from(input.htmlBytes).toString("utf8");
  const observation = input.retailer === "walmart"
    ? compileWalmartObservation({
      html,
      expectedRetailerProductId,
    })
    : compileTargetObservation({ html });
  return {
    schemaVersion: PRODUCT_TRUTH_DIRECT_RETAILER_IDENTITY_EVIDENCE_VERSION,
    targetCanonicalVariantId: input.targetCanonicalVariantId,
    donorProductId: input.donorProductId,
    offerId: input.offerId,
    capturedAt,
    retailerContent: {
      retailer: input.retailer,
      retailerProductId: expectedRetailerProductId,
      productUrl: input.productUrl,
      finalUrl: input.finalUrl,
      httpStatus: 200,
      htmlFile,
      htmlSha256: sha256(input.htmlBytes),
      ...observation,
    },
    safety: {
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerReads: 1,
      databaseWrites: 0,
      marketplaceMutations: 0,
    },
  };
}

export function renderProductTruthDirectRetailerIdentityEvidence(
  value: ProductTruthDirectRetailerIdentityEvidence,
): string {
  return renderProductTruthOperationalJson(value);
}

export function productTruthDirectRetailerIdentityEvidenceSha256(
  value: ProductTruthDirectRetailerIdentityEvidence,
): string {
  return sha256(renderProductTruthDirectRetailerIdentityEvidence(value));
}
