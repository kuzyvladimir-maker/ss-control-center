import { createHash } from "node:crypto";

import type { Client } from "@libsql/client";

import { CANONICAL_PRODUCT_MATCHER_VERSION } from "./canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "./canonical-product-match-provenance";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
  evaluatePriceEvidenceEligibility,
} from "./price-evidence-policy";
import { assertProductTruthEvidenceSchema } from "./product-truth-schema-gate";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "./product-truth-read-contract-version";

export const DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_WALMART_PILOT_ZIP = "33765";

export interface ProductTruthNewSkuPriceEvidence {
  role: "PRICE";
  observation_id: string;
  observation_key: string;
  donor_offer_id: string;
  match_tier: "EXACT_IDENTITY";
  eligibility: "FACT";
  policy_version: typeof PRICE_EVIDENCE_POLICY_VERSION;
  policy_reason_codes: readonly string[];
  retailer: string;
  retailer_product_id: string;
  via: "direct";
  source_url: string;
  source_api: string;
  observed_at: string;
  locality_evidence: "zip_scoped";
  zip: string;
  first_party: true;
  in_stock: true;
  package_price: number;
  pack_size_seen: number;
  price_per_unit: number;
  currency: string;
  run_id: string | null;
  approval_id: string | null;
  metered_receipt_id: string | null;
}

export interface ProductTruthNewSkuCanonicalIdentity {
  variantKey: string;
  identityHash: string;
  keyVersion: "canonical-product-variant-key/1.0.0";
  brand: string;
  productLine: string | null;
  flavor: string | null;
  modifiers: unknown[];
  form: string | null;
  sizeDimension: "MASS" | "VOLUME" | "COUNT";
  sizeBaseAmount: number;
  sizeBaseUnit: "g" | "ml" | "count";
  outerPackCount: number;
  identity: Record<string, unknown>;
}

export interface ProductTruthNewSkuContentProvenance {
  observation_key: string;
  content_hash: string;
  field_hashes: Record<string, string>;
  source_api: string;
  decision_evidence_hash: string;
  decision_evidence: Record<string, unknown>;
  run_id: string | null;
  approval_id: string | null;
  metered_receipt_id: string | null;
}

export interface ProductTruthNewSkuRecipeComponentEvidence {
  component_key: string;
  donor_product_id: string;
  canonical_variant_id: string;
  variant_decision_id: string;
  canonical_identity: ProductTruthNewSkuCanonicalIdentity;
  product_name: string;
  manufacturer_brand: string;
  manufacturer_upc: string | null;
  flavor: string | null;
  qty: number;
  content_role: "EXACT";
  content_observation_id: string;
  content_source_url: string;
  content_captured_at: string;
  matcher_version: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
  matcher_implementation_sha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
  matcher_release_sha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  content_provenance: ProductTruthNewSkuContentProvenance;
  content_classification: {
    category: string | null;
    storage: string | null;
    category_field: string | null;
    storage_field: string | null;
  };
  facts: {
    ingredients: string | null;
    allergens: unknown;
    nutrition_facts: unknown;
    attributes: Record<string, unknown>;
  };
  price_evidence: ProductTruthNewSkuPriceEvidence;
}

export interface ProductTruthRecipeRequest {
  donorProductId: string;
  qty: number;
}

export interface ProductTruthRecipeReadOptions {
  asOf: string | Date;
  maxPriceAgeMs?: number;
  zip?: string;
  requireIngredients?: boolean;
  requireNutrition?: boolean;
  requireAllergens?: boolean;
}

export interface ProductTruthRecipeInput {
  contractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  as_of: string;
  price_max_age_ms: number;
  zip: string;
  components: ProductTruthNewSkuRecipeComponentEvidence[];
}

export interface WalmartPilotCandidate {
  donor_product_id: string;
  canonical_variant_id: string;
  title: string;
  brand: string;
  flavor: string | null;
  manufacturer_upc: string | null;
  category: string;
  storage_classification: "SHELF_STABLE";
  classification_evidence: {
    category_field: string;
    storage_field: string;
    content_observation_id: string;
    source_api: string;
  };
  content_observation_id: string;
  price_observation_id: string;
  observed_price: number;
  price_observed_at: string;
  content_observed_at: string;
  image_count: number;
  default_pack_counts: number[];
  score: number;
}

export interface ProductTruthWalmartPilotCandidateRead {
  contractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  candidate: WalmartPilotCandidate;
  newSkuView: ProductTruthRecipeInput;
}

export class ProductTruthRecipeInputError extends Error {
  readonly code = "PRODUCT_TRUTH_RECIPE_INPUT_BLOCKED";
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`Product Truth recipe input blocked: ${blockers.join("; ")}`);
    this.name = "ProductTruthRecipeInputError";
    this.blockers = blockers;
  }
}

type EvidenceRow = Record<string, unknown>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizeInstant(value: string | Date, label: string): string {
  const raw = value instanceof Date ? value.toISOString() : value;
  if (typeof raw !== "string" || !/(?:z|[+-]\d{2}:\d{2})$/i.test(raw.trim())) {
    throw new Error(`${label} must include a timezone`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO instant`);
  return new Date(parsed).toISOString();
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || (typeof value === "bigint" && Number(value) === 1)) {
    return true;
  }
  if (value === false || value === 0 || (typeof value === "bigint" && Number(value) === 0)) {
    return false;
  }
  return null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function contentDocumentEvidencePresent(
  value: unknown,
  allowExplicitEmptyArray = false,
  insideStructuredEvidence = false,
): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return insideStructuredEvidence && Number.isFinite(value);
  if (typeof value === "boolean") return insideStructuredEvidence;
  if (Array.isArray(value)) {
    return (allowExplicitEmptyArray && value.length === 0)
      || value.some((entry) => contentDocumentEvidencePresent(entry, false, true));
  }
  return value !== null
    && typeof value === "object"
    && Object.values(value as Record<string, unknown>)
      .some((entry) => contentDocumentEvidencePresent(entry, false, true));
}

function normalizedManufacturerIdentifier(value: unknown): string | null {
  const text = optionalText(value)?.replace(/\D/g, "") ?? "";
  return /^\d{12,14}$/.test(text) ? text : null;
}

function provenancePairValid(
  runId: string | null,
  approvalId: string | null,
  meteredReceiptId: string | null,
): boolean {
  if ((runId === null) !== (approvalId === null)) return false;
  return meteredReceiptId === null || (runId !== null && approvalId !== null);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function normalizeUrl(value: unknown): string | null {
  const text = optionalText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function firstNamedText(
  record: Record<string, unknown>,
  keys: readonly string[],
  prefix = "",
): { value: string | null; field: string | null } {
  for (const key of keys) {
    const value = optionalText(record[key]);
    if (value) return { value, field: `${prefix}${key}` };
  }
  return { value: null, field: null };
}

function contentFacts(row: EvidenceRow): {
  content: Record<string, unknown>;
  title: string | null;
  ingredients: string | null;
  nutrition: unknown;
  attributes: Record<string, unknown>;
  allergens: unknown;
  mainImage: string | null;
  images: string[];
  manufacturerUpc: string | null;
  classification: {
    category: string | null;
    storage: string | null;
    categoryField: string | null;
    storageField: string | null;
  };
} {
  const content = objectValue(parseJson(row.contentJson)) ?? {};
  const attributes = objectValue(content.attributes) ?? {};
  const rawImages = stringArray(content.imageUrls);
  const mainImage = normalizeUrl(content.mainImageUrl);
  const images = Array.from(new Set([mainImage, ...rawImages.map(normalizeUrl)]
    .filter((value): value is string => value !== null)));
  const allergens = [
    content.allergens,
    attributes.allergens,
    attributes.allergen_information,
    attributes.foodAllergenStatements,
  ].find((value) => contentDocumentEvidencePresent(value, true)) ?? null;
  const nutrition = contentDocumentEvidencePresent(content.nutritionFacts)
    ? content.nutritionFacts
    : null;
  const categoryTop = firstNamedText(content, ["category", "productCategory", "itemCategory"]);
  const categoryAttribute = firstNamedText(
    attributes,
    ["category", "productCategory", "itemCategory"],
    "attributes.",
  );
  const storageTop = firstNamedText(
    content,
    ["storageTemp", "storage_temp", "storageTemperature", "storage"],
  );
  const storageAttribute = firstNamedText(
    attributes,
    ["storageTemp", "storage_temp", "storageTemperature", "storage"],
    "attributes.",
  );
  return {
    content,
    title: optionalText(content.title),
    ingredients: optionalText(content.ingredients),
    nutrition,
    attributes,
    allergens,
    mainImage,
    images,
    manufacturerUpc: normalizedManufacturerIdentifier(
      content.upc ??
        content.gtin ??
        attributes.upc ??
        attributes.gtin ??
        attributes.manufacturerUpc,
    ),
    classification: {
      category: categoryTop.value ?? categoryAttribute.value,
      storage: storageTop.value ?? storageAttribute.value,
      categoryField: categoryTop.field ?? categoryAttribute.field,
      storageField: storageTop.field ?? storageAttribute.field,
    },
  };
}

async function readIdentityContent(
  db: Client,
  donorProductId: string,
  asOf: string,
  requirements: {
    requireIngredients: boolean;
    requireNutrition: boolean;
    requireAllergens: boolean;
  },
): Promise<EvidenceRow | null> {
  const result = await db.execute({
    sql: `SELECT
      decision.donorProductId,
      decision.id AS variantDecisionId,
      decision.canonicalVariantId,
      decision.matcherVersion,
      decision.matcherImplementationSha256,
      decision.matcherReleaseSha256,
      decision.evidenceHash AS decisionEvidenceHash,
      decision.evidenceJson AS decisionEvidenceJson,
      decision.decidedAt AS decisionDecidedAt,
      decision.createdAt AS decisionCreatedAt,
      variant.variantKey,
      variant.identityHash,
      variant.keyVersion,
      variant.normalizedBrand,
      variant.normalizedProductLine,
      variant.normalizedFlavor,
      variant.normalizedModifiersJson,
      variant.normalizedForm,
      variant.sizeDimension,
      variant.sizeBaseAmount,
      variant.sizeBaseUnit,
      variant.outerPackCount,
      variant.identityJson,
      variant.createdAt AS variantCreatedAt,
      content.id AS contentObservationId,
      content.observationKey AS contentObservationKey,
      content.sourceUrl AS contentSourceUrl,
      content.sourceApi AS contentSourceApi,
      content.contentHash,
      content.fieldHashesJson,
      content.observedAt AS contentObservedAt,
      content.contentJson,
      content.runId AS contentRunId,
      content.approvalId AS contentApprovalId,
      content.meteredReceiptId AS contentMeteredReceiptId,
      content.createdAt AS contentCreatedAt
    FROM DonorProductVariantDecision decision
    JOIN CanonicalProductVariant variant
      ON variant.id=decision.canonicalVariantId
    JOIN ProductContentObservation content
      ON content.donorProductId=decision.donorProductId
     AND content.variantDecisionId=decision.id
     AND content.canonicalVariantId=variant.id
    WHERE decision.donorProductId=?
      AND decision.decisionStatus='exact_confirmed'
      AND decision.matcherVersion=?
      AND decision.matcherImplementationSha256=?
      AND decision.matcherReleaseSha256=?
      AND julianday(decision.decidedAt)<=julianday(?)
      AND julianday(decision.createdAt)<=julianday(?)
      AND julianday(variant.createdAt)<=julianday(?)
      AND variant.outerPackCount=1
      AND julianday(content.observedAt)<=julianday(?)
      AND julianday(content.createdAt)<=julianday(?)
    ORDER BY julianday(content.observedAt) DESC, content.observedAt DESC,
      julianday(content.createdAt) DESC, content.createdAt DESC, content.id DESC`,
    args: [
      donorProductId,
      CANONICAL_PRODUCT_MATCHER_VERSION,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      asOf,
      asOf,
      asOf,
      asOf,
      asOf,
    ],
  });
  // Search observations remain useful immutable evidence, but a later partial
  // search capture must not hide an earlier complete exact content snapshot.
  // Select the newest row that can satisfy this read; hashes/provenance are still
  // verified fail-closed by buildProductTruthRecipeComponentFromRows below.
  return result.rows.find((row) => {
    const facts = contentFacts(row);
    return !!facts.title
      && !!facts.mainImage
      && !!facts.manufacturerUpc
      && (!requirements.requireIngredients || !!facts.ingredients)
      && (!requirements.requireNutrition || facts.nutrition != null)
      && (!requirements.requireAllergens || facts.allergens != null);
  }) ?? null;
}

async function readExactLocalPrices(
  db: Client,
  input: {
    donorProductId: string;
    canonicalVariantId: string;
    variantDecisionId: string;
    asOf: string;
    cutoff: string;
    zip: string;
  },
): Promise<EvidenceRow[]> {
  const result = await db.execute({
    sql: `SELECT
      observation.id AS observationId,
      observation.observationKey,
      observation.donorOfferId,
      observation.donorProductId,
      observation.canonicalVariantId,
      observation.variantDecisionId,
      observation.retailer,
      observation.retailerProductId,
      observation.via,
      observation.title,
      observation.productUrl,
      observation.sellerName,
      observation.sourceApi,
      observation.observedAt,
      observation.localityEvidence,
      observation.zip,
      observation.price,
      observation.packSizeSeen,
      observation.pricePerUnit,
      observation.currency,
      observation.inStock,
      observation.isFirstParty,
      observation.runId,
      observation.approvalId,
      observation.meteredReceiptId,
      observation.createdAt
    FROM DonorOfferObservation observation
    WHERE observation.donorProductId=?
      AND observation.canonicalVariantId=?
      AND observation.variantDecisionId=?
      AND observation.id=(
        SELECT latest.id FROM DonorOfferObservation latest
        WHERE latest.donorOfferId=observation.donorOfferId
          AND latest.canonicalVariantId=observation.canonicalVariantId
          AND julianday(latest.observedAt)<=julianday(?)
          AND julianday(latest.createdAt)<=julianday(?)
        ORDER BY julianday(latest.observedAt) DESC, latest.observedAt DESC,
          julianday(latest.createdAt) DESC, latest.createdAt DESC, latest.id DESC
        LIMIT 1
      )
      AND observation.isFirstParty=1
      AND observation.inStock=1
      AND observation.price>0
      AND observation.packSizeSeen=1
      AND observation.productUrl IS NOT NULL
      AND julianday(observation.observedAt)<=julianday(?)
      AND julianday(observation.observedAt)>=julianday(?)
      AND julianday(observation.createdAt)<=julianday(?)
      AND observation.localityEvidence='zip_scoped'
      AND observation.zip=?
    ORDER BY observation.pricePerUnit ASC, julianday(observation.observedAt) DESC,
      observation.observedAt DESC, observation.id ASC`,
    args: [
      input.donorProductId,
      input.canonicalVariantId,
      input.variantDecisionId,
      input.asOf,
      input.asOf,
      input.asOf,
      input.cutoff,
      input.asOf,
      input.zip,
    ],
  });
  return [...result.rows];
}

function canonicalIdentityFromRow(
  row: EvidenceRow,
  blockers: string[],
): ProductTruthNewSkuCanonicalIdentity | null {
  const variantKey = optionalText(row.variantKey);
  const identityHash = optionalText(row.identityHash);
  const keyVersion = optionalText(row.keyVersion);
  const brand = optionalText(row.normalizedBrand);
  const modifiers = parseJson(row.normalizedModifiersJson);
  const identity = objectValue(parseJson(row.identityJson));
  const sizeDimension = row.sizeDimension;
  const sizeBaseAmount = positiveNumber(row.sizeBaseAmount);
  const sizeBaseUnit = row.sizeBaseUnit;
  const outerPackCount = positiveInteger(row.outerPackCount);
  if (
    !variantKey ||
    !identityHash ||
    variantKey !== row.canonicalVariantId ||
    variantKey !== `cpv1:${identityHash}` ||
    !isSha256(identityHash) ||
    keyVersion !== "canonical-product-variant-key/1.0.0" ||
    !brand ||
    !Array.isArray(modifiers) ||
    !identity ||
    (sizeDimension !== "MASS" &&
      sizeDimension !== "VOLUME" &&
      sizeDimension !== "COUNT") ||
    (sizeBaseUnit !== "g" && sizeBaseUnit !== "ml" && sizeBaseUnit !== "count") ||
    (sizeDimension === "MASS" && sizeBaseUnit !== "g") ||
    (sizeDimension === "VOLUME" && sizeBaseUnit !== "ml") ||
    (sizeDimension === "COUNT" && sizeBaseUnit !== "count") ||
    !sizeBaseAmount ||
    outerPackCount !== 1
  ) {
    blockers.push("CANONICAL_IDENTITY_INVALID");
    return null;
  }
  return {
    variantKey,
    identityHash,
    keyVersion,
    brand,
    productLine: optionalText(row.normalizedProductLine),
    flavor: optionalText(row.normalizedFlavor),
    modifiers,
    form: optionalText(row.normalizedForm),
    sizeDimension,
    sizeBaseAmount,
    sizeBaseUnit,
    outerPackCount,
    identity,
  };
}

function contentProvenanceFromRow(
  row: EvidenceRow,
  blockers: string[],
): ProductTruthNewSkuContentProvenance | null {
  const initialBlockerCount = blockers.length;
  const decisionEvidenceRaw = optionalText(row.decisionEvidenceJson);
  const decisionEvidence = objectValue(parseJson(decisionEvidenceRaw));
  const decisionEvidenceHash = optionalText(row.decisionEvidenceHash);
  if (
    !decisionEvidenceRaw ||
    !decisionEvidence ||
    !isSha256(decisionEvidenceHash) ||
    decisionEvidenceHash !== sha256Text(decisionEvidenceRaw)
  ) {
    blockers.push("DECISION_EVIDENCE_HASH_MISMATCH");
  } else if (
    decisionEvidence.matcherVersion !== row.matcherVersion
    || decisionEvidence.matcherImplementationSha256 !== row.matcherImplementationSha256
    || decisionEvidence.matcherReleaseSha256 !== row.matcherReleaseSha256
  ) {
    blockers.push("DECISION_MATCHER_PROVENANCE_MISMATCH");
  }

  const contentRaw = optionalText(row.contentJson);
  const content = objectValue(parseJson(contentRaw));
  const contentHash = optionalText(row.contentHash);
  if (!contentRaw || !content || !isSha256(contentHash) || contentHash !== sha256Text(contentRaw)) {
    blockers.push("CONTENT_HASH_MISMATCH");
  }

  const fieldHashes = objectValue(parseJson(row.fieldHashesJson));
  const expectedFields = content
    ? Object.entries(content).filter(([field]) => !field.startsWith("_"))
    : [];
  const fieldHashesValid =
    fieldHashes !== null &&
    expectedFields.length > 0 &&
    Object.keys(fieldHashes).length === expectedFields.length &&
    expectedFields.every(
      ([field, value]) =>
        isSha256(fieldHashes[field]) &&
        fieldHashes[field] === sha256Text(stableJson(value)),
    );
  if (!fieldHashesValid) blockers.push("CONTENT_FIELD_HASHES_INVALID");

  const sourceUrl = optionalText(row.contentSourceUrl);
  const sourceApi = optionalText(row.contentSourceApi);
  const observedAt = optionalText(row.contentObservedAt);
  if (!sourceApi) blockers.push("CONTENT_SOURCE_API_MISSING");
  if (!normalizeUrl(sourceUrl)) blockers.push("CONTENT_SOURCE_URL_INVALID");
  if (!observedAt) {
    blockers.push("CONTENT_OBSERVED_AT_MISSING");
  } else {
    try {
      normalizeInstant(observedAt, "content observedAt");
    } catch {
      blockers.push("CONTENT_OBSERVED_AT_INVALID");
    }
  }

  const runId = optionalText(row.contentRunId);
  const approvalId = optionalText(row.contentApprovalId);
  const meteredReceiptId = optionalText(row.contentMeteredReceiptId);
  if (!provenancePairValid(runId, approvalId, meteredReceiptId)) {
    blockers.push("CONTENT_RUN_PROVENANCE_INVALID");
  }

  const observationKey = optionalText(row.contentObservationKey);
  const expectedObservationKey =
    contentHash && sourceUrl && sourceApi && observedAt
      ? sha256Text(
          stableJson({
            donorProductId: optionalText(row.donorProductId),
            canonicalVariantId: optionalText(row.canonicalVariantId),
            variantDecisionId: optionalText(row.variantDecisionId),
            sourceUrl,
            sourceApi,
            contentHash,
            observedAt,
            runId,
            approvalId,
            meteredReceiptId,
          }),
        )
      : null;
  if (
    !isSha256(observationKey) ||
    !expectedObservationKey ||
    observationKey !== expectedObservationKey
  ) {
    blockers.push("CONTENT_OBSERVATION_KEY_MISMATCH");
  }

  if (
    blockers.length > initialBlockerCount ||
    !decisionEvidence ||
    !decisionEvidenceHash ||
    !contentHash ||
    !fieldHashes ||
    !sourceApi ||
    !observationKey
  ) {
    return null;
  }
  return {
    observation_key: observationKey,
    content_hash: contentHash,
    field_hashes: fieldHashes as Record<string, string>,
    source_api: sourceApi,
    decision_evidence_hash: decisionEvidenceHash,
    decision_evidence: decisionEvidence,
    run_id: runId,
    approval_id: approvalId,
    metered_receipt_id: meteredReceiptId,
  };
}

/** Pure evidence compiler. Exported so the engine contract can be regression
 * tested without a database or network. Database readers above only select the
 * immutable rows supplied to this function. */
export function buildProductTruthRecipeComponentFromRows(input: {
  identity: EvidenceRow;
  price: EvidenceRow;
  qty: number;
  index: number;
  options: {
    asOf: string | Date;
    maxPriceAgeMs: number;
    zip: string;
    requireIngredients: boolean;
    requireNutrition: boolean;
    requireAllergens: boolean;
  };
}): ProductTruthNewSkuRecipeComponentEvidence {
  const blockers: string[] = [];
  const identity = input.identity;
  const price = input.price;
  const facts = contentFacts(identity);
  const exactDonorProductId = optionalText(identity.donorProductId);
  const donorProductId = exactDonorProductId ?? `component-${input.index}`;
  const canonicalVariantId = optionalText(identity.canonicalVariantId);
  const variantDecisionId = optionalText(identity.variantDecisionId);
  const contentObservationId = optionalText(identity.contentObservationId);
  if (!canonicalVariantId || !variantDecisionId || !contentObservationId) {
    blockers.push("EXACT_CONTENT_IDENTITY_INCOMPLETE");
  }
  if (!exactDonorProductId) blockers.push("DONOR_PRODUCT_ID_MISSING");
  if (identity.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION) {
    blockers.push("MATCHER_VERSION_NOT_CURRENT");
  }
  if (identity.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256) {
    blockers.push("MATCHER_IMPLEMENTATION_NOT_CURRENT");
  }
  if (identity.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256) {
    blockers.push("MATCHER_RELEASE_NOT_CURRENT");
  }
  if (!Number.isInteger(input.qty) || input.qty <= 0) blockers.push("QTY_INVALID");
  const canonicalIdentity = canonicalIdentityFromRow(identity, blockers);
  const contentProvenance = contentProvenanceFromRow(identity, blockers);
  const title = facts.title;
  const mainImage = facts.mainImage;
  if (!title) blockers.push("TITLE_MISSING");
  if (!mainImage) blockers.push("MAIN_IMAGE_MISSING");
  if (input.options.requireIngredients && !facts.ingredients) blockers.push("INGREDIENTS_MISSING");
  if (input.options.requireNutrition && facts.nutrition == null) blockers.push("NUTRITION_MISSING");
  if (input.options.requireAllergens && facts.allergens == null) blockers.push("ALLERGENS_MISSING");
  const manufacturerUpc = facts.manufacturerUpc;
  if (!manufacturerUpc) blockers.push("MANUFACTURER_UPC_MISSING");

  const packagePrice = positiveNumber(price.price);
  const packSizeSeen = positiveInteger(price.packSizeSeen);
  const pricePerUnit = positiveNumber(price.pricePerUnit) ??
    (packagePrice && packSizeSeen ? packagePrice / packSizeSeen : null);
  if (!packagePrice || !packSizeSeen || !pricePerUnit) {
    blockers.push("PRICE_EVIDENCE_INVALID");
  }
  if (packSizeSeen !== null && packSizeSeen !== 1) {
    blockers.push("PRICE_EVIDENCE_NOT_BASE_UNIT");
  }
  if (packagePrice && packSizeSeen && pricePerUnit) {
    const expectedPricePerUnit = packagePrice / packSizeSeen;
    if (Math.abs(pricePerUnit - expectedPricePerUnit) > 0.005) {
      blockers.push("PRICE_PER_UNIT_ARITHMETIC_MISMATCH");
    }
  }
  const locality = optionalText(price.localityEvidence);
  const priceZip = optionalText(price.zip);
  if (
    locality !== "zip_scoped" ||
    !/^\d{5}(?:-\d{4})?$/.test(priceZip ?? "") ||
    priceZip !== input.options.zip
  ) {
    blockers.push("LOCALITY_EVIDENCE_INVALID");
  }
  if (
    optionalText(price.donorProductId) !== optionalText(identity.donorProductId) ||
    optionalText(price.canonicalVariantId) !== canonicalVariantId ||
    optionalText(price.variantDecisionId) !== variantDecisionId
  ) {
    blockers.push("PRICE_EXACT_IDENTITY_MISMATCH");
  }
  const priceObservationKey = optionalText(price.observationKey);
  if (!isSha256(priceObservationKey)) blockers.push("PRICE_OBSERVATION_KEY_INVALID");
  const priceRunId = optionalText(price.runId);
  const priceApprovalId = optionalText(price.approvalId);
  const priceReceiptId = optionalText(price.meteredReceiptId);
  if (!provenancePairValid(priceRunId, priceApprovalId, priceReceiptId)) {
    blockers.push("PRICE_RUN_PROVENANCE_INVALID");
  }
  const retailer = optionalText(price.retailer);
  const retailerProductId = optionalText(price.retailerProductId);
  const via = optionalText(price.via);
  const sourceApi = optionalText(price.sourceApi);
  const currency = optionalText(price.currency);
  const observedAt = optionalText(price.observedAt);
  const priceSourceUrl = normalizeUrl(price.productUrl);
  if (!retailerProductId) blockers.push("PRICE_RETAILER_PRODUCT_ID_MISSING");
  if (via !== "direct") blockers.push("PRICE_VIA_NOT_DIRECT");
  if (!sourceApi) blockers.push("PRICE_SOURCE_API_MISSING");
  if (!priceSourceUrl) blockers.push("PRICE_SOURCE_URL_INVALID");
  if (currency !== "USD") blockers.push("PRICE_CURRENCY_INVALID");
  if (booleanValue(price.isFirstParty) !== true) blockers.push("PRICE_FIRST_PARTY_UNPROVEN");
  if (booleanValue(price.inStock) !== true) blockers.push("PRICE_STOCK_UNPROVEN");

  const policy = evaluatePriceEvidenceEligibility(
    {
      retailer,
      via,
      price: pricePerUnit,
      isFirstParty: booleanValue(price.isFirstParty),
      inStock: booleanValue(price.inStock),
      zip: priceZip,
      localityEvidence: locality,
      fetchedAt: observedAt,
      matchVerdict: "EXACT_IDENTITY",
    },
    { now: input.options.asOf, maxAgeMs: input.options.maxPriceAgeMs },
  );
  if (
    policy.eligibility !== "FACT" ||
    policy.policyVersion !== PRICE_EVIDENCE_POLICY_VERSION
  ) {
    blockers.push(`PRICE_POLICY_NOT_FACT:${policy.reasonCodes.join(",")}`);
  }
  if (blockers.length) {
    throw new ProductTruthRecipeInputError(
      blockers.map((blocker) => `${donorProductId}:${blocker}`),
    );
  }

  const priceEvidence: ProductTruthNewSkuPriceEvidence = {
    role: "PRICE",
    observation_id: requiredText(price.observationId, "priceObservationId"),
    observation_key: priceObservationKey!,
    donor_offer_id: requiredText(price.donorOfferId, "donorOfferId"),
    match_tier: "EXACT_IDENTITY",
    eligibility: "FACT",
    policy_version: PRICE_EVIDENCE_POLICY_VERSION,
    policy_reason_codes: policy.reasonCodes,
    retailer: retailer!,
    retailer_product_id: retailerProductId!,
    via: "direct",
    source_url: priceSourceUrl!,
    source_api: sourceApi!,
    observed_at: normalizeInstant(observedAt!, "price observedAt"),
    locality_evidence: "zip_scoped",
    zip: priceZip!,
    first_party: true,
    in_stock: true,
    package_price: packagePrice!,
    pack_size_seen: packSizeSeen!,
    price_per_unit: pricePerUnit!,
    currency: currency!,
    run_id: priceRunId,
    approval_id: priceApprovalId,
    metered_receipt_id: priceReceiptId,
  };

  return {
    component_key: `component-${input.index}-${canonicalVariantId!}`,
    donor_product_id: donorProductId,
    canonical_variant_id: canonicalVariantId!,
    variant_decision_id: variantDecisionId!,
    canonical_identity: canonicalIdentity!,
    product_name: title!,
    manufacturer_brand: canonicalIdentity!.brand,
    manufacturer_upc: manufacturerUpc,
    flavor: canonicalIdentity!.flavor,
    qty: input.qty,
    content_role: "EXACT",
    content_observation_id: contentObservationId!,
    content_source_url: requiredText(
      normalizeUrl(identity.contentSourceUrl),
      "content source URL",
    ),
    content_captured_at: normalizeInstant(
      requiredText(identity.contentObservedAt, "content observedAt"),
      "content observedAt",
    ),
    matcher_version: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcher_implementation_sha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcher_release_sha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    content_provenance: contentProvenance!,
    content_classification: {
      category: facts.classification.category,
      storage: facts.classification.storage,
      category_field: facts.classification.categoryField,
      storage_field: facts.classification.storageField,
    },
    facts: {
      ingredients: facts.ingredients,
      allergens: facts.allergens,
      nutrition_facts: facts.nutrition,
      attributes: {
        ...facts.attributes,
        _exact_main_image_url: mainImage,
        _exact_image_urls: facts.images,
      },
    },
    price_evidence: priceEvidence,
  };
}

export async function readProductTruthRecipeInput(
  db: Client,
  requests: ProductTruthRecipeRequest[],
  options: ProductTruthRecipeReadOptions,
): Promise<ProductTruthRecipeInput> {
  await assertProductTruthEvidenceSchema(db);
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new ProductTruthRecipeInputError(["RECIPE_EMPTY"]);
  }
  const asOf = normalizeInstant(options.asOf, "asOf");
  const maxPriceAgeMs = options.maxPriceAgeMs ?? DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS;
  if (!Number.isFinite(maxPriceAgeMs) || maxPriceAgeMs < 0) {
    throw new Error("maxPriceAgeMs must be a non-negative finite number");
  }
  const zip = options.zip?.trim() || DEFAULT_WALMART_PILOT_ZIP;
  const cutoff = new Date(Date.parse(asOf) - maxPriceAgeMs).toISOString();
  const contentRequirements = {
    requireIngredients: options.requireIngredients ?? true,
    requireNutrition: options.requireNutrition ?? true,
    requireAllergens: options.requireAllergens ?? true,
  };
  const seen = new Set<string>();
  const components: ProductTruthNewSkuRecipeComponentEvidence[] = [];
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    const donorProductId = request.donorProductId?.trim();
    if (!donorProductId) throw new ProductTruthRecipeInputError([`COMPONENT_${index}:DONOR_ID_MISSING`]);
    if (seen.has(donorProductId)) {
      throw new ProductTruthRecipeInputError([`COMPONENT_${index}:DUPLICATE_DONOR_COMPONENT`]);
    }
    seen.add(donorProductId);
    if (!Number.isInteger(request.qty) || request.qty <= 0) {
      throw new ProductTruthRecipeInputError([`COMPONENT_${index}:QTY_INVALID`]);
    }
    const identity = await readIdentityContent(
      db,
      donorProductId,
      asOf,
      contentRequirements,
    );
    if (!identity) {
      throw new ProductTruthRecipeInputError([`${donorProductId}:EXACT_CONTENT_EVIDENCE_MISSING`]);
    }
    const prices = await readExactLocalPrices(db, {
      donorProductId,
      canonicalVariantId: requiredText(identity.canonicalVariantId, "canonicalVariantId"),
      variantDecisionId: requiredText(identity.variantDecisionId, "variantDecisionId"),
      asOf,
      cutoff,
      zip,
    });
    if (prices.length === 0) {
      throw new ProductTruthRecipeInputError([`${donorProductId}:FRESH_LOCAL_PRICE_EVIDENCE_MISSING`]);
    }
    let component: ProductTruthNewSkuRecipeComponentEvidence | null = null;
    const semanticBlockers = new Set<string>();
    for (const price of prices) {
      try {
        component = buildProductTruthRecipeComponentFromRows({
          identity,
          price,
          qty: request.qty,
          index,
          options: {
            asOf,
            maxPriceAgeMs,
            zip,
            ...contentRequirements,
          },
        });
        break;
      } catch (error) {
        if (!(error instanceof ProductTruthRecipeInputError)) throw error;
        error.blockers.forEach((blocker) => semanticBlockers.add(blocker));
      }
    }
    if (!component) {
      throw new ProductTruthRecipeInputError(
        semanticBlockers.size > 0
          ? [...semanticBlockers]
          : [`${donorProductId}:NO_SEMANTICALLY_VALID_EXACT_PRICE`],
      );
    }
    components.push(component);
  }

  return {
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    as_of: asOf,
    price_max_age_ms: maxPriceAgeMs,
    zip,
    components,
  };
}

function excludedPilotTitle(title: string, category: string): boolean {
  return /frozen|refrigerated|chilled|supplement|vitamin|baby|infant|pet\s|dog\s|cat\s|medical|topical|pesticide|aerosol|battery|gift\s*(?:set|basket)|variety|mixed/i
    .test(`${title} ${category}`);
}

function pilotClassification(
  component: ProductTruthNewSkuRecipeComponentEvidence,
): WalmartPilotCandidate["classification_evidence"] & { category: string } {
  const classification = component.content_classification;
  const category = optionalText(classification.category);
  const storage = optionalText(classification.storage);
  const categoryField = optionalText(classification.category_field);
  const storageField = optionalText(classification.storage_field);
  const blockers: string[] = [];
  if (!category || !categoryField) blockers.push("CATEGORY_EVIDENCE_MISSING");
  if (!storage || !storageField) blockers.push("STORAGE_EVIDENCE_MISSING");
  const normalizedStorage = storage?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  if (
    storage &&
    !["shelfstable", "ambient", "pantry", "dry", "roomtemperature"].includes(
      normalizedStorage,
    )
  ) {
    blockers.push("STORAGE_NOT_SHELF_STABLE");
  }
  const categoryRoot = categoryField?.split(".")[0] ?? "";
  const storageRoot = storageField?.split(".")[0] ?? "";
  if (
    !isSha256(component.content_provenance.field_hashes[categoryRoot]) ||
    !isSha256(component.content_provenance.field_hashes[storageRoot])
  ) {
    blockers.push("CLASSIFICATION_FIELD_HASH_MISSING");
  }
  if (category && excludedPilotTitle(component.product_name, category)) {
    blockers.push("PILOT_CATEGORY_OR_TITLE_EXCLUDED");
  }
  if (blockers.length) {
    throw new ProductTruthRecipeInputError(
      blockers.map((blocker) => `${component.donor_product_id}:${blocker}`),
    );
  }
  return {
    category: category!,
    category_field: categoryField!,
    storage_field: storageField!,
    content_observation_id: component.content_observation_id,
    source_api: component.content_provenance.source_api,
  };
}

export interface ProductTruthWalmartPilotCandidateReadOptions
  extends ProductTruthRecipeReadOptions {
  donorProductId: string;
  qty?: number;
}

export function buildWalmartPilotCandidateFromNewSkuView(
  newSkuView: ProductTruthRecipeInput,
): WalmartPilotCandidate {
  if (newSkuView.contractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION) {
    throw new ProductTruthRecipeInputError(["NEW_SKU_VIEW_VERSION_UNSUPPORTED"]);
  }
  if (newSkuView.components.length !== 1) {
    throw new ProductTruthRecipeInputError(["WALMART_PILOT_REQUIRES_ONE_COMPONENT"]);
  }
  const component = newSkuView.components[0];
  const classification = pilotClassification(component);
  const imageCount = Array.isArray(component.facts.attributes._exact_image_urls)
    ? component.facts.attributes._exact_image_urls.length
    : 0;
  return {
    donor_product_id: component.donor_product_id,
    canonical_variant_id: component.canonical_variant_id,
    title: component.product_name,
    brand: component.manufacturer_brand,
    flavor: component.flavor,
    manufacturer_upc: component.manufacturer_upc,
    category: classification.category,
    storage_classification: "SHELF_STABLE",
    classification_evidence: {
      category_field: classification.category_field,
      storage_field: classification.storage_field,
      content_observation_id: classification.content_observation_id,
      source_api: classification.source_api,
    },
    content_observation_id: component.content_observation_id,
    price_observation_id: component.price_evidence.observation_id,
    observed_price: component.price_evidence.package_price,
    price_observed_at: component.price_evidence.observed_at,
    content_observed_at: component.content_captured_at,
    image_count: imageCount,
    default_pack_counts: [2, 3],
    score: 100 + Math.min(imageCount, 8) * 2,
  };
}

/** Point read for current-checks: candidate classification and the full exact
 * component are compiled from the same immutable sourcing snapshot. */
export async function readWalmartPilotCandidate(
  db: Client,
  options: ProductTruthWalmartPilotCandidateReadOptions,
): Promise<ProductTruthWalmartPilotCandidateRead> {
  const donorProductId = options.donorProductId?.trim();
  if (!donorProductId) {
    throw new ProductTruthRecipeInputError(["DONOR_ID_MISSING"]);
  }
  const newSkuView = await readProductTruthRecipeInput(
    db,
    [{ donorProductId, qty: options.qty ?? 2 }],
    options,
  );
  return {
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    newSkuView,
    candidate: buildWalmartPilotCandidateFromNewSkuView(newSkuView),
  };
}

export async function collectWalmartPilotCandidatesPaginated(input: {
  limit: number;
  pageSize: number;
  readPage: (offset: number, pageSize: number) => Promise<string[]>;
  readCandidate: (donorProductId: string) => Promise<WalmartPilotCandidate>;
}): Promise<WalmartPilotCandidate[]> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error("candidate limit must be a positive integer");
  }
  if (!Number.isInteger(input.pageSize) || input.pageSize <= 0) {
    throw new Error("candidate pageSize must be a positive integer");
  }
  const candidates: WalmartPilotCandidate[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (candidates.length < input.limit) {
    const page = await input.readPage(offset, input.pageSize);
    if (page.length === 0) break;
    offset += page.length;
    for (const rawId of page) {
      const donorProductId = rawId.trim();
      if (!donorProductId || seen.has(donorProductId)) continue;
      seen.add(donorProductId);
      try {
        candidates.push(await input.readCandidate(donorProductId));
      } catch (error) {
        if (!(error instanceof ProductTruthRecipeInputError)) throw error;
      }
      if (candidates.length >= input.limit) break;
    }
    if (page.length < input.pageSize) break;
  }
  return candidates.sort(
    (left, right) =>
      right.score - left.score || left.title.localeCompare(right.title, "en-US"),
  );
}

export async function listWalmartPilotCandidates(
  db: Client,
  options: ProductTruthRecipeReadOptions & { limit?: number },
): Promise<WalmartPilotCandidate[]> {
  await assertProductTruthEvidenceSchema(db);
  const asOf = normalizeInstant(options.asOf, "asOf");
  const maxPriceAgeMs = options.maxPriceAgeMs ?? DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS;
  const cutoff = new Date(Date.parse(asOf) - maxPriceAgeMs).toISOString();
  const zip = options.zip?.trim() || DEFAULT_WALMART_PILOT_ZIP;
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const pageSize = Math.max(25, Math.min(100, limit * 2));
  return collectWalmartPilotCandidatesPaginated({
    limit,
    pageSize,
    readPage: async (offset, requestedPageSize) => {
      const rows = await db.execute({
        sql: `SELECT decision.donorProductId AS id,
            MAX(content.observedAt) AS latestContentObservedAt
          FROM DonorProductVariantDecision decision
          JOIN ProductContentObservation content
            ON content.donorProductId=decision.donorProductId
           AND content.variantDecisionId=decision.id
           AND content.canonicalVariantId=decision.canonicalVariantId
          JOIN DonorOfferObservation offer
            ON offer.donorProductId=decision.donorProductId
           AND offer.variantDecisionId=decision.id
           AND offer.canonicalVariantId=decision.canonicalVariantId
          WHERE decision.decisionStatus='exact_confirmed'
            AND decision.matcherVersion=?
            AND decision.matcherImplementationSha256=?
            AND decision.matcherReleaseSha256=?
            AND julianday(content.observedAt)<=julianday(?)
            AND julianday(content.createdAt)<=julianday(?)
            AND offer.id=(
              SELECT latest.id FROM DonorOfferObservation latest
              WHERE latest.donorOfferId=offer.donorOfferId
                AND latest.canonicalVariantId=offer.canonicalVariantId
                AND julianday(latest.observedAt)<=julianday(?)
                AND julianday(latest.createdAt)<=julianday(?)
              ORDER BY julianday(latest.observedAt) DESC, latest.observedAt DESC,
                julianday(latest.createdAt) DESC, latest.createdAt DESC, latest.id DESC
              LIMIT 1
            )
            AND offer.isFirstParty=1
            AND offer.inStock=1
            AND offer.price>0
            AND julianday(offer.observedAt) BETWEEN julianday(?) AND julianday(?)
            AND offer.localityEvidence='zip_scoped'
            AND offer.zip=?
          GROUP BY decision.donorProductId
          ORDER BY latestContentObservedAt DESC, decision.donorProductId ASC
          LIMIT ? OFFSET ?`,
        args: [
          CANONICAL_PRODUCT_MATCHER_VERSION,
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
          CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
          asOf,
          asOf,
          asOf,
          asOf,
          cutoff,
          asOf,
          zip,
          requestedPageSize,
          offset,
        ],
      });
      return rows.rows.map((row) => String(row.id));
    },
    readCandidate: async (donorProductId) =>
      (await readWalmartPilotCandidate(db, {
        ...options,
        donorProductId,
        qty: 2,
      })).candidate,
  });
}
