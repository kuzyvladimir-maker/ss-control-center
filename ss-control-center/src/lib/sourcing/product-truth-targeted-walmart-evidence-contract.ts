import { createHash } from "node:crypto";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  matchCanonicalProductTitle,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "./canonical-product-match-provenance";
import {
  CANONICAL_PRODUCT_VARIANT_IDENTITY_VERSION,
  CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
  buildCanonicalProductVariantKey,
} from "./canonical-product-variant";
import {
  decodeMeteredRunPermit,
  expectedMeteredRunConfirmation,
  type MeteredRunPermit,
} from "./metered-call-guard";
import {
  PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
  expectedProductTruthExecutionConfirmation,
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
  type ProductTruthOperationalApproval,
  type ProductTruthProviderCeiling,
  type ValidatedProductTruthOperationalApproval,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION =
  "product-truth-targeted-walmart-evidence-request/1.5.0" as const;
export const PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION =
  "product-truth-targeted-walmart-evidence-plan/1.5.0" as const;
export const PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_SCOPE_VERSION =
  "product-truth-targeted-walmart-evidence-scope/1.0.0" as const;
export const PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_RESULT_VERSION =
  "product-truth-targeted-walmart-evidence-result/1.0.0" as const;

export const TARGETED_WALMART_PRICE_TTL_MS = 24 * 60 * 60 * 1_000;
export const TARGETED_WALMART_MIN_IMAGES = 2 as const;
// Two authenticated remote schema checks plus two sequential evidence providers
// can legitimately exceed three minutes. Six minutes remains a hard, sealed
// ceiling while leaving enough time to persist the already-returned detail
// response instead of terminalizing it at the write boundary.
export const TARGETED_WALMART_MAX_WALL_CLOCK_MS = 360_000 as const;

export const PRODUCT_TRUTH_TARGETED_WALMART_LEGACY_SNAPSHOT_VERSION =
  "product-truth-targeted-walmart-legacy-snapshot/1.0.0" as const;
export const PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION =
  "product-truth-targeted-walmart-identity-derivation/1.0.0" as const;
export const PRODUCT_TRUTH_TARGETED_WALMART_LISTING_BINDING_VERSION =
  "product-truth-targeted-walmart-listing-binding/1.1.0" as const;
export const PRODUCT_TRUTH_TARGETED_WALMART_LISTING_IDENTITY_DERIVATION_VERSION =
  "product-truth-targeted-walmart-listing-identity-derivation/1.0.0" as const;

export interface ProductTruthTargetedWalmartLegacySnapshot {
  schemaVersion: typeof PRODUCT_TRUTH_TARGETED_WALMART_LEGACY_SNAPSHOT_VERSION;
  donorProductRowJson: string;
  donorOfferRowJson: string;
  sha256: string;
}

export interface ProductTruthTargetedWalmartListingBinding {
  schemaVersion: typeof PRODUCT_TRUTH_TARGETED_WALMART_LISTING_BINDING_VERSION;
  listingKey: string;
  channel: "walmart";
  storeIndex: number;
  sku: string;
  componentIndex: number;
  legacyComponentId: string;
  listingScopeRowJson: string;
  shippingRowJson: string;
  componentRowJson: string;
  donorGraph: readonly ProductTruthTargetedWalmartListingGraphEntry[];
  donorGraphSha256: string;
  sha256: string;
}

export interface ProductTruthTargetedWalmartListingGraphEntry {
  listingKey: string;
  componentIndex: number;
  legacyComponentId: string;
  canonicalVariantId: string;
  listingScopeRowJson: string;
  shippingRowJson: string;
  componentRowJson: string;
}

export interface ProductTruthTargetedWalmartListingGraphInput {
  listingScopeRow: Record<string, unknown>;
  shippingRow: Record<string, unknown>;
  componentRow: Record<string, unknown>;
}

interface ProductTruthTargetedWalmartDonorSnapshotBase {
  identityMode:
    | "EXISTING_EXACT"
    | "EVIDENCE_VERIFIED_BOOTSTRAP"
    | "LISTING_BOUND_BOOTSTRAP";
  identityDerivationVersion:
    | null
    | typeof PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION
    | typeof PRODUCT_TRUTH_TARGETED_WALMART_LISTING_IDENTITY_DERIVATION_VERSION;
  donorProductId: string;
  donorOfferId: string;
  canonicalVariantId: string;
  matcherVersion: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
  matcherImplementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
  matcherReleaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  decisionEvidenceHash: string | null;
  decisionEvidenceJson: string | null;
  canonicalVariantKeyVersion: string;
  canonicalIdentityHash: string;
  canonicalIdentityJson: string;
  retailer: "walmart";
  retailerProductId: string;
  normalizedProductUrl: string;
  via: "direct";
  isFirstParty: true;
  listingBinding: ProductTruthTargetedWalmartListingBinding | null;
}

export interface ProductTruthTargetedWalmartExistingExactSnapshot
  extends ProductTruthTargetedWalmartDonorSnapshotBase {
  identityMode: "EXISTING_EXACT";
  identityDerivationVersion: null;
  donorIdentityStatus: "exact_confirmed";
  variantDecisionId: string;
  decisionStatus: "exact_confirmed";
  decisionEvidenceHash: string;
  decisionEvidenceJson: string;
  legacySnapshot: null;
  listingBinding: null;
}

export interface ProductTruthTargetedWalmartBootstrapSnapshot
  extends ProductTruthTargetedWalmartDonorSnapshotBase {
  identityMode: "EVIDENCE_VERIFIED_BOOTSTRAP";
  identityDerivationVersion:
    typeof PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION;
  donorIdentityStatus: "candidate" | "legacy_unverified";
  variantDecisionId: null;
  decisionStatus: null;
  decisionEvidenceHash: null;
  decisionEvidenceJson: null;
  legacySnapshot: ProductTruthTargetedWalmartLegacySnapshot;
  listingBinding: null;
}

export interface ProductTruthTargetedWalmartListingBoundBootstrapSnapshot
  extends ProductTruthTargetedWalmartDonorSnapshotBase {
  identityMode: "LISTING_BOUND_BOOTSTRAP";
  identityDerivationVersion:
    typeof PRODUCT_TRUTH_TARGETED_WALMART_LISTING_IDENTITY_DERIVATION_VERSION;
  donorIdentityStatus: "candidate" | "legacy_unverified";
  variantDecisionId: null;
  decisionStatus: null;
  decisionEvidenceHash: null;
  decisionEvidenceJson: null;
  legacySnapshot: ProductTruthTargetedWalmartLegacySnapshot;
  listingBinding: ProductTruthTargetedWalmartListingBinding;
}

export type ProductTruthTargetedWalmartDonorSnapshot =
  | ProductTruthTargetedWalmartExistingExactSnapshot
  | ProductTruthTargetedWalmartBootstrapSnapshot
  | ProductTruthTargetedWalmartListingBoundBootstrapSnapshot;

export interface ProductTruthTargetedWalmartEvidencePlanRequest {
  schemaVersion: typeof PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION;
  runId: string;
  createdAt: string;
  expiresAt: string;
  expectedTargetFingerprint: string;
  engineReleaseSha256: string;
  schemaFingerprintSha256: string;
  migrationSetSha256: string;
  matcherVersion: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
  matcherImplementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
  matcherReleaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  query: string;
  donorSnapshot: ProductTruthTargetedWalmartDonorSnapshot;
  donorSnapshotSha256: string;
  providerCeilings: readonly ProductTruthProviderCeiling[];
  verificationPolicy: {
    procurementZip: "33765";
    maxPriceAgeMs: typeof TARGETED_WALMART_PRICE_TTL_MS;
    minGalleryImages: typeof TARGETED_WALMART_MIN_IMAGES;
  };
  maxWallClockMs: typeof TARGETED_WALMART_MAX_WALL_CLOCK_MS;
}

export type ProductTruthTargetedWalmartEvidenceTarget =
  ProductTruthTargetedWalmartDonorSnapshot & {
  ordinal: 0;
  query: string;
  donorSnapshotSha256: string;
};

/**
 * Deliberately retains the operational runner's common projection fields. The
 * durable ProductTruthOperationalRun row owns the environment lease and the
 * metered budget/receipt fences, while the one product EnrichmentJob owns work
 * state. No fake marketplace listing scope or OperationalRunItem is created.
 */
export interface ProductTruthTargetedWalmartEvidencePlan {
  schemaVersion: typeof PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION;
  runId: string;
  mode: "WAVE";
  createdAt: string;
  expiresAt: string;
  targetFingerprint: string;
  engineReleaseSha256: string;
  schemaFingerprintSha256: string;
  migrationSetSha256: string;
  matcherVersion: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
  matcherImplementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
  matcherReleaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  manifest: {
    schemaVersion: typeof PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_SCOPE_VERSION;
    sha256: string;
    asOf: string;
    donorCount: 1;
  };
  targetSetSha256: string;
  targets: readonly [ProductTruthTargetedWalmartEvidenceTarget];
  sourcePolicy: {
    procurementZip: "33765";
    retailers: readonly ["walmart"];
    allowClubs: false;
    allowBjs: false;
    listingConcurrency: 1;
    componentConcurrency: 1;
    maxAttemptsPerListing: 1;
    allowOpenFoodFactsSupplement: false;
  };
  providerCeilings: readonly ProductTruthProviderCeiling[];
  verificationPolicy: {
    procurementZip: "33765";
    maxPriceAgeMs: typeof TARGETED_WALMART_PRICE_TTL_MS;
    minGalleryImages: typeof TARGETED_WALMART_MIN_IMAGES;
  };
  maxWallClockMs: typeof TARGETED_WALMART_MAX_WALL_CLOCK_MS;
  claims: {
    identityMode:
      | "EXISTING_EXACT"
      | "EVIDENCE_VERIFIED_BOOTSTRAP"
      | "LISTING_BOUND_BOOTSTRAP";
    exactOneExistingDonor: true;
    exactOneExistingDirectFirstPartyWalmartOffer: true;
    initialDetailHarvestStateAbsent: true;
    canonicalVariantWritesMax: 0 | 1;
    variantDecisionWritesMax: 0 | 1;
    targetProductProjectionMayChange: boolean;
    unrelatedOfferWrites: false;
    unrelatedProductWrites: false;
    openFoodFactsCalls: false;
    clubCalls: false;
    bjsCalls: false;
    automaticReplay: false;
    automaticPublish: false;
    automaticDelist: false;
    automaticReprice: false;
    automaticPurchase: false;
  };
}

export class ProductTruthTargetedWalmartEvidenceContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthTargetedWalmartEvidenceContractError";
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthTargetedWalmartEvidenceContractError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", `${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function exactText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", `${label} must be exact non-empty text`);
  }
  return value;
}

function exactJsonBytesText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maximum
    || value.includes("\0")
  ) {
    fail(
      "TARGETED_EVIDENCE_INPUT_INVALID",
      `${label} must be bounded exact JSON bytes`,
    );
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const result = exactText(value, label, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", `${label} contains unsafe characters`);
  }
  return result;
}

function exactSha(value: unknown, label: string): string {
  const result = exactText(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", `${label} must be a SHA-256 digest`);
  }
  return result;
}

function exactInstant(value: unknown, label: string): string {
  const result = exactText(value, label, 80);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", `${label} must be canonical ISO-8601 UTC`);
  }
  return result;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", `${label} must be finite and non-negative`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseExactDecisionEvidence(value: {
  evidenceHash: unknown;
  evidenceJson: unknown;
}): { evidenceHash: string; evidenceJson: string } {
  const evidenceHash = exactSha(
    value.evidenceHash,
    "donorSnapshot.decisionEvidenceHash",
  );
  const evidenceJson = exactJsonBytesText(
    value.evidenceJson,
    "donorSnapshot.decisionEvidenceJson",
    200_000,
  );
  if (sha256(evidenceJson) !== evidenceHash) {
    fail(
      "TARGETED_EVIDENCE_DECISION_EVIDENCE_HASH_MISMATCH",
      "variant decision evidenceHash does not match the exact evidenceJson bytes",
    );
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(evidenceJson);
  } catch {
    fail(
      "TARGETED_EVIDENCE_DECISION_EVIDENCE_INVALID",
      "variant decision evidenceJson must be valid JSON",
    );
  }
  if (!isRecord(evidence)) {
    fail(
      "TARGETED_EVIDENCE_DECISION_EVIDENCE_INVALID",
      "variant decision evidenceJson must encode one object",
    );
  }
  if (
    evidence.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
    || evidence.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || evidence.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
  ) {
    fail(
      "TARGETED_EVIDENCE_DECISION_EVIDENCE_MATCHER_MISMATCH",
      "variant decision evidenceJson is not bound to the current certified matcher release",
    );
  }
  return { evidenceHash, evidenceJson };
}

function canonicalModifierInputs(modifiers: readonly string[]): string[] {
  return modifiers.map((modifier) => (
    modifier.startsWith("token:")
      ? modifier.slice("token:".length)
      : modifier.replace(/_/g, " ")
  ));
}

export function normalizeExactWalmartProductUrl(
  value: unknown,
  expectedRetailerProductId?: string,
): string {
  const raw = exactText(value, "Walmart product URL", 2_000);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("WALMART_PRODUCT_URL_INVALID", "Walmart product URL is not parseable");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || (host !== "walmart.com" && host !== "www.walmart.com")
    || parsed.username
    || parsed.password
  ) {
    fail("WALMART_PRODUCT_URL_INVALID", "Walmart URL must use https://www.walmart.com without credentials");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const ipIndex = segments.findIndex((segment) => segment.toLowerCase() === "ip");
  const productId = segments.at(-1) ?? "";
  if (ipIndex < 0 || ipIndex >= segments.length - 1 || !/^[0-9]{1,32}$/.test(productId)) {
    fail("WALMART_PRODUCT_URL_INVALID", "Walmart URL must contain /ip/.../<numeric item id>");
  }
  if (expectedRetailerProductId !== undefined && productId !== expectedRetailerProductId) {
    fail("WALMART_ITEM_URL_MISMATCH", "Walmart URL item id differs from retailerProductId");
  }
  return `https://www.walmart.com/ip/${productId}`;
}

function canonicalBoundRowJson(value: unknown, label: string): {
  text: string;
  row: Record<string, unknown>;
} {
  if (typeof value !== "string" || !value || value.length > 200_000) {
    fail("TARGETED_EVIDENCE_LEGACY_SNAPSHOT_INVALID", `${label} must be bounded JSON text`);
  }
  const text = value;
  let row: unknown;
  try {
    row = JSON.parse(text);
  } catch {
    fail("TARGETED_EVIDENCE_LEGACY_SNAPSHOT_INVALID", `${label} must be JSON`);
  }
  if (!isRecord(row) || renderProductTruthOperationalJson(row) !== text) {
    fail(
      "TARGETED_EVIDENCE_LEGACY_SNAPSHOT_INVALID",
      `${label} must be one canonical full-row object`,
    );
  }
  return { text, row };
}

export function buildProductTruthTargetedWalmartLegacySnapshot(input: {
  donorProductRow: Record<string, unknown>;
  donorOfferRow: Record<string, unknown>;
}): ProductTruthTargetedWalmartLegacySnapshot {
  const donorProductRowJson = renderProductTruthOperationalJson(input.donorProductRow);
  const donorOfferRowJson = renderProductTruthOperationalJson(input.donorOfferRow);
  return {
    schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_LEGACY_SNAPSHOT_VERSION,
    donorProductRowJson,
    donorOfferRowJson,
    sha256: productTruthOperationalSha256({ donorProductRowJson, donorOfferRowJson }),
  };
}

function parseLegacySnapshot(
  value: unknown,
  donorProductId: string,
  donorOfferId: string,
  retailerProductId: string,
  normalizedProductUrl: string,
): ProductTruthTargetedWalmartLegacySnapshot {
  if (!isRecord(value)) {
    fail("TARGETED_EVIDENCE_LEGACY_SNAPSHOT_INVALID", "legacySnapshot must be an object");
  }
  exactKeys(value, [
    "schemaVersion", "donorProductRowJson", "donorOfferRowJson", "sha256",
  ], "legacySnapshot");
  if (value.schemaVersion !== PRODUCT_TRUTH_TARGETED_WALMART_LEGACY_SNAPSHOT_VERSION) {
    fail("TARGETED_EVIDENCE_LEGACY_SNAPSHOT_INVALID", "legacy snapshot version differs");
  }
  const product = canonicalBoundRowJson(
    value.donorProductRowJson,
    "legacySnapshot.donorProductRowJson",
  );
  const offer = canonicalBoundRowJson(
    value.donorOfferRowJson,
    "legacySnapshot.donorOfferRowJson",
  );
  const digest = exactSha(value.sha256, "legacySnapshot.sha256");
  if (
    digest !== productTruthOperationalSha256({
      donorProductRowJson: product.text,
      donorOfferRowJson: offer.text,
    })
    || product.row.id !== donorProductId
    || !["candidate", "legacy_unverified"].includes(String(product.row.identityStatus))
    || offer.row.id !== donorOfferId
    || offer.row.donorProductId !== donorProductId
    || offer.row.retailer !== "walmart"
    || offer.row.retailerProductId !== retailerProductId
    || offer.row.via !== "direct"
    || ![true, 1].includes(offer.row.isFirstParty as true | 1)
    || offer.row.sellerName !== "Walmart.com"
    || Number(offer.row.packSizeSeen) !== 1
    || normalizeExactWalmartProductUrl(offer.row.productUrl, retailerProductId)
      !== normalizedProductUrl
  ) {
    fail(
      "TARGETED_EVIDENCE_LEGACY_SNAPSHOT_INVALID",
      "legacy full-row bytes do not prove the selected direct first-party Walmart alias",
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_LEGACY_SNAPSHOT_VERSION,
    donorProductRowJson: product.text,
    donorOfferRowJson: offer.text,
    sha256: digest,
  };
}

function requiredRowText(
  row: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    fail("TARGETED_EVIDENCE_LISTING_BINDING_INVALID", `${label}.${key} is required`);
  }
  return value;
}

function nullableIdentityText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function listingIdentityTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Derives the exact base-product variant from the already-imported listing
 * identity. This is deliberately listing-bound: a legacy donor title may prove
 * the proposed structured identity, but may never invent a second field
 * partition for the same physical product.
 */
export function deriveProductTruthTargetedWalmartListingCanonicalIdentity(input: {
  listingScopeRow: Record<string, unknown>;
  shippingRow: Record<string, unknown>;
  componentRow: Record<string, unknown>;
  donorProductRow: Record<string, unknown>;
}): ReturnType<typeof buildCanonicalProductVariantKey> {
  const listingKey = requiredRowText(
    input.listingScopeRow,
    "listingKey",
    "listingScopeRow",
  );
  const channel = requiredRowText(
    input.listingScopeRow,
    "channel",
    "listingScopeRow",
  );
  const sku = requiredRowText(input.listingScopeRow, "sku", "listingScopeRow");
  const storeIndex = Number(input.listingScopeRow.storeIndex);
  const componentIndex = Number(input.componentRow.idx);
  if (
    channel !== "walmart"
    || !Number.isSafeInteger(storeIndex)
    || storeIndex <= 0
    || listingKey !== `walmart:${storeIndex}:${sku}`
    || input.shippingRow.sku !== sku
    || input.componentRow.sku !== sku
    || !Number.isSafeInteger(componentIndex)
    || componentIndex < 0
  ) {
    fail(
      "TARGETED_EVIDENCE_LISTING_BINDING_INVALID",
      "listing, shipping and component rows do not form one exact Walmart listing component",
    );
  }
  const rawIdentity = input.shippingRow.productIdentity;
  if (typeof rawIdentity !== "string" || !rawIdentity.trim()) {
    fail(
      "TARGETED_EVIDENCE_LISTING_IDENTITY_MISSING",
      "SkuShippingData.productIdentity is required",
    );
  }
  let identity: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawIdentity) as unknown;
    if (!isRecord(parsed)) throw new Error("not an object");
    identity = parsed;
  } catch {
    fail(
      "TARGETED_EVIDENCE_LISTING_IDENTITY_INVALID",
      "SkuShippingData.productIdentity must encode one object",
    );
  }

  let target: CanonicalProductIdentity;
  if (identity.is_bundle === true) {
    if (!Array.isArray(identity.components)) {
      fail(
        "TARGETED_EVIDENCE_LISTING_IDENTITY_INVALID",
        "bundle identity must contain components",
      );
    }
    const component = identity.components[componentIndex];
    if (!isRecord(component)) {
      fail(
        "TARGETED_EVIDENCE_LISTING_COMPONENT_MISSING",
        `bundle identity has no component ${componentIndex}`,
      );
    }
    const brand = nullableIdentityText(input.donorProductRow.brand);
    const product = nullableIdentityText(component.product);
    if (!brand || !product) {
      fail(
        "TARGETED_EVIDENCE_LISTING_IDENTITY_INCOMPLETE",
        "bundle component requires exact donor brand and product text",
      );
    }
    const brandTokens = listingIdentityTokens(brand);
    const productTokens = listingIdentityTokens(product);
    if (
      !brandTokens.length
      || brandTokens.length >= productTokens.length
      || brandTokens.some((token, index) => token !== productTokens[index])
    ) {
      fail(
        "TARGETED_EVIDENCE_LISTING_BRAND_MISMATCH",
        "bundle component product must begin with the exact donor brand",
      );
    }
    target = {
      brand,
      productLine: productTokens.slice(brandTokens.length).join(" "),
      flavor: nullableIdentityText(component.flavor),
      form: nullableIdentityText(component.container_type),
      size: nullableIdentityText(component.size),
      outerPackCount: 1,
    };
  } else {
    if (componentIndex !== 0) {
      fail(
        "TARGETED_EVIDENCE_LISTING_COMPONENT_INVALID",
        "a non-bundle listing may bind only component zero",
      );
    }
    target = {
      brand: nullableIdentityText(identity.brand),
      productLine: nullableIdentityText(identity.product_line),
      flavor: nullableIdentityText(identity.flavor),
      form: nullableIdentityText(identity.container_type),
      size: nullableIdentityText(identity.size),
      outerPackCount: 1,
    };
  }

  let canonical: ReturnType<typeof buildCanonicalProductVariantKey>;
  try {
    canonical = buildCanonicalProductVariantKey(target);
  } catch (error) {
    fail(
      "TARGETED_EVIDENCE_LISTING_IDENTITY_INCOMPLETE",
      error instanceof Error ? error.message : String(error),
    );
  }
  const donorTitle = nullableIdentityText(input.donorProductRow.title);
  const proof = matchCanonicalProductTitle(target, {
    title: donorTitle,
    brand: null,
  });
  if (proof.verdict !== "EXACT_IDENTITY") {
    fail(
      "TARGETED_EVIDENCE_LISTING_DONOR_MATCH_REJECTED",
      proof.reasonCodes.join(",") || proof.verdict,
    );
  }
  return canonical;
}

export function buildProductTruthTargetedWalmartListingBinding(input: {
  listingScopeRow: Record<string, unknown>;
  shippingRow: Record<string, unknown>;
  componentRow: Record<string, unknown>;
  donorProductRow: Record<string, unknown>;
  donorGraphRows?: readonly ProductTruthTargetedWalmartListingGraphInput[];
}): ProductTruthTargetedWalmartListingBinding {
  const listingScopeRowJson = renderProductTruthOperationalJson(input.listingScopeRow);
  const shippingRowJson = renderProductTruthOperationalJson(input.shippingRow);
  const componentRowJson = renderProductTruthOperationalJson(input.componentRow);
  const listingKey = requiredRowText(
    input.listingScopeRow,
    "listingKey",
    "listingScopeRow",
  );
  const channel = requiredRowText(
    input.listingScopeRow,
    "channel",
    "listingScopeRow",
  );
  const sku = requiredRowText(input.listingScopeRow, "sku", "listingScopeRow");
  const storeIndex = Number(input.listingScopeRow.storeIndex);
  const componentIndex = Number(input.componentRow.idx);
  const legacyComponentId = requiredRowText(
    input.componentRow,
    "id",
    "componentRow",
  );
  if (
    channel !== "walmart"
    || !Number.isSafeInteger(storeIndex)
    || storeIndex <= 0
    || !Number.isSafeInteger(componentIndex)
    || componentIndex < 0
  ) {
    fail(
      "TARGETED_EVIDENCE_LISTING_BINDING_INVALID",
      "listing binding channel/store/component is invalid",
    );
  }
  // Run the strict derivation now so a binding can never seal rows that are
  // structurally valid but identity-incompatible.
  const selectedCanonical =
    deriveProductTruthTargetedWalmartListingCanonicalIdentity(input);
  const donorProductId = requiredRowText(
    input.donorProductRow,
    "id",
    "donorProductRow",
  );
  const donorGraphInputs = input.donorGraphRows ?? [{
    listingScopeRow: input.listingScopeRow,
    shippingRow: input.shippingRow,
    componentRow: input.componentRow,
  }];
  if (!donorGraphInputs.length || donorGraphInputs.length > 100) {
    fail(
      "TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_INVALID",
      "listing-bound donor graph must contain 1-100 authoritative components",
    );
  }
  const donorGraph = donorGraphInputs.map(
    (entry): ProductTruthTargetedWalmartListingGraphEntry => {
      const graphListingScopeRowJson =
        renderProductTruthOperationalJson(entry.listingScopeRow);
      const graphShippingRowJson =
        renderProductTruthOperationalJson(entry.shippingRow);
      const graphComponentRowJson =
        renderProductTruthOperationalJson(entry.componentRow);
      const graphListingKey = requiredRowText(
        entry.listingScopeRow,
        "listingKey",
        "listingScopeRow",
      );
      const graphSku = requiredRowText(
        entry.listingScopeRow,
        "sku",
        "listingScopeRow",
      );
      const graphComponentIndex = Number(entry.componentRow.idx);
      const graphLegacyComponentId = requiredRowText(
        entry.componentRow,
        "id",
        "componentRow",
      );
      const linkedDonors = [...new Set(
        [entry.componentRow.contentDonorProductId, entry.componentRow.donorProductId]
          .filter((value): value is string =>
            typeof value === "string" && Boolean(value)),
      )];
      if (
        entry.listingScopeRow.channel !== "walmart"
        || entry.shippingRow.sku !== graphSku
        || entry.componentRow.sku !== graphSku
        || !Number.isSafeInteger(graphComponentIndex)
        || graphComponentIndex < 0
        || linkedDonors.length !== 1
        || linkedDonors[0] !== donorProductId
      ) {
        fail(
          "TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_INVALID",
          `graph entry ${graphListingKey}:${graphComponentIndex} does not prove the exact donor`,
        );
      }
      const canonical =
        deriveProductTruthTargetedWalmartListingCanonicalIdentity({
          listingScopeRow: entry.listingScopeRow,
          shippingRow: entry.shippingRow,
          componentRow: entry.componentRow,
          donorProductRow: input.donorProductRow,
        });
      if (canonical.canonicalVariantId !== selectedCanonical.canonicalVariantId) {
        fail(
          "TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_VARIANT_CONFLICT",
          [
            `DonorProduct ${donorProductId} is referenced by`,
            `${graphListingKey}:${graphComponentIndex}`,
            `as ${canonical.canonicalVariantId}`,
            `instead of ${selectedCanonical.canonicalVariantId}`,
          ].join(" "),
        );
      }
      return {
        listingKey: graphListingKey,
        componentIndex: graphComponentIndex,
        legacyComponentId: graphLegacyComponentId,
        canonicalVariantId: canonical.canonicalVariantId,
        listingScopeRowJson: graphListingScopeRowJson,
        shippingRowJson: graphShippingRowJson,
        componentRowJson: graphComponentRowJson,
      };
    },
  ).sort((left, right) =>
    left.listingKey.localeCompare(right.listingKey)
    || left.componentIndex - right.componentIndex
    || left.legacyComponentId.localeCompare(right.legacyComponentId));
  const graphKeys = donorGraph.map(
    (entry) =>
      `${entry.listingKey}:${entry.componentIndex}:${entry.legacyComponentId}`,
  );
  if (
    new Set(graphKeys).size !== graphKeys.length
    || donorGraph.filter(
      (entry) =>
        entry.listingKey === listingKey
        && entry.componentIndex === componentIndex
        && entry.legacyComponentId === legacyComponentId,
    ).length !== 1
  ) {
    fail(
      "TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_INVALID",
      "listing-bound donor graph must contain the selected component exactly once",
    );
  }
  const donorGraphSha256 = productTruthOperationalSha256(donorGraph);
  return {
    schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_LISTING_BINDING_VERSION,
    listingKey,
    channel: "walmart",
    storeIndex,
    sku,
    componentIndex,
    legacyComponentId,
    listingScopeRowJson,
    shippingRowJson,
    componentRowJson,
    donorGraph,
    donorGraphSha256,
    sha256: productTruthOperationalSha256({
      listingScopeRowJson,
      shippingRowJson,
      componentRowJson,
      donorGraphSha256,
    }),
  };
}

function parseListingBinding(
  value: unknown,
  donorProductId: string,
  donorProductRow: Record<string, unknown>,
  canonicalVariantId: string,
  canonicalIdentityHash: string,
  canonicalIdentityJson: string,
): ProductTruthTargetedWalmartListingBinding {
  if (!isRecord(value)) {
    fail(
      "TARGETED_EVIDENCE_LISTING_BINDING_INVALID",
      "listingBinding must be an object",
    );
  }
  exactKeys(value, [
    "schemaVersion", "listingKey", "channel", "storeIndex", "sku",
    "componentIndex", "legacyComponentId", "listingScopeRowJson",
    "shippingRowJson", "componentRowJson", "donorGraph",
    "donorGraphSha256", "sha256",
  ], "listingBinding");
  if (
    value.schemaVersion !== PRODUCT_TRUTH_TARGETED_WALMART_LISTING_BINDING_VERSION
    || value.channel !== "walmart"
  ) {
    fail(
      "TARGETED_EVIDENCE_LISTING_BINDING_INVALID",
      "listing binding version/channel differs",
    );
  }
  const scope = canonicalBoundRowJson(
    value.listingScopeRowJson,
    "listingBinding.listingScopeRowJson",
  );
  const shipping = canonicalBoundRowJson(
    value.shippingRowJson,
    "listingBinding.shippingRowJson",
  );
  const component = canonicalBoundRowJson(
    value.componentRowJson,
    "listingBinding.componentRowJson",
  );
  const listingKey = safeId(value.listingKey, "listingBinding.listingKey");
  const sku = exactText(value.sku, "listingBinding.sku", 300);
  const storeIndex = finiteNonNegative(value.storeIndex, "listingBinding.storeIndex");
  const componentIndex = finiteNonNegative(
    value.componentIndex,
    "listingBinding.componentIndex",
  );
  const legacyComponentId = safeId(
    value.legacyComponentId,
    "listingBinding.legacyComponentId",
  );
  const linkedDonors = [...new Set(
    [component.row.contentDonorProductId, component.row.donorProductId]
      .filter((entry): entry is string => typeof entry === "string" && Boolean(entry)),
  )];
  if (!Array.isArray(value.donorGraph)) {
    fail(
      "TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_INVALID",
      "listingBinding.donorGraph must be an array",
    );
  }
  const donorGraphRows = value.donorGraph.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(
        "TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_INVALID",
        `listingBinding.donorGraph[${index}] must be an object`,
      );
    }
    exactKeys(entry, [
      "listingKey", "componentIndex", "legacyComponentId",
      "canonicalVariantId", "listingScopeRowJson", "shippingRowJson",
      "componentRowJson",
    ], `listingBinding.donorGraph[${index}]`);
    const graphScope = canonicalBoundRowJson(
      entry.listingScopeRowJson,
      `listingBinding.donorGraph[${index}].listingScopeRowJson`,
    );
    const graphShipping = canonicalBoundRowJson(
      entry.shippingRowJson,
      `listingBinding.donorGraph[${index}].shippingRowJson`,
    );
    const graphComponent = canonicalBoundRowJson(
      entry.componentRowJson,
      `listingBinding.donorGraph[${index}].componentRowJson`,
    );
    const graphListingKey = safeId(
      entry.listingKey,
      `listingBinding.donorGraph[${index}].listingKey`,
    );
    const graphComponentIndex = finiteNonNegative(
      entry.componentIndex,
      `listingBinding.donorGraph[${index}].componentIndex`,
    );
    const graphLegacyComponentId = safeId(
      entry.legacyComponentId,
      `listingBinding.donorGraph[${index}].legacyComponentId`,
    );
    const graphCanonicalVariantId = safeId(
      entry.canonicalVariantId,
      `listingBinding.donorGraph[${index}].canonicalVariantId`,
    );
    if (
      !Number.isSafeInteger(graphComponentIndex)
      || graphScope.row.listingKey !== graphListingKey
      || Number(graphComponent.row.idx) !== graphComponentIndex
      || graphComponent.row.id !== graphLegacyComponentId
      || graphCanonicalVariantId !== canonicalVariantId
    ) {
      fail(
        "TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_INVALID",
        `listingBinding.donorGraph[${index}] scalar fields differ from sealed rows`,
      );
    }
    return {
      listingScopeRow: graphScope.row,
      shippingRow: graphShipping.row,
      componentRow: graphComponent.row,
    };
  });
  const donorGraphSha256 = exactSha(
    value.donorGraphSha256,
    "listingBinding.donorGraphSha256",
  );
  const digest = exactSha(value.sha256, "listingBinding.sha256");
  if (
    !Number.isSafeInteger(storeIndex)
    || storeIndex <= 0
    || !Number.isSafeInteger(componentIndex)
    || listingKey !== `walmart:${storeIndex}:${sku}`
    || scope.row.listingKey !== listingKey
    || scope.row.channel !== "walmart"
    || Number(scope.row.storeIndex) !== storeIndex
    || scope.row.sku !== sku
    || shipping.row.sku !== sku
    || component.row.sku !== sku
    || Number(component.row.idx) !== componentIndex
    || component.row.id !== legacyComponentId
    || linkedDonors.length !== 1
    || linkedDonors[0] !== donorProductId
    || donorGraphSha256 !== productTruthOperationalSha256(value.donorGraph)
    || digest !== productTruthOperationalSha256({
      listingScopeRowJson: scope.text,
      shippingRowJson: shipping.text,
      componentRowJson: component.text,
      donorGraphSha256,
    })
  ) {
    fail(
      "TARGETED_EVIDENCE_LISTING_BINDING_INVALID",
      "sealed rows do not prove one exact listing/component/donor relationship",
    );
  }
  const canonical = deriveProductTruthTargetedWalmartListingCanonicalIdentity({
    listingScopeRow: scope.row,
    shippingRow: shipping.row,
    componentRow: component.row,
    donorProductRow,
  });
  if (
    canonical.canonicalVariantId !== canonicalVariantId
    || canonical.identityHash !== canonicalIdentityHash
    || canonical.identityJson !== canonicalIdentityJson
  ) {
    fail(
      "TARGETED_EVIDENCE_LISTING_VARIANT_MISMATCH",
      "listing-derived variant differs from the donor snapshot target",
    );
  }
  const rebuilt = buildProductTruthTargetedWalmartListingBinding({
    listingScopeRow: scope.row,
    shippingRow: shipping.row,
    componentRow: component.row,
    donorProductRow,
    donorGraphRows,
  });
  if (
    renderProductTruthOperationalJson(rebuilt)
      !== renderProductTruthOperationalJson(value)
  ) {
    fail(
      "TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_INVALID",
      "listing-bound donor graph bytes or digests differ from the rebuilt graph",
    );
  }
  return rebuilt;
}

export function parseProductTruthTargetedWalmartDonorSnapshot(
  value: unknown,
): ProductTruthTargetedWalmartDonorSnapshot {
  if (!isRecord(value)) fail("TARGETED_EVIDENCE_INPUT_INVALID", "donorSnapshot must be an object");
  exactKeys(value, [
    "identityMode", "identityDerivationVersion", "donorProductId", "donorOfferId",
    "donorIdentityStatus", "variantDecisionId",
    "canonicalVariantId", "decisionStatus", "matcherVersion", "matcherImplementationSha256",
    "matcherReleaseSha256", "decisionEvidenceHash", "decisionEvidenceJson",
    "canonicalVariantKeyVersion",
    "canonicalIdentityHash", "canonicalIdentityJson", "retailer", "retailerProductId",
    "normalizedProductUrl", "via", "isFirstParty", "legacySnapshot",
    "listingBinding",
  ], "donorSnapshot");
  if (
    value.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
    || value.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || value.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
    || value.retailer !== "walmart"
    || value.via !== "direct"
    || value.isFirstParty !== true
  ) {
    fail("TARGETED_EVIDENCE_IDENTITY_NOT_EXACT", "donor snapshot is not a direct Walmart first-party alias");
  }
  if (
    value.identityMode !== "EXISTING_EXACT"
    && value.identityMode !== "EVIDENCE_VERIFIED_BOOTSTRAP"
    && value.identityMode !== "LISTING_BOUND_BOOTSTRAP"
  ) fail("TARGETED_EVIDENCE_IDENTITY_MODE_INVALID", "identityMode is unsupported");
  const donorProductId = safeId(value.donorProductId, "donorSnapshot.donorProductId");
  const donorOfferId = safeId(value.donorOfferId, "donorSnapshot.donorOfferId");
  const retailerProductId = exactText(value.retailerProductId, "donorSnapshot.retailerProductId", 64);
  if (!/^[0-9]{1,32}$/.test(retailerProductId)) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", "retailerProductId must be the numeric Walmart item id");
  }
  const normalizedProductUrl = normalizeExactWalmartProductUrl(
    value.normalizedProductUrl,
    retailerProductId,
  );
  const canonicalIdentityJson = exactText(value.canonicalIdentityJson, "donorSnapshot.canonicalIdentityJson", 20_000);
  let canonicalIdentity: unknown;
  try {
    canonicalIdentity = JSON.parse(canonicalIdentityJson);
  } catch {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", "canonicalIdentityJson must be JSON");
  }
  if (!isRecord(canonicalIdentity)) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", "canonicalIdentityJson must encode an object");
  }
  exactKeys(canonicalIdentity, [
    "schemaVersion", "brand", "productLine", "flavor", "modifiers", "form",
    "size", "outerPackCount",
  ], "donorSnapshot.canonicalIdentityJson");
  if (
    canonicalIdentity.schemaVersion !== CANONICAL_PRODUCT_VARIANT_IDENTITY_VERSION
    || typeof canonicalIdentity.brand !== "string"
    || !canonicalIdentity.brand
    || ![canonicalIdentity.productLine, canonicalIdentity.flavor, canonicalIdentity.form]
      .every((field) => field === null || (typeof field === "string" && field.length > 0))
    || !Array.isArray(canonicalIdentity.modifiers)
    || canonicalIdentity.modifiers.some((field) => typeof field !== "string" || !field)
    || JSON.stringify(canonicalIdentity.modifiers)
      !== JSON.stringify([...canonicalIdentity.modifiers].sort())
    || new Set(canonicalIdentity.modifiers).size !== canonicalIdentity.modifiers.length
    || !isRecord(canonicalIdentity.size)
    || !Number.isFinite(canonicalIdentity.size.baseAmount)
    || Number(canonicalIdentity.size.baseAmount) <= 0
    || !["g", "ml", "count"].includes(String(canonicalIdentity.size.baseUnit))
    || !["MASS", "VOLUME", "COUNT"].includes(String(canonicalIdentity.size.dimension))
    || (canonicalIdentity.size.dimension === "MASS" && canonicalIdentity.size.baseUnit !== "g")
    || (canonicalIdentity.size.dimension === "VOLUME" && canonicalIdentity.size.baseUnit !== "ml")
    || (canonicalIdentity.size.dimension === "COUNT" && canonicalIdentity.size.baseUnit !== "count")
    || canonicalIdentity.outerPackCount !== 1
    || (!canonicalIdentity.productLine && !canonicalIdentity.flavor && !canonicalIdentity.form)
    || JSON.stringify(canonicalIdentity) !== canonicalIdentityJson
  ) {
    fail(
      "TARGETED_EVIDENCE_IDENTITY_NOT_CANONICAL",
      "canonical identity bytes do not match the exact normalized identity schema",
    );
  }
  exactKeys(canonicalIdentity.size, ["dimension", "baseAmount", "baseUnit"], "canonicalIdentity.size");
  const canonicalIdentityHash = exactSha(value.canonicalIdentityHash, "donorSnapshot.canonicalIdentityHash");
  let rebuiltIdentity;
  try {
    rebuiltIdentity = buildCanonicalProductVariantKey({
      brand: canonicalIdentity.brand,
      productLine: canonicalIdentity.productLine as string | null,
      flavor: canonicalIdentity.flavor as string | null,
      modifiers: canonicalModifierInputs(canonicalIdentity.modifiers as string[]),
      form: canonicalIdentity.form as string | null,
      size: `${String(canonicalIdentity.size.baseAmount)} ${String(canonicalIdentity.size.baseUnit)}`,
      outerPackCount: Number(canonicalIdentity.outerPackCount),
    });
  } catch {
    fail("TARGETED_EVIDENCE_IDENTITY_NOT_CANONICAL", "derived identity cannot rebuild under the current canonical key contract");
  }
  if (
    sha256(canonicalIdentityJson) !== canonicalIdentityHash
    || rebuiltIdentity.identityJson !== canonicalIdentityJson
    || rebuiltIdentity.identityHash !== canonicalIdentityHash
  ) {
    fail("TARGETED_EVIDENCE_IDENTITY_HASH_MISMATCH", "canonical identity bytes differ from their DB hash");
  }
  if (
    value.canonicalVariantId !== `cpv1:${canonicalIdentityHash}`
    || rebuiltIdentity.canonicalVariantId !== value.canonicalVariantId
    || value.canonicalVariantKeyVersion !== CANONICAL_PRODUCT_VARIANT_KEY_VERSION
  ) {
    fail(
      "TARGETED_EVIDENCE_IDENTITY_NOT_CANONICAL",
      "canonical identity bytes/id/key version differ from the current exact DB contract",
    );
  }
  const common = {
    donorProductId,
    donorOfferId,
    canonicalVariantId: safeId(value.canonicalVariantId, "donorSnapshot.canonicalVariantId"),
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    canonicalVariantKeyVersion: exactText(value.canonicalVariantKeyVersion, "donorSnapshot.canonicalVariantKeyVersion", 120),
    canonicalIdentityHash,
    canonicalIdentityJson,
    retailer: "walmart" as const,
    retailerProductId,
    normalizedProductUrl,
    via: "direct" as const,
    isFirstParty: true as const,
  };
  if (value.identityMode === "EXISTING_EXACT") {
    if (
      value.identityDerivationVersion !== null
      ||
      value.donorIdentityStatus !== "exact_confirmed"
      || value.decisionStatus !== "exact_confirmed"
      || value.legacySnapshot !== null
      || value.listingBinding !== null
    ) {
      fail("TARGETED_EVIDENCE_IDENTITY_NOT_EXACT", "existing mode requires one exact alias and no legacy snapshot");
    }
    const decisionEvidence = parseExactDecisionEvidence({
      evidenceHash: value.decisionEvidenceHash,
      evidenceJson: value.decisionEvidenceJson,
    });
    return {
      ...common,
      identityMode: "EXISTING_EXACT",
      identityDerivationVersion: null,
      donorIdentityStatus: "exact_confirmed",
      variantDecisionId: safeId(value.variantDecisionId, "donorSnapshot.variantDecisionId"),
      decisionStatus: "exact_confirmed",
      decisionEvidenceHash: decisionEvidence.evidenceHash,
      decisionEvidenceJson: decisionEvidence.evidenceJson,
      legacySnapshot: null,
      listingBinding: null,
    };
  }
  const legacySnapshot = parseLegacySnapshot(
    value.legacySnapshot,
    donorProductId,
    donorOfferId,
    retailerProductId,
    normalizedProductUrl,
  );
  if (
    !["candidate", "legacy_unverified"].includes(String(value.donorIdentityStatus))
    || value.variantDecisionId !== null
    || value.decisionStatus !== null
    || value.decisionEvidenceHash !== null
    || value.decisionEvidenceJson !== null
  ) {
    fail(
      "TARGETED_EVIDENCE_BOOTSTRAP_STATE_INVALID",
      "bootstrap mode requires an unconfirmed donor and no pre-existing decision",
    );
  }
  if (value.identityMode === "LISTING_BOUND_BOOTSTRAP") {
    if (
      value.identityDerivationVersion
        !== PRODUCT_TRUTH_TARGETED_WALMART_LISTING_IDENTITY_DERIVATION_VERSION
    ) {
      fail(
        "TARGETED_EVIDENCE_BOOTSTRAP_STATE_INVALID",
        "listing-bound bootstrap derivation version differs",
      );
    }
    const product = canonicalBoundRowJson(
      legacySnapshot.donorProductRowJson,
      "legacySnapshot.donorProductRowJson",
    );
    return {
      ...common,
      identityMode: "LISTING_BOUND_BOOTSTRAP",
      identityDerivationVersion:
        PRODUCT_TRUTH_TARGETED_WALMART_LISTING_IDENTITY_DERIVATION_VERSION,
      donorIdentityStatus: value.donorIdentityStatus as "candidate" | "legacy_unverified",
      variantDecisionId: null,
      decisionStatus: null,
      decisionEvidenceHash: null,
      decisionEvidenceJson: null,
      legacySnapshot,
      listingBinding: parseListingBinding(
        value.listingBinding,
        donorProductId,
        product.row,
        common.canonicalVariantId,
        canonicalIdentityHash,
        canonicalIdentityJson,
      ),
    };
  }
  if (
    value.identityDerivationVersion
      !== PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION
    || value.listingBinding !== null
  ) {
    fail(
      "TARGETED_EVIDENCE_BOOTSTRAP_STATE_INVALID",
      "legacy bootstrap derivation/listing binding differs",
    );
  }
  return {
    ...common,
    identityMode: "EVIDENCE_VERIFIED_BOOTSTRAP",
    identityDerivationVersion:
      PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION,
    donorIdentityStatus: value.donorIdentityStatus as "candidate" | "legacy_unverified",
    variantDecisionId: null,
    decisionStatus: null,
    decisionEvidenceHash: null,
    decisionEvidenceJson: null,
    legacySnapshot,
    listingBinding: null,
  };
}

export function targetedWalmartDonorSnapshotSha256(
  snapshot: ProductTruthTargetedWalmartDonorSnapshot,
): string {
  return productTruthOperationalSha256(parseProductTruthTargetedWalmartDonorSnapshot(snapshot));
}

function exactProviderCeilings(value: unknown): ProductTruthProviderCeiling[] {
  if (!Array.isArray(value) || value.length !== 2) {
    fail("TARGETED_EVIDENCE_BUDGET_INVALID", "providerCeilings must contain exactly Oxylabs and Unwrangle");
  }
  const rows = value.map((raw, index) => {
    if (!isRecord(raw)) fail("TARGETED_EVIDENCE_BUDGET_INVALID", `providerCeilings[${index}] must be an object`);
    exactKeys(raw, ["provider", "operations", "maxCalls", "maxUnits", "reserveFloor"], `providerCeilings[${index}]`);
    if (!Array.isArray(raw.operations) || raw.operations.some((entry) => typeof entry !== "string")) {
      fail("TARGETED_EVIDENCE_BUDGET_INVALID", `providerCeilings[${index}].operations must be a string array`);
    }
    return {
      provider: raw.provider,
      operations: raw.operations,
      maxCalls: raw.maxCalls,
      maxUnits: raw.maxUnits,
      reserveFloor: raw.reserveFloor,
    };
  }).sort((left, right) => String(left.provider).localeCompare(String(right.provider), "en-US"));
  const oxylabs = rows[0];
  const unwrangle = rows[1];
  if (
    oxylabs?.provider !== "oxylabs"
    || JSON.stringify(oxylabs.operations) !== JSON.stringify(["query"])
    || oxylabs.maxCalls !== 1
    || oxylabs.maxUnits !== 1
    || oxylabs.reserveFloor !== null
  ) {
    fail("TARGETED_EVIDENCE_BUDGET_INVALID", "Oxylabs ceiling must be query/maxCalls=1/maxUnits=1");
  }
  if (
    unwrangle?.provider !== "unwrangle"
    || JSON.stringify(unwrangle.operations) !== JSON.stringify(["detail"])
    || unwrangle.maxCalls !== 1
    || unwrangle.maxUnits !== 2.5
    || typeof unwrangle.reserveFloor !== "number"
    || !Number.isFinite(unwrangle.reserveFloor)
    || unwrangle.reserveFloor < 0
  ) {
    fail("TARGETED_EVIDENCE_BUDGET_INVALID", "Unwrangle ceiling must be detail/maxCalls=1/maxUnits=2.5 with reserveFloor");
  }
  return rows as ProductTruthProviderCeiling[];
}

function parseRequest(value: unknown): ProductTruthTargetedWalmartEvidencePlanRequest {
  if (!isRecord(value)) fail("TARGETED_EVIDENCE_INPUT_INVALID", "request must be an object");
  exactKeys(value, [
    "schemaVersion", "runId", "createdAt", "expiresAt", "expectedTargetFingerprint",
    "engineReleaseSha256", "schemaFingerprintSha256", "migrationSetSha256", "matcherVersion",
    "matcherImplementationSha256", "matcherReleaseSha256", "query",
    "donorSnapshot", "donorSnapshotSha256", "providerCeilings", "verificationPolicy",
    "maxWallClockMs",
  ], "request");
  if (value.schemaVersion !== PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", `request must use ${PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION}`);
  }
  if (
    value.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
    || value.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || value.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
  ) {
    fail(
      "TARGETED_EVIDENCE_MATCHER_PROVENANCE_MISMATCH",
      "request is not bound to the current certified matcher release",
    );
  }
  const createdAt = exactInstant(value.createdAt, "request.createdAt");
  const expiresAt = exactInstant(value.expiresAt, "request.expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1_000) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", "request lifetime must be positive and at most 24 hours");
  }
  const donorSnapshot = parseProductTruthTargetedWalmartDonorSnapshot(value.donorSnapshot);
  const donorSnapshotSha256 = exactSha(value.donorSnapshotSha256, "request.donorSnapshotSha256");
  if (targetedWalmartDonorSnapshotSha256(donorSnapshot) !== donorSnapshotSha256) {
    fail("TARGETED_EVIDENCE_DONOR_SNAPSHOT_MISMATCH", "donor snapshot SHA does not match its exact contents");
  }
  if (!isRecord(value.verificationPolicy)) {
    fail("TARGETED_EVIDENCE_INPUT_INVALID", "verificationPolicy must be an object");
  }
  exactKeys(value.verificationPolicy, ["procurementZip", "maxPriceAgeMs", "minGalleryImages"], "verificationPolicy");
  if (
    value.verificationPolicy.procurementZip !== "33765"
    || value.verificationPolicy.maxPriceAgeMs !== TARGETED_WALMART_PRICE_TTL_MS
    || value.verificationPolicy.minGalleryImages !== TARGETED_WALMART_MIN_IMAGES
  ) {
    fail("TARGETED_EVIDENCE_POLICY_INVALID", "ZIP 33765, 24h TTL and two images are fixed");
  }
  return {
    schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
    runId: safeId(value.runId, "request.runId"),
    createdAt,
    expiresAt,
    expectedTargetFingerprint: exactSha(value.expectedTargetFingerprint, "request.expectedTargetFingerprint"),
    engineReleaseSha256: exactSha(value.engineReleaseSha256, "request.engineReleaseSha256"),
    schemaFingerprintSha256: exactSha(value.schemaFingerprintSha256, "request.schemaFingerprintSha256"),
    migrationSetSha256: exactSha(value.migrationSetSha256, "request.migrationSetSha256"),
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    query: exactText(value.query, "request.query", 300),
    donorSnapshot,
    donorSnapshotSha256,
    providerCeilings: exactProviderCeilings(value.providerCeilings),
    verificationPolicy: {
      procurementZip: "33765",
      maxPriceAgeMs: TARGETED_WALMART_PRICE_TTL_MS,
      minGalleryImages: TARGETED_WALMART_MIN_IMAGES,
    },
    maxWallClockMs: value.maxWallClockMs === TARGETED_WALMART_MAX_WALL_CLOCK_MS
      ? TARGETED_WALMART_MAX_WALL_CLOCK_MS
      : fail(
        "TARGETED_EVIDENCE_POLICY_INVALID",
        `maxWallClockMs must be exactly ${TARGETED_WALMART_MAX_WALL_CLOCK_MS}`,
      ),
  };
}

/**
 * Public strict verifier for custody/worker boundaries. It exposes no new
 * execution authority; callers receive only the byte-canonical one-donor
 * request already accepted by the frozen targeted-evidence planner.
 */
export function parseProductTruthTargetedWalmartEvidenceRequest(
  value: unknown,
): ProductTruthTargetedWalmartEvidencePlanRequest {
  return parseRequest(value);
}

export function buildProductTruthTargetedWalmartEvidenceRequest(input: {
  runId: string;
  createdAt: string;
  expiresAt: string;
  targetFingerprint: string;
  engineReleaseSha256: string;
  schemaFingerprintSha256: string;
  migrationSetSha256: string;
  query: string;
  donorSnapshot: unknown;
  unwrangleReserveFloor: number;
}): ProductTruthTargetedWalmartEvidencePlanRequest {
  const donorSnapshot = parseProductTruthTargetedWalmartDonorSnapshot(input.donorSnapshot);
  return parseRequest({
    schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
    runId: input.runId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    expectedTargetFingerprint: input.targetFingerprint,
    engineReleaseSha256: input.engineReleaseSha256,
    schemaFingerprintSha256: input.schemaFingerprintSha256,
    migrationSetSha256: input.migrationSetSha256,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    query: input.query,
    donorSnapshot,
    donorSnapshotSha256: targetedWalmartDonorSnapshotSha256(donorSnapshot),
    providerCeilings: [
      {
        provider: "oxylabs",
        operations: ["query"],
        maxCalls: 1,
        maxUnits: 1,
        reserveFloor: null,
      },
      {
        provider: "unwrangle",
        operations: ["detail"],
        maxCalls: 1,
        maxUnits: 2.5,
        reserveFloor: input.unwrangleReserveFloor,
      },
    ],
    verificationPolicy: {
      procurementZip: "33765",
      maxPriceAgeMs: TARGETED_WALMART_PRICE_TTL_MS,
      minGalleryImages: TARGETED_WALMART_MIN_IMAGES,
    },
    maxWallClockMs: TARGETED_WALMART_MAX_WALL_CLOCK_MS,
  });
}

export function buildProductTruthTargetedWalmartEvidencePlan(input: {
  request: unknown;
  actualTargetFingerprint: string;
  actualEngineReleaseSha256: string;
  actualSchemaFingerprintSha256: string;
  actualMigrationSetSha256: string;
  /** Exact snapshot returned by readTargetedWalmartDonorSnapshot. */
  actualDonorSnapshot: unknown;
  actualDetailHarvestStateAbsent: boolean;
}): ProductTruthTargetedWalmartEvidencePlan {
  const request = parseRequest(input.request);
  const targetFingerprint = exactSha(input.actualTargetFingerprint, "actualTargetFingerprint");
  const engineReleaseSha256 = exactSha(input.actualEngineReleaseSha256, "actualEngineReleaseSha256");
  const schemaFingerprintSha256 = exactSha(
    input.actualSchemaFingerprintSha256,
    "actualSchemaFingerprintSha256",
  );
  const migrationSetSha256 = exactSha(input.actualMigrationSetSha256, "actualMigrationSetSha256");
  const actualDonorSnapshot = parseProductTruthTargetedWalmartDonorSnapshot(
    input.actualDonorSnapshot,
  );
  if (
    request.donorSnapshot.identityMode === "EVIDENCE_VERIFIED_BOOTSTRAP"
    || actualDonorSnapshot.identityMode === "EVIDENCE_VERIFIED_BOOTSTRAP"
  ) {
    fail(
      "TARGETED_EVIDENCE_UNBOUND_BOOTSTRAP_RETIRED",
      "new bootstrap plans must be bound to one authoritative listing component",
    );
  }
  if (request.expectedTargetFingerprint !== targetFingerprint) {
    fail("TARGETED_EVIDENCE_TARGET_MISMATCH", "request is bound to another database target");
  }
  if (request.engineReleaseSha256 !== engineReleaseSha256) {
    fail("TARGETED_EVIDENCE_RELEASE_MISMATCH", "request is bound to another frozen source release");
  }
  if (request.schemaFingerprintSha256 !== schemaFingerprintSha256) {
    fail("TARGETED_EVIDENCE_SCHEMA_MISMATCH", "request is bound to another exact schema fingerprint");
  }
  if (request.migrationSetSha256 !== migrationSetSha256) {
    fail("TARGETED_EVIDENCE_MIGRATION_SET_MISMATCH", "request is bound to another migration release");
  }
  if (
    targetedWalmartDonorSnapshotSha256(actualDonorSnapshot) !== request.donorSnapshotSha256
    || renderProductTruthOperationalJson(actualDonorSnapshot)
      !== renderProductTruthOperationalJson(request.donorSnapshot)
  ) {
    fail(
      "TARGETED_EVIDENCE_DONOR_SNAPSHOT_MISMATCH",
      "request differs from the exact current DB donor graph",
    );
  }
  if (input.actualDetailHarvestStateAbsent !== true) {
    fail(
      "TARGETED_EVIDENCE_PRIOR_HARVEST_STATE_FORBIDDEN",
      "target already has a detail-harvest lifecycle; automatic paid replay is forbidden",
    );
  }
  const target: ProductTruthTargetedWalmartEvidenceTarget = {
    ordinal: 0,
    ...request.donorSnapshot,
    query: request.query,
    donorSnapshotSha256: request.donorSnapshotSha256,
  };
  const targetSetSha256 = productTruthOperationalSha256([target]);
  return {
    schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
    runId: request.runId,
    mode: "WAVE",
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    targetFingerprint,
    engineReleaseSha256,
    schemaFingerprintSha256,
    migrationSetSha256,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    manifest: {
      schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_SCOPE_VERSION,
      sha256: request.donorSnapshotSha256,
      asOf: request.createdAt,
      donorCount: 1,
    },
    targetSetSha256,
    targets: [target],
    sourcePolicy: {
      procurementZip: "33765",
      retailers: ["walmart"],
      allowClubs: false,
      allowBjs: false,
      listingConcurrency: 1,
      componentConcurrency: 1,
      maxAttemptsPerListing: 1,
      allowOpenFoodFactsSupplement: false,
    },
    providerCeilings: request.providerCeilings,
    verificationPolicy: request.verificationPolicy,
    maxWallClockMs: request.maxWallClockMs,
    claims: {
      identityMode: target.identityMode,
      exactOneExistingDonor: true,
      exactOneExistingDirectFirstPartyWalmartOffer: true,
      initialDetailHarvestStateAbsent: true,
      canonicalVariantWritesMax: target.identityMode === "LISTING_BOUND_BOOTSTRAP" ? 1 : 0,
      variantDecisionWritesMax: target.identityMode === "LISTING_BOUND_BOOTSTRAP" ? 1 : 0,
      targetProductProjectionMayChange: target.identityMode === "LISTING_BOUND_BOOTSTRAP",
      unrelatedOfferWrites: false,
      unrelatedProductWrites: false,
      openFoodFactsCalls: false,
      clubCalls: false,
      bjsCalls: false,
      automaticReplay: false,
      automaticPublish: false,
      automaticDelist: false,
      automaticReprice: false,
      automaticPurchase: false,
    },
  };
}

export function parseProductTruthTargetedWalmartEvidencePlan(
  value: unknown,
): ProductTruthTargetedWalmartEvidencePlan {
  if (!isRecord(value)) fail("TARGETED_EVIDENCE_PLAN_INVALID", "plan must be an object");
  exactKeys(value, [
    "schemaVersion", "runId", "mode", "createdAt", "expiresAt", "targetFingerprint",
    "engineReleaseSha256", "schemaFingerprintSha256", "migrationSetSha256", "matcherVersion",
    "matcherImplementationSha256", "matcherReleaseSha256",
    "manifest", "targetSetSha256", "targets", "sourcePolicy", "providerCeilings",
    "verificationPolicy", "maxWallClockMs", "claims",
  ], "plan");
  if (value.schemaVersion !== PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION) {
    fail("TARGETED_EVIDENCE_PLAN_INVALID", `plan must use ${PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION}`);
  }
  // Rebuild through the request parser so every nested policy remains canonical.
  if (!Array.isArray(value.targets) || value.targets.length !== 1 || !isRecord(value.targets[0])) {
    fail("TARGETED_EVIDENCE_PLAN_INVALID", "plan must contain exactly one donor target");
  }
  const rawTarget = value.targets[0];
  exactKeys(rawTarget, [
    "ordinal", "identityMode", "identityDerivationVersion", "donorProductId",
    "donorOfferId", "donorIdentityStatus", "variantDecisionId",
    "canonicalVariantId", "decisionStatus", "matcherVersion", "matcherImplementationSha256",
    "matcherReleaseSha256", "decisionEvidenceHash", "decisionEvidenceJson",
    "canonicalVariantKeyVersion",
    "canonicalIdentityHash", "canonicalIdentityJson", "retailer", "retailerProductId",
    "normalizedProductUrl", "via", "isFirstParty", "legacySnapshot",
    "listingBinding", "query", "donorSnapshotSha256",
  ], "plan.targets[0]");
  if (rawTarget.ordinal !== 0) fail("TARGETED_EVIDENCE_PLAN_INVALID", "target ordinal must be zero");
  const donorSnapshot = parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: rawTarget.identityMode,
    identityDerivationVersion: rawTarget.identityDerivationVersion,
    donorProductId: rawTarget.donorProductId,
    donorOfferId: rawTarget.donorOfferId,
    donorIdentityStatus: rawTarget.donorIdentityStatus,
    variantDecisionId: rawTarget.variantDecisionId,
    canonicalVariantId: rawTarget.canonicalVariantId,
    decisionStatus: rawTarget.decisionStatus,
    matcherVersion: rawTarget.matcherVersion,
    matcherImplementationSha256: rawTarget.matcherImplementationSha256,
    matcherReleaseSha256: rawTarget.matcherReleaseSha256,
    decisionEvidenceHash: rawTarget.decisionEvidenceHash,
    decisionEvidenceJson: rawTarget.decisionEvidenceJson,
    canonicalVariantKeyVersion: rawTarget.canonicalVariantKeyVersion,
    canonicalIdentityHash: rawTarget.canonicalIdentityHash,
    canonicalIdentityJson: rawTarget.canonicalIdentityJson,
    retailer: rawTarget.retailer,
    retailerProductId: rawTarget.retailerProductId,
    normalizedProductUrl: rawTarget.normalizedProductUrl,
    via: rawTarget.via,
    isFirstParty: rawTarget.isFirstParty,
    legacySnapshot: rawTarget.legacySnapshot,
    listingBinding: rawTarget.listingBinding,
  });
  const request: ProductTruthTargetedWalmartEvidencePlanRequest = {
    schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
    runId: value.runId as string,
    createdAt: value.createdAt as string,
    expiresAt: value.expiresAt as string,
    expectedTargetFingerprint: value.targetFingerprint as string,
    engineReleaseSha256: value.engineReleaseSha256 as string,
    schemaFingerprintSha256: value.schemaFingerprintSha256 as string,
    migrationSetSha256: value.migrationSetSha256 as string,
    matcherVersion: value.matcherVersion as typeof CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: value.matcherImplementationSha256 as typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: value.matcherReleaseSha256 as typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    query: rawTarget.query as string,
    donorSnapshot,
    donorSnapshotSha256: rawTarget.donorSnapshotSha256 as string,
    providerCeilings: value.providerCeilings as ProductTruthProviderCeiling[],
    verificationPolicy: value.verificationPolicy as ProductTruthTargetedWalmartEvidencePlanRequest["verificationPolicy"],
    maxWallClockMs: value.maxWallClockMs as typeof TARGETED_WALMART_MAX_WALL_CLOCK_MS,
  };
  const rebuilt = buildProductTruthTargetedWalmartEvidencePlan({
    request,
    actualTargetFingerprint: request.expectedTargetFingerprint,
    actualEngineReleaseSha256: request.engineReleaseSha256,
    actualSchemaFingerprintSha256: request.schemaFingerprintSha256,
    actualMigrationSetSha256: request.migrationSetSha256,
    actualDonorSnapshot: donorSnapshot,
    actualDetailHarvestStateAbsent: true,
  });
  if (
    value.mode !== "WAVE"
    || value.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
    || value.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || value.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
  ) {
    fail("TARGETED_EVIDENCE_PLAN_INVALID", "targeted evidence plan mode/matcher is not canonical");
  }
  if (renderProductTruthOperationalJson(rebuilt) !== renderProductTruthOperationalJson(value)) {
    fail("TARGETED_EVIDENCE_PLAN_INVALID", "plan differs from the canonical targeted evidence contract");
  }
  return rebuilt;
}

function allowanceMatches(
  permit: MeteredRunPermit,
  plan: ProductTruthTargetedWalmartEvidencePlan,
): boolean {
  const entries = Object.entries(permit.providers).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length !== plan.providerCeilings.length) return false;
  return plan.providerCeilings.every((ceiling) => {
    const allowance = permit.providers[ceiling.provider];
    if (!allowance) return false;
    return JSON.stringify([...new Set(allowance.operations)].sort()) === JSON.stringify(ceiling.operations)
      && allowance.maxCalls === ceiling.maxCalls
      && (allowance.maxUnits ?? null) === ceiling.maxUnits;
  });
}

export function validateProductTruthTargetedWalmartEvidenceApproval(input: {
  plan: ProductTruthTargetedWalmartEvidencePlan;
  planSha256: string;
  approval: unknown;
  executionConfirmation: string;
  now: string;
}): ValidatedProductTruthOperationalApproval {
  const plan = parseProductTruthTargetedWalmartEvidencePlan(input.plan);
  const planSha256 = exactSha(input.planSha256, "planSha256");
  if (productTruthOperationalSha256(plan) !== planSha256) {
    fail("TARGETED_EVIDENCE_PLAN_HASH_MISMATCH", "plan SHA differs from canonical contents");
  }
  if (!isRecord(input.approval)) fail("TARGETED_EVIDENCE_APPROVAL_INVALID", "approval must be an object");
  exactKeys(input.approval, [
    "schemaVersion", "approvedBy", "runId", "approvalId", "action", "planSha256",
    "targetFingerprint", "issuedAt", "expiresAt", "meteredPermit", "balanceEvidence",
  ], "approval");
  const approval = input.approval as unknown as ProductTruthOperationalApproval;
  if (
    approval.schemaVersion !== PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION
    || approval.approvedBy !== "owner"
    || approval.action !== "EXECUTE_WAVE"
    || approval.runId !== plan.runId
    || approval.planSha256 !== planSha256
    || approval.targetFingerprint !== plan.targetFingerprint
  ) {
    fail("TARGETED_EVIDENCE_APPROVAL_SCOPE_MISMATCH", "approval does not bind the exact targeted plan/run/DB");
  }
  const approvalId = safeId(approval.approvalId, "approval.approvalId");
  const issuedAt = exactInstant(approval.issuedAt, "approval.issuedAt");
  const expiresAt = exactInstant(approval.expiresAt, "approval.expiresAt");
  const now = exactInstant(input.now, "now");
  if (
    Date.parse(issuedAt) > Date.parse(now)
    || Date.parse(expiresAt) <= Date.parse(now)
    || Date.parse(expiresAt) > Date.parse(plan.expiresAt)
  ) {
    fail("TARGETED_EVIDENCE_APPROVAL_NOT_CURRENT", "approval is not current or outlives the plan");
  }
  const expectedConfirmation = expectedProductTruthExecutionConfirmation(planSha256, approvalId);
  if (input.executionConfirmation !== expectedConfirmation) {
    fail("TARGETED_EVIDENCE_APPROVAL_CONFIRMATION_MISMATCH", "exact execution confirmation is required");
  }
  const encodedPermit = Buffer.from(JSON.stringify(approval.meteredPermit), "utf8").toString("base64url");
  const permit = decodeMeteredRunPermit(encodedPermit);
  if (
    !permit
    || permit.runId !== plan.runId
    || permit.approvalId !== approvalId
    || permit.issuedAt !== issuedAt
    || permit.expiresAt !== expiresAt
    || !allowanceMatches(permit, plan)
  ) {
    fail("TARGETED_EVIDENCE_APPROVAL_PERMIT_MISMATCH", "metered permit differs from the exact two-provider plan");
  }
  if (!Array.isArray(approval.balanceEvidence) || approval.balanceEvidence.length !== 1) {
    fail("TARGETED_EVIDENCE_BALANCE_REQUIRED", "one fresh Unwrangle balance observation is required");
  }
  const balance = approval.balanceEvidence[0];
  if (balance.provider !== "unwrangle") {
    fail("TARGETED_EVIDENCE_BALANCE_REQUIRED", "balance evidence must be Unwrangle");
  }
  const observedAt = exactInstant(balance.observedAt, "balanceEvidence.observedAt");
  const unwrangle = plan.providerCeilings.find((row) => row.provider === "unwrangle")!;
  const balanceUnits = finiteNonNegative(balance.balanceUnits, "balanceEvidence.balanceUnits");
  const reserveFloor = finiteNonNegative(balance.reserveFloor, "balanceEvidence.reserveFloor");
  exactSha(balance.evidenceSha256, "balanceEvidence.evidenceSha256");
  if (
    Date.parse(observedAt) > Date.parse(now)
    || Date.parse(now) - Date.parse(observedAt) > 10 * 60 * 1_000
    || reserveFloor !== unwrangle.reserveFloor
    || balanceUnits - (unwrangle.maxUnits ?? 0) < reserveFloor
  ) {
    fail("TARGETED_EVIDENCE_BALANCE_INVALID", "balance evidence is stale or violates the sealed reserve floor");
  }
  return {
    approval,
    permit,
    encodedPermit,
    meteredConfirmation: expectedMeteredRunConfirmation(permit),
    executionConfirmation: expectedConfirmation,
  };
}

export function canonicalIdentityFromTarget(
  target: ProductTruthTargetedWalmartEvidenceTarget,
): CanonicalProductIdentity {
  let identity: Record<string, unknown>;
  try {
    identity = JSON.parse(target.canonicalIdentityJson) as Record<string, unknown>;
  } catch {
    fail("TARGETED_EVIDENCE_IDENTITY_INVALID", "sealed canonical identity JSON is not readable");
  }
  const size = isRecord(identity.size)
    ? `${String(identity.size.baseAmount)} ${String(identity.size.baseUnit)}`
    : null;
  return {
    brand: typeof identity.brand === "string" ? identity.brand : null,
    productLine: typeof identity.productLine === "string" ? identity.productLine : null,
    flavor: typeof identity.flavor === "string" ? identity.flavor : null,
    modifiers: Array.isArray(identity.modifiers)
      ? canonicalModifierInputs(
          identity.modifiers.filter((item): item is string => typeof item === "string"),
        )
      : null,
    form: typeof identity.form === "string" ? identity.form : null,
    size,
    outerPackCount: typeof identity.outerPackCount === "number" ? identity.outerPackCount : null,
  };
}

/**
 * Canonical identity JSON is token-normalized and may sort a multi-word brand
 * for deterministic hashing. Title proof, however, must use the original
 * listing-bound brand phrase ("Pepperidge Farm", not "farm pepperidge").
 * The listing binding already proves that the raw phrase rebuilds to the same
 * canonical ID, so restoring that phrase changes no identity or write target.
 */
export function canonicalMatchIdentityFromTarget(
  target: ProductTruthTargetedWalmartEvidenceTarget,
): CanonicalProductIdentity {
  const canonical = canonicalIdentityFromTarget(target);
  if (
    target.identityMode !== "LISTING_BOUND_BOOTSTRAP"
    || !target.legacySnapshot
  ) return canonical;
  const product = canonicalBoundRowJson(
    target.legacySnapshot.donorProductRowJson,
    "legacySnapshot.donorProductRowJson",
  );
  const rawBrand = nullableIdentityText(product.row.brand);
  if (!rawBrand) {
    fail(
      "TARGETED_EVIDENCE_LISTING_IDENTITY_INCOMPLETE",
      "listing-bound donor brand is missing",
    );
  }
  return { ...canonical, brand: rawBrand };
}
