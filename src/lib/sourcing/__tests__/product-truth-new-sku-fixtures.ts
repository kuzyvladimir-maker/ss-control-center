import { createHash } from "node:crypto";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const donorProductId = "donor-a";
const variantDecisionId = "decision-a";
const identityHash = hash("canonical-variant-a");
const canonicalVariantId = `cpv1:${identityHash}`;
const contentSourceUrl = "https://manufacturer.example/product-a";
const contentSourceApi = "fixture:manufacturer";
const contentObservedAt = "2026-07-19T10:00:00.000Z";
const contentRunId = "content-run-a";
const contentApprovalId = "content-approval-a";
const contentMeteredReceiptId = "content-receipt-a";
const decisionEvidenceJson = stableJson({
  exact: true,
  matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
  source: "fixture",
});

const content = {
  title: "Example Strawberry Snack 1 oz",
  ingredients: "Corn, sugar, strawberry powder.",
  nutritionFacts: { calories: 100 },
  allergens: [],
  attributes: { allergens: { contains: [], may_contain: [] } },
  mainImageUrl: "https://images.example/main.jpg",
  imageUrls: [
    "https://images.example/main.jpg",
    "https://images.example/nutrition.jpg",
  ],
  upc: "012345678905",
  category: "Snack Foods",
  storageTemp: "Shelf Stable",
};
const contentJson = stableJson(content);
const contentHash = hash(contentJson);
const fieldHashesJson = stableJson(
  Object.fromEntries(
    Object.entries(content).map(([field, value]) => [field, hash(stableJson(value))]),
  ),
);
const contentObservationKey = hash(
  stableJson({
    donorProductId,
    canonicalVariantId,
    variantDecisionId,
    sourceUrl: contentSourceUrl,
    sourceApi: contentSourceApi,
    contentHash,
    observedAt: contentObservedAt,
    runId: contentRunId,
    approvalId: contentApprovalId,
    meteredReceiptId: contentMeteredReceiptId,
  }),
);

export const validIdentityRow = {
  donorProductId,
  canonicalVariantId,
  variantDecisionId,
  matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
  matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  decisionEvidenceHash: hash(decisionEvidenceJson),
  decisionEvidenceJson,
  variantKey: canonicalVariantId,
  identityHash,
  keyVersion: "canonical-product-variant-key/1.0.0",
  normalizedBrand: "Example",
  normalizedProductLine: "Strawberry Snack",
  normalizedFlavor: "Strawberry",
  normalizedModifiersJson: "[]",
  normalizedForm: "pouch",
  sizeDimension: "MASS",
  sizeBaseAmount: 28.3495,
  sizeBaseUnit: "g",
  outerPackCount: 1,
  identityJson: stableJson({
    brand: "Example",
    productLine: "Strawberry Snack",
    flavor: "Strawberry",
    form: "pouch",
    size: "1 oz",
    outerPackCount: 1,
  }),
  contentObservationId: "content-a",
  contentObservationKey,
  contentSourceUrl,
  contentSourceApi,
  contentHash,
  fieldHashesJson,
  contentObservedAt,
  contentJson,
  contentRunId,
  contentApprovalId,
  contentMeteredReceiptId,
};

export function validIdentityRowWithContent(
  overrides: Record<string, unknown>,
): typeof validIdentityRow {
  const nextContent = { ...content, ...overrides };
  const nextContentJson = stableJson(nextContent);
  const nextContentHash = hash(nextContentJson);
  const nextFieldHashesJson = stableJson(
    Object.fromEntries(
      Object.entries(nextContent).map(([field, value]) => [field, hash(stableJson(value))]),
    ),
  );
  const nextContentObservationKey = hash(
    stableJson({
      donorProductId,
      canonicalVariantId,
      variantDecisionId,
      sourceUrl: contentSourceUrl,
      sourceApi: contentSourceApi,
      contentHash: nextContentHash,
      observedAt: contentObservedAt,
      runId: contentRunId,
      approvalId: contentApprovalId,
      meteredReceiptId: contentMeteredReceiptId,
    }),
  );
  return {
    ...validIdentityRow,
    contentJson: nextContentJson,
    contentHash: nextContentHash,
    fieldHashesJson: nextFieldHashesJson,
    contentObservationKey: nextContentObservationKey,
  };
}

const priceObservedAt = "2026-07-19T11:00:00.000Z";
const priceBase = {
  donorProductId,
  canonicalVariantId,
  variantDecisionId,
  retailer: "walmart",
  retailerProductId: "123456789",
  via: "direct",
  title: content.title,
  price: 4.99,
  packSizeSeen: 1,
  pricePerUnit: 4.99,
  currency: "USD",
  zip: "33765",
  localityEvidence: "zip_scoped",
  inStock: true,
  productUrl: "https://www.walmart.com/ip/123456789",
  sellerName: "Walmart.com",
  sourceApi: "fixture:walmart",
  observedAt: priceObservedAt,
  meteredReceiptId: "price-receipt-a",
};
const priceObservationKey = hash(stableJson(priceBase));

export const validPriceRow = {
  observationId: "price-a",
  observationKey: priceObservationKey,
  donorOfferId: "offer-a",
  ...priceBase,
  isFirstParty: true,
  runId: "price-run-a",
  approvalId: "price-approval-a",
};

export const newSkuCompilerOptions = {
  asOf: "2026-07-19T12:00:00.000Z",
  maxPriceAgeMs: 24 * 60 * 60 * 1_000,
  zip: "33765",
  requireIngredients: true,
  requireNutrition: true,
  requireAllergens: true,
} as const;
