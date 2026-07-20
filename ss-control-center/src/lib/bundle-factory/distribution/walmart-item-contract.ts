/**
 * Fail-closed parser for the canonical Walmart public listing contract.
 *
 * ChannelSKU.attributes also carries Product Truth, prepublication evidence,
 * approval seals and Amazon fields. Only the typed `attributes.walmart`
 * subtree is allowed to cross the Walmart adapter boundary.
 */

import {
  WALMART_PUBLIC_CONTRACT_SCHEMA,
  parseWalmartListingAttributes,
  type WalmartPublicListingContract,
} from "../walmart-listing-contract";
import { WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION } from
  "../validation/walmart-prepublication-policy";

export class WalmartItemContractError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid Walmart public item contract: ${issues.join("; ")}`);
    this.name = "WalmartItemContractError";
    this.issues = issues;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function getConfiguredWalmartSpecVersion(): string {
  return (
    process.env.WALMART_MP_ITEM_SPEC_VERSION?.trim() ||
    WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION
  );
}

const RESERVED_PUBLIC_ATTRIBUTE_KEYS = new Set(
  [
    "sku",
    "productIdentifiers",
    "specProductType",
    "price",
    "ShippingWeight",
    "countryOfOriginSubstantialTransformation",
    "productPackageDimensionsDepth",
    "productPackageDimensionsHeight",
    "productPackageDimensionsWidth",
    "productPackageWeight",
    "productPackageDimensionsAndWeight",
    "inventory",
    "productName",
    "brand",
    "shortDescription",
    "keyFeatures",
    "mainImageUrl",
    "productSecondaryImageURL",
  ].map(normalizedKey),
);

const INTERNAL_ONLY_KEYS = new Set(
  [
    "product_truth_manifest",
    "walmart_prepublication",
    "distribution_approval",
    "approval",
    "provenance",
    "evidence",
    "read_contract",
    "content_donor",
    "price_evidence",
  ].map(normalizedKey),
);

function inspectPublicValue(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push(`${path} must be a finite JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      inspectPublicValue(entry, `${path}[${index}]`, issues),
    );
    return;
  }
  const object = record(value);
  if (!object) {
    issues.push(`${path} is not JSON-safe`);
    return;
  }
  for (const [key, entry] of Object.entries(object)) {
    const normalized = normalizedKey(key);
    if (!normalized) issues.push(`${path} contains an empty key`);
    if (key.startsWith("_") || INTERNAL_ONLY_KEYS.has(normalized)) {
      issues.push(`${path}.${key} is internal-only and cannot be sent to Walmart`);
    }
    inspectPublicValue(entry, `${path}.${key}`, issues);
  }
}

function normalizeHttpsUrl(
  value: unknown,
  path: string,
  issues: string[],
): string | null {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${path} must be a non-empty HTTPS URL`);
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) {
      issues.push(`${path} must be a public HTTPS URL without credentials`);
      return null;
    }
    return url.toString();
  } catch {
    issues.push(`${path} is not a valid URL`);
    return null;
  }
}

export function normalizeWalmartSecondaryImages(
  values: unknown,
  mainImageUrl?: string | null,
): string[] {
  const issues: string[] = [];
  if (!Array.isArray(values)) {
    throw new WalmartItemContractError([
      "walmart.secondary_image_urls must be an array",
    ]);
  }
  const normalizedMain = mainImageUrl
    ? normalizeHttpsUrl(mainImageUrl, "main_image_url", issues)
    : null;
  const seen = new Set<string>(normalizedMain ? [normalizedMain] : []);
  const images: string[] = [];
  values.forEach((value, index) => {
    const url = normalizeHttpsUrl(
      value,
      `walmart.secondary_image_urls[${index}]`,
      issues,
    );
    if (url && !seen.has(url)) {
      seen.add(url);
      images.push(url);
    }
  });
  if (images.length === 0) {
    issues.push(
      "walmart.secondary_image_urls needs at least one distinct image besides MAIN",
    );
  }
  if (issues.length > 0) throw new WalmartItemContractError(issues);
  return images;
}

/** The first pilot intentionally implements only the no-catalog-match branch.
 * This is a routing guard, not publishable content, so the evidence is read
 * only to block the wrong adapter and is never copied into the payload. */
export function assertWalmartFullItemSetupRoute(
  attributesJson: string | null | undefined,
): void {
  let root: Record<string, unknown>;
  try {
    root = parseWalmartListingAttributes(attributesJson || "{}");
  } catch (error) {
    throw new WalmartItemContractError([
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const prepublication = record(root.walmart_prepublication);
  if (!prepublication) return;
  const catalogSearch = record(prepublication.catalog_search);
  const itemSpec = record(prepublication.item_spec);
  const setupMethod = catalogSearch?.setup_method;
  const catalogResult = catalogSearch?.result;
  const feedType = itemSpec?.feed_type;
  if (
    setupMethod === "MATCH_EXISTING" ||
    catalogResult === "EXACT_MATCH" ||
    feedType === "MP_ITEM_MATCH"
  ) {
    throw new WalmartItemContractError([
      "Walmart catalog search selected MATCH_EXISTING/MP_ITEM_MATCH; this pilot " +
        "supports only NO_EXACT_MATCH -> FULL_ITEM -> MP_ITEM 5.0",
    ]);
  }
  if (
    (setupMethod != null && setupMethod !== "FULL_ITEM") ||
    (catalogResult != null && catalogResult !== "NO_EXACT_MATCH") ||
    (feedType != null && feedType !== "MP_ITEM")
  ) {
    throw new WalmartItemContractError([
      "Walmart prepublication setup route is unrecognized; expected " +
        "NO_EXACT_MATCH -> FULL_ITEM -> MP_ITEM",
    ]);
  }
}

/** Parse and validate the canonical type without spreading any sibling subtree
 * into the result. Live Get Spec remains the final attribute/enum validator. */
export function parseWalmartPublicItemContract(
  attributesJson: string | null | undefined,
  mainImageUrl?: string | null,
): WalmartPublicListingContract {
  const issues: string[] = [];
  let root: Record<string, unknown> = {};
  try {
    root = parseWalmartListingAttributes(attributesJson || "{}");
  } catch (error) {
    throw new WalmartItemContractError([
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const raw = record(root.walmart);
  if (!raw) {
    throw new WalmartItemContractError([
      "ChannelSKU.attributes.walmart is required",
    ]);
  }

  if (raw.contract_version !== WALMART_PUBLIC_CONTRACT_SCHEMA) {
    issues.push(
      `walmart.contract_version must be ${WALMART_PUBLIC_CONTRACT_SCHEMA}`,
    );
  }

  const specVersion =
    typeof raw.spec_version === "string" ? raw.spec_version.trim() : "";
  const currentVersion = getConfiguredWalmartSpecVersion();
  if (!/^5\.0\.\d{8}-\d{2}_\d{2}_\d{2}-api$/.test(specVersion)) {
    issues.push("walmart.spec_version must be an exact MP_ITEM 5.0.x API version");
  } else if (specVersion !== currentVersion) {
    issues.push(
      `walmart.spec_version ${specVersion} is not configured current version ${currentVersion}`,
    );
  }

  const schemaHash =
    typeof raw.spec_schema_hash === "string"
      ? raw.spec_schema_hash.trim().toLowerCase()
      : "";
  if (!/^[a-f0-9]{64}$/.test(schemaHash)) {
    issues.push("walmart.spec_schema_hash must be a SHA-256 hex digest");
  }
  const specFetchedAt =
    typeof raw.spec_fetched_at === "string" ? raw.spec_fetched_at.trim() : "";
  if (!specFetchedAt || !Number.isFinite(Date.parse(specFetchedAt))) {
    issues.push("walmart.spec_fetched_at must be an ISO timestamp");
  }

  const productType =
    typeof raw.product_type === "string" ? raw.product_type.trim() : "";
  if (!productType) issues.push("walmart.product_type is required");
  const countryOfOrigin =
    typeof raw.country_of_origin_substantial_transformation === "string"
      ? raw.country_of_origin_substantial_transformation.trim()
      : "";
  if (!countryOfOrigin) {
    issues.push(
      "walmart.country_of_origin_substantial_transformation is required",
    );
  }

  const publicAttributes = record(raw.public_attributes);
  if (!publicAttributes) {
    issues.push("walmart.public_attributes must be a JSON object");
  } else {
    for (const key of Object.keys(publicAttributes)) {
      if (RESERVED_PUBLIC_ATTRIBUTE_KEYS.has(normalizedKey(key))) {
        issues.push(
          `walmart.public_attributes.${key} is adapter-owned and cannot be overridden`,
        );
      }
    }
    inspectPublicValue(publicAttributes, "walmart.public_attributes", issues);
  }

  const handoff = record(raw.offer_handoff);
  if (handoff?.mode !== "INLINE" && handoff?.mode !== "STAGED_AFTER_ITEM_SETUP") {
    issues.push("walmart.offer_handoff.mode must be INLINE or STAGED_AFTER_ITEM_SETUP");
  }
  const quantity =
    typeof handoff?.quantity === "number" ? handoff.quantity : Number.NaN;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    issues.push("walmart.offer_handoff.quantity must be a positive integer");
  }
  const fulfillmentCenterId =
    typeof handoff?.fulfillment_center_id === "string"
      ? handoff.fulfillment_center_id.trim()
      : "";
  if (!fulfillmentCenterId) {
    issues.push("walmart.offer_handoff.fulfillment_center_id is required");
  }
  const fulfillmentLagTime =
    typeof handoff?.fulfillment_lag_time === "number"
      ? handoff.fulfillment_lag_time
      : Number.NaN;
  if (
    !Number.isInteger(fulfillmentLagTime) ||
    fulfillmentLagTime < 0 ||
    fulfillmentLagTime > 9
  ) {
    issues.push(
      "walmart.offer_handoff.fulfillment_lag_time must be an integer from 0 to 9",
    );
  }

  let secondaryImages: string[] = [];
  try {
    secondaryImages = normalizeWalmartSecondaryImages(
      raw.secondary_image_urls,
      mainImageUrl,
    );
  } catch (error) {
    if (error instanceof WalmartItemContractError) issues.push(...error.issues);
    else issues.push(String(error));
  }

  if (issues.length > 0) throw new WalmartItemContractError(issues);

  return {
    contract_version: WALMART_PUBLIC_CONTRACT_SCHEMA,
    spec_version: specVersion,
    spec_schema_hash: schemaHash,
    spec_fetched_at: new Date(specFetchedAt).toISOString(),
    product_type: productType,
    country_of_origin_substantial_transformation: countryOfOrigin,
    secondary_image_urls: secondaryImages,
    public_attributes: { ...publicAttributes! },
    offer_handoff: {
      mode: handoff!.mode as "INLINE" | "STAGED_AFTER_ITEM_SETUP",
      quantity,
      fulfillment_center_id: fulfillmentCenterId,
      fulfillment_lag_time: fulfillmentLagTime,
    },
  };
}
