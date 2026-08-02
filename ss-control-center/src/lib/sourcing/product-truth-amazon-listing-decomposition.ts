import { createHash } from "node:crypto";

import {
  PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION,
  renderProductTruthAmazonCatalogCapturePlan,
  renderProductTruthAmazonCatalogListingEvidence,
  validateProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogListingEvidence,
} from "./product-truth-amazon-catalog-evidence";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import { renderProductTruthOperationalJson } from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_AMAZON_LISTING_DECOMPOSITION_VERSION =
  "product-truth-amazon-listing-decomposition/1.0.0" as const;

type JsonObject = Record<string, unknown>;

export interface ProductTruthAmazonStructuralSignal {
  kind:
    | "CATALOG_BRAND"
    | "CATALOG_MANUFACTURER"
    | "CATALOG_FLAVOR"
    | "CATALOG_ITEM_FORM"
    | "CATALOG_SIZE"
    | "CATALOG_OUTER_COUNT"
    | "CATALOG_EACH_COUNT"
    | "CATALOG_UNIT_COUNT"
    | "TITLE_OUTER_COUNT"
    | "TITLE_TOTAL_COUNT"
    | "TITLE_COUNT";
  sourcePath: string;
  value: string | number;
  unit: string | null;
  authority: "STRUCTURED_MARKETPLACE_EVIDENCE" | "TITLE_CLAIM_ONLY";
}

export interface ProductTruthAmazonExistingCatalogCandidate {
  donorProductId: string;
  title: string;
  brand: string;
  size: string | null;
  upc: string | null;
  gtin: string | null;
  canonicalVariantId: string | null;
  eligibleFirstPartyRetailers: string[];
  sharedIdentityTokens: string[];
  candidateIdentityTokens: string[];
  countCompatibility: "MATCH" | "UNKNOWN";
  retrievalScoreMillis: number;
  exactIdentityProven: false;
  authorizesCanonicalMaterialization: false;
}

export interface ProductTruthAmazonListingDecompositionEntry {
  ordinal: number;
  listingKey: string;
  storeIndex: number;
  sku: string;
  asin: string;
  listingTitle: string;
  signals: ProductTruthAmazonStructuralSignal[];
  blockerCodes: Array<
    | "CATALOG_BRAND_MANUFACTURER_CONFLICT"
    | "OUTER_COUNT_CONFLICT"
    | "NO_CATALOG_BRAND_OR_MANUFACTURER"
    | "NO_ALLOWED_EXISTING_CATALOG_CANDIDATE"
    | "EXACT_COMPONENT_IDENTITY_NOT_PROVEN"
  >;
  status:
    | "CONTRADICTORY_CATALOG_STRUCTURE"
    | "NO_ALLOWED_EXISTING_CATALOG_CANDIDATE"
    | "CANDIDATES_REQUIRE_EXACT_ADJUDICATION";
  candidates: ProductTruthAmazonExistingCatalogCandidate[];
  claims: {
    outerIdentifiersUsedAsBaseUnitProof: false;
    titleOnlyIdentityProof: false;
    exactComponentIdentityProven: false;
    authorizesCanonicalMaterialization: false;
  };
}

export interface ProductTruthAmazonListingDecomposition {
  schemaVersion: typeof PRODUCT_TRUTH_AMAZON_LISTING_DECOMPOSITION_VERSION;
  compiledAt: string;
  source: {
    planSha256: string;
    evidenceSha256: string;
    legacySnapshotSha256: string;
    manifestSha256: string;
    targetSetSha256: string;
  };
  entries: ProductTruthAmazonListingDecompositionEntry[];
  counts: {
    targets: number;
    contradictory: number;
    withoutAllowedCandidate: number;
    candidatesRequireExactAdjudication: number;
    exactComponentIdentityProven: 0;
    canonicalMaterializationsAuthorized: 0;
  };
  claims: {
    offlineCompilation: true;
    existingCatalogOnly: true;
    clubsExcluded: true;
    bjsExcluded: true;
    networkCalls: 0;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    marketplaceMutations: 0;
    titleOnlyIdentityProof: false;
    outerIdentifiersUsedAsBaseUnitProof: false;
    authorizesCanonicalMaterialization: false;
    createsAdditionalCatalog: false;
  };
}

export class ProductTruthAmazonListingDecompositionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthAmazonListingDecompositionError";
    this.code = code;
  }
}

const STOP_TOKENS = new Set([
  "a", "and", "as", "at", "by", "case", "count", "ct", "each", "for",
  "from", "fully", "in", "item", "items", "of", "ounce", "ounces", "oz",
  "pack", "package", "per", "pieces", "product", "the", "total", "with",
]);
const EXCLUDED_RETAILERS = new Set([
  "bjs",
  "bj s",
  "sam s club",
  "sams club",
  "costco",
]);
const PRODUCT_FORM_ANCHORS = new Set([
  "applesauce",
  "biscuit",
  "bowl",
  "bread",
  "cereal",
  "cheese",
  "cookie",
  "cracker",
  "crumble",
  "juice",
  "link",
  "noodle",
  "pasta",
  "patty",
  "roll",
  "sandwich",
]);

function fail(code: string, message: string): never {
  throw new ProductTruthAmazonListingDecompositionError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: string, label: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    fail("AMAZON_DECOMPOSITION_SHA_INVALID", label);
  }
  return normalized;
}

function canonicalInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("AMAZON_DECOMPOSITION_INSTANT_INVALID", label);
  }
  return value;
}

function assertCanonical(input: {
  label: string;
  json: string;
  expectedSha256: string;
  canonicalJson: string;
}): string {
  const expected = exactSha(input.expectedSha256, input.label);
  if (input.json !== input.canonicalJson || sha256(input.json) !== expected) {
    fail("AMAZON_DECOMPOSITION_SOURCE_BINDING_MISMATCH", input.label);
  }
  return expected;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/['’]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function tokens(value: string): string[] {
  const singular = (token: string): string => {
    if (/^[a-z]+(?:ches|shes|xes|zes)$/u.test(token)) return token.slice(0, -2);
    if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
      return token.slice(0, -1);
    }
    return token;
  };
  return [...new Set(normalizeText(value).split(/\s+/u)
    .filter((token) => token.length > 1 && !/^\d+(?:\.\d+)?$/u.test(token))
    .filter((token) => !STOP_TOKENS.has(token))
    .map(singular))].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function explicitCountClaims(value: string): number[] {
  return [...value.matchAll(/\b(\d+)\s*(?:count|ct)\b/giu)]
    .map((match) => Number(match[1]))
    .filter((count) => Number.isInteger(count) && count > 0);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("AMAZON_DECOMPOSITION_SOURCE_INVALID", `${label} must be object`);
  }
  return value as JsonObject;
}

function attributeRows(attributes: JsonObject, key: string): JsonObject[] {
  const value = attributes[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("AMAZON_DECOMPOSITION_ATTRIBUTE_INVALID", key);
  }
  return value.map((row, index) => object(row, `${key}[${index}]`));
}

function textSignals(
  attributes: JsonObject,
  key: string,
  kind: ProductTruthAmazonStructuralSignal["kind"],
): ProductTruthAmazonStructuralSignal[] {
  return attributeRows(attributes, key).flatMap((row, index) => {
    if (typeof row.value !== "string" || !row.value.trim()) return [];
    return [{
      kind,
      sourcePath: `catalog.attributes.${key}[${index}].value`,
      value: row.value.trim(),
      unit: null,
      authority: "STRUCTURED_MARKETPLACE_EVIDENCE",
    }];
  });
}

function numericSignals(
  attributes: JsonObject,
  key: string,
  kind: ProductTruthAmazonStructuralSignal["kind"],
): ProductTruthAmazonStructuralSignal[] {
  return attributeRows(attributes, key).flatMap((row, index) => {
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) return [];
    const unit = typeof row.unit === "string"
      ? row.unit.trim()
      : row.type && typeof row.type === "object" && !Array.isArray(row.type)
        && typeof (row.type as JsonObject).value === "string"
        ? ((row.type as JsonObject).value as string).trim()
        : null;
    return [{
      kind,
      sourcePath: `catalog.attributes.${key}[${index}].value`,
      value: row.value,
      unit,
      authority: "STRUCTURED_MARKETPLACE_EVIDENCE",
    }];
  });
}

function titleSignals(title: string): ProductTruthAmazonStructuralSignal[] {
  const signals: ProductTruthAmazonStructuralSignal[] = [];
  const patterns: Array<{
    kind: ProductTruthAmazonStructuralSignal["kind"];
    pattern: RegExp;
  }> = [
    { kind: "TITLE_OUTER_COUNT", pattern: /\bpack\s+of\s+(\d+)\b/giu },
    { kind: "TITLE_OUTER_COUNT", pattern: /\bcase\s+of\s+(\d+)\b/giu },
    { kind: "TITLE_OUTER_COUNT", pattern: /\b(\d+)\s+per\s+case\b/giu },
    { kind: "TITLE_OUTER_COUNT", pattern: /\b(\d+)\s+packs?\b(?!\s+of\b)/giu },
    { kind: "TITLE_TOTAL_COUNT", pattern: /\btotal\s+(\d+)\s+(?:pieces?|count|ct)\b/giu },
    { kind: "TITLE_COUNT", pattern: /\b(\d+)\s*(?:count|ct)\b/giu },
  ];
  for (const { kind, pattern } of patterns) {
    for (const match of title.matchAll(pattern)) {
      const value = Number(match[1]);
      if (!Number.isInteger(value) || value < 1) continue;
      signals.push({
        kind,
        sourcePath: "catalog.attributes.item_name/title-grammar",
        value,
        unit: "count",
        authority: "TITLE_CLAIM_ONLY",
      });
    }
  }
  return signals;
}

function normalizedRetailer(value: string): string {
  return normalizeText(value);
}

function candidateTokens(donor: ProductTruthLegacyBridgeDonorRow): string[] {
  const brandTokens = new Set(tokens(donor.brand ?? ""));
  return tokens([
    donor.title,
    donor.productLine,
    donor.flavor,
    donor.containerType,
  ].filter(Boolean).join(" ")).filter((token) => !brandTokens.has(token));
}

export function compileProductTruthAmazonListingDecomposition(input: {
  compiledAt: string;
  plan: ProductTruthAmazonCatalogCapturePlan;
  planJson: string;
  planSha256: string;
  evidence: ProductTruthAmazonCatalogListingEvidence;
  evidenceJson: string;
  evidenceSha256: string;
  legacySnapshot: ProductTruthLegacyBridgeSnapshot;
  legacySnapshotJson: string;
  legacySnapshotSha256: string;
}): ProductTruthAmazonListingDecomposition {
  const compiledAt = canonicalInstant(input.compiledAt, "compiledAt");
  validateProductTruthAmazonCatalogCapturePlan(input.plan);
  const planSha256 = assertCanonical({
    label: "plan",
    json: input.planJson,
    expectedSha256: input.planSha256,
    canonicalJson: renderProductTruthAmazonCatalogCapturePlan(input.plan),
  });
  if (
    input.evidence.schemaVersion !== PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION
    || input.evidence.source.planSha256 !== planSha256
    || input.evidence.source.targetSetSha256 !== input.plan.targetSetSha256
    || input.evidence.entries.length !== input.plan.targets.length
    || input.evidence.counts.targets !== input.plan.targets.length
    || !input.evidence.claims.offlineCompilation
    || input.evidence.claims.networkCalls !== 0
    || input.evidence.claims.databaseWrites !== 0
    || input.evidence.claims.providerCalls !== 0
    || input.evidence.claims.paidCalls !== 0
    || input.evidence.claims.marketplaceMutations !== 0
    || input.evidence.claims.titleOnlyIdentityProof
    || input.evidence.claims.identifiersAreBaseUnitProof
    || input.evidence.claims.authorizesCanonicalMaterialization
    || input.evidence.claims.createsAdditionalCatalog
  ) {
    fail("AMAZON_DECOMPOSITION_EVIDENCE_INVALID", "evidence safety or plan binding");
  }
  const evidenceSha256 = assertCanonical({
    label: "evidence",
    json: input.evidenceJson,
    expectedSha256: input.evidenceSha256,
    canonicalJson: renderProductTruthAmazonCatalogListingEvidence(input.evidence),
  });
  if (
    input.legacySnapshot.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
    || input.legacySnapshot.manifest.sha256 !== input.plan.source.manifest.sha256
  ) {
    fail("AMAZON_DECOMPOSITION_SNAPSHOT_INVALID", "version or manifest binding");
  }
  const legacySnapshotSha256 = assertCanonical({
    label: "legacySnapshot",
    json: input.legacySnapshotJson,
    expectedSha256: input.legacySnapshotSha256,
    canonicalJson: renderProductTruthLegacyBridgeSnapshot(input.legacySnapshot),
  });
  const bindingByDonor = new Map(
    input.legacySnapshot.canonicalDonorBindings.map((row) => [
      row.donorProductId,
      row.canonicalVariantId,
    ]),
  );
  const eligibleRetailersByDonor = new Map<string, Set<string>>();
  for (const offer of input.legacySnapshot.offers) {
    const retailer = normalizedRetailer(offer.retailer);
    if (
      !offer.isFirstParty
      || offer.via !== "direct"
      || !offer.productUrl?.startsWith("https://")
      || EXCLUDED_RETAILERS.has(retailer)
    ) continue;
    const current = eligibleRetailersByDonor.get(offer.donorProductId)
      ?? new Set<string>();
    current.add(offer.retailer);
    eligibleRetailersByDonor.set(offer.donorProductId, current);
  }
  const evidenceByKey = new Map(
    input.evidence.entries.map((entry) => [entry.listingKey, entry]),
  );
  if (evidenceByKey.size !== input.evidence.entries.length) {
    fail("AMAZON_DECOMPOSITION_EVIDENCE_INVALID", "duplicate listing key");
  }
  const entries = input.plan.targets.map((target) => {
    const evidence = evidenceByKey.get(target.listingKey);
    if (
      !evidence
      || evidence.ordinal !== target.ordinal
      || evidence.asin !== target.asin
      || evidence.storeIndex !== target.storeIndex
      || evidence.sku !== target.sku
    ) fail("AMAZON_DECOMPOSITION_TARGET_MISMATCH", target.listingKey);
    const attributes = evidence.catalog.attributes;
    const signals = [
      ...textSignals(attributes, "brand", "CATALOG_BRAND"),
      ...textSignals(attributes, "manufacturer", "CATALOG_MANUFACTURER"),
      ...textSignals(attributes, "flavor", "CATALOG_FLAVOR"),
      ...textSignals(attributes, "item_form", "CATALOG_ITEM_FORM"),
      ...textSignals(attributes, "size", "CATALOG_SIZE"),
      ...numericSignals(attributes, "number_of_items", "CATALOG_OUTER_COUNT"),
      ...numericSignals(attributes, "item_package_quantity", "CATALOG_OUTER_COUNT"),
      ...numericSignals(attributes, "each_unit_count", "CATALOG_EACH_COUNT"),
      ...numericSignals(attributes, "unit_count", "CATALOG_UNIT_COUNT"),
      ...numericSignals(attributes, "item_package_weight", "CATALOG_SIZE"),
      ...numericSignals(attributes, "item_weight", "CATALOG_SIZE"),
      ...numericSignals(attributes, "item_volume", "CATALOG_SIZE"),
      ...titleSignals(evidence.listingTitle),
    ].sort((left, right) =>
      left.kind.localeCompare(right.kind, "en-US")
      || left.sourcePath.localeCompare(right.sourcePath, "en-US")
      || String(left.value).localeCompare(String(right.value), "en-US"));
    const brands = signals
      .filter((signal) => signal.kind === "CATALOG_BRAND")
      .map((signal) => normalizeText(String(signal.value)));
    const manufacturers = signals
      .filter((signal) => signal.kind === "CATALOG_MANUFACTURER")
      .map((signal) => normalizeText(String(signal.value)));
    const exactBrands = new Set([...brands, ...manufacturers].filter(Boolean));
    const titleOuterCounts = new Set(signals
      .filter((signal) => signal.kind === "TITLE_OUTER_COUNT")
      .map((signal) => Number(signal.value)));
    const catalogOuterCounts = new Set(signals
      .filter((signal) => signal.kind === "CATALOG_OUTER_COUNT")
      .map((signal) => Number(signal.value)));
    const totalTitleCounts = new Set(signals
      .filter((signal) => signal.kind === "TITLE_TOTAL_COUNT")
      .map((signal) => Number(signal.value)));
    const baseTitleCounts = [...new Set(signals
      .filter((signal) => signal.kind === "TITLE_COUNT")
      .map((signal) => Number(signal.value))
      .filter((value) => !totalTitleCounts.has(value)))];
    const exactBaseTitleCount = baseTitleCounts.length === 1
      ? baseTitleCounts[0]!
      : null;
    const brandManufacturerConflict = brands.length > 0
      && manufacturers.length > 0
      && !brands.some((brand) => manufacturers.includes(brand));
    const outerCountConflict = titleOuterCounts.size > 0
      && catalogOuterCounts.size > 0
      && ![...titleOuterCounts].some((value) => catalogOuterCounts.has(value));
    const evidenceTokens = new Set(tokens([
      evidence.listingTitle,
      ...signals.filter((signal) => [
        "CATALOG_FLAVOR",
        "CATALOG_ITEM_FORM",
      ].includes(signal.kind)).map((signal) => String(signal.value)),
    ].join(" ")));
    const flavorAnchorTokens = new Set(tokens(signals
      .filter((signal) => signal.kind === "CATALOG_FLAVOR")
      .map((signal) => String(signal.value))
      .join(" ")));
    const productFormAnchorTokens = new Set(
      [...evidenceTokens].filter((token) => PRODUCT_FORM_ANCHORS.has(token)),
    );
    const candidates = input.legacySnapshot.donors.flatMap((donor) => {
      const donorBrand = normalizeText(donor.brand ?? "");
      const eligibleRetailers = eligibleRetailersByDonor.get(donor.id);
      if (
        !donor.title
        || !donor.brand
        || !exactBrands.has(donorBrand)
        || !eligibleRetailers?.size
      ) return [];
      const identityTokens = candidateTokens(donor);
      const fullDonorTokens = new Set(tokens([
        donor.title,
        donor.productLine,
        donor.flavor,
      ].filter(Boolean).join(" ")));
      if ([...flavorAnchorTokens].some((token) => !fullDonorTokens.has(token))) {
        return [];
      }
      if (
        [...productFormAnchorTokens].some((token) => !fullDonorTokens.has(token))
      ) return [];
      const donorCounts = explicitCountClaims([
        donor.title,
        donor.size,
      ].filter(Boolean).join(" "));
      if (
        exactBaseTitleCount !== null
        && donorCounts.length > 0
        && !donorCounts.includes(exactBaseTitleCount)
      ) return [];
      const shared = identityTokens.filter((token) => evidenceTokens.has(token));
      if (shared.length < 2 || identityTokens.length < 2) return [];
      return [{
        donorProductId: donor.id,
        title: donor.title,
        brand: donor.brand,
        size: donor.size,
        upc: donor.upc,
        gtin: donor.gtin,
        canonicalVariantId: bindingByDonor.get(donor.id) ?? null,
        eligibleFirstPartyRetailers: [...eligibleRetailers].sort((left, right) =>
          left.localeCompare(right, "en-US")),
        sharedIdentityTokens: shared,
        candidateIdentityTokens: identityTokens,
        countCompatibility: exactBaseTitleCount === null || donorCounts.length === 0
          ? "UNKNOWN"
          : "MATCH",
        retrievalScoreMillis: Math.floor(shared.length * 1000 / identityTokens.length),
        exactIdentityProven: false,
        authorizesCanonicalMaterialization: false,
      } satisfies ProductTruthAmazonExistingCatalogCandidate];
    }).sort((left, right) =>
      right.retrievalScoreMillis - left.retrievalScoreMillis
      || right.sharedIdentityTokens.length - left.sharedIdentityTokens.length
      || left.donorProductId.localeCompare(right.donorProductId, "en-US"))
      .slice(0, 10);
    const blockerCodes: ProductTruthAmazonListingDecompositionEntry["blockerCodes"] = [];
    if (brandManufacturerConflict) {
      blockerCodes.push("CATALOG_BRAND_MANUFACTURER_CONFLICT");
    }
    if (outerCountConflict) blockerCodes.push("OUTER_COUNT_CONFLICT");
    if (!exactBrands.size) blockerCodes.push("NO_CATALOG_BRAND_OR_MANUFACTURER");
    if (!candidates.length) {
      blockerCodes.push("NO_ALLOWED_EXISTING_CATALOG_CANDIDATE");
    }
    blockerCodes.push("EXACT_COMPONENT_IDENTITY_NOT_PROVEN");
    const contradictory = brandManufacturerConflict || outerCountConflict;
    return {
      ordinal: target.ordinal,
      listingKey: target.listingKey,
      storeIndex: target.storeIndex,
      sku: target.sku,
      asin: target.asin,
      listingTitle: target.listingTitle,
      signals,
      blockerCodes,
      status: contradictory
        ? "CONTRADICTORY_CATALOG_STRUCTURE"
        : candidates.length
          ? "CANDIDATES_REQUIRE_EXACT_ADJUDICATION"
          : "NO_ALLOWED_EXISTING_CATALOG_CANDIDATE",
      candidates,
      claims: {
        outerIdentifiersUsedAsBaseUnitProof: false,
        titleOnlyIdentityProof: false,
        exactComponentIdentityProven: false,
        authorizesCanonicalMaterialization: false,
      },
    } satisfies ProductTruthAmazonListingDecompositionEntry;
  });
  return {
    schemaVersion: PRODUCT_TRUTH_AMAZON_LISTING_DECOMPOSITION_VERSION,
    compiledAt,
    source: {
      planSha256,
      evidenceSha256,
      legacySnapshotSha256,
      manifestSha256: input.plan.source.manifest.sha256,
      targetSetSha256: input.plan.targetSetSha256,
    },
    entries,
    counts: {
      targets: entries.length,
      contradictory: entries.filter(
        (entry) => entry.status === "CONTRADICTORY_CATALOG_STRUCTURE",
      ).length,
      withoutAllowedCandidate: entries.filter(
        (entry) => entry.status === "NO_ALLOWED_EXISTING_CATALOG_CANDIDATE",
      ).length,
      candidatesRequireExactAdjudication: entries.filter(
        (entry) => entry.status === "CANDIDATES_REQUIRE_EXACT_ADJUDICATION",
      ).length,
      exactComponentIdentityProven: 0,
      canonicalMaterializationsAuthorized: 0,
    },
    claims: {
      offlineCompilation: true,
      existingCatalogOnly: true,
      clubsExcluded: true,
      bjsExcluded: true,
      networkCalls: 0,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      titleOnlyIdentityProof: false,
      outerIdentifiersUsedAsBaseUnitProof: false,
      authorizesCanonicalMaterialization: false,
      createsAdditionalCatalog: false,
    },
  };
}

export function renderProductTruthAmazonListingDecomposition(
  value: ProductTruthAmazonListingDecomposition,
): string {
  return renderProductTruthOperationalJson(value);
}
