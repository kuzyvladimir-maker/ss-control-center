import { createHash } from "node:crypto";

import {
  PHASE1_SCOPE_MANIFEST_VERSION,
  renderPhase1ScopeManifestJson,
  validatePhase1ScopeManifestV3Policy,
  type Phase1ScopeManifest,
} from "./phase1-scope-manifest";
import {
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
  renderProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairLane,
  type ProductTruthRecipeRepairScope,
} from "./product-truth-recipe-repair-scope";

export const PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_PLAN_VERSION =
  "product-truth-amazon-catalog-capture-plan/1.0.0" as const;
export const PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_VERSION =
  "product-truth-amazon-catalog-capture/1.0.0" as const;
export const PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION =
  "product-truth-amazon-catalog-listing-evidence/1.0.0" as const;

export const PRODUCT_TRUTH_AMAZON_CATALOG_INCLUDED_DATA =
  "attributes,identifiers,images,productTypes,relationships,summaries" as const;
export const PRODUCT_TRUTH_AMAZON_CATALOG_MARKETPLACE_ID =
  "ATVPDKIKX0DER" as const;
export const PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS = 50;

const ELIGIBLE_REPAIR_LANES = new Set<ProductTruthRecipeRepairLane>([
  "LISTING_IDENTITY_RECOVERY",
  "COMPONENT_GRAPH_RECOVERY",
]);

type JsonObject = Record<string, unknown>;

export interface ProductTruthAmazonCatalogCaptureTarget {
  ordinal: number;
  listingKey: string;
  storeIndex: number;
  sku: string;
  asin: string;
  listingTitle: string;
  repairLane: "LISTING_IDENTITY_RECOVERY" | "COMPONENT_GRAPH_RECOVERY";
  sourceReportId: string;
  sourceCapturedAt: string;
  sourceContentSha256: string;
  manifestRowSha256: string;
  recipeScopeEntrySha256: string;
}

export interface ProductTruthAmazonCatalogCapturePlan {
  schemaVersion: typeof PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_PLAN_VERSION;
  generatedAt: string;
  source: {
    manifest: {
      schemaVersion: typeof PHASE1_SCOPE_MANIFEST_VERSION;
      sha256: string;
      listingCount: number;
    };
    recipeRepairScope: {
      schemaVersion: typeof PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION;
      sha256: string;
      generatedAt: string;
    };
  };
  requestContract: {
    api: "Amazon Catalog Items 2022-04-01";
    method: "GET";
    marketplaceId: typeof PRODUCT_TRUTH_AMAZON_CATALOG_MARKETPLACE_ID;
    includedData: typeof PRODUCT_TRUTH_AMAZON_CATALOG_INCLUDED_DATA;
    concurrency: 1;
    attemptsPerTarget: 1;
    maxTargets: typeof PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS;
  };
  targetSetSha256: string;
  targets: ProductTruthAmazonCatalogCaptureTarget[];
  claims: {
    explicitScopeOnly: true;
    readOnlyAmazonApi: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    marketplaceMutations: 0;
    authorizesCanonicalMaterialization: false;
    identifiersAreBaseUnitProof: false;
  };
}

export interface ProductTruthAmazonCatalogRawCaptureEntry {
  ordinal: number;
  listingKey: string;
  storeIndex: number;
  asin: string;
  capturedAt: string;
  rawFile: string;
  rawSha256: string;
  rawByteLength: number;
}

export interface ProductTruthAmazonCatalogCapture {
  schemaVersion: typeof PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_VERSION;
  capturedAt: string;
  plan: {
    sha256: string;
    targetSetSha256: string;
    targetCount: number;
  };
  requestContract: ProductTruthAmazonCatalogCapturePlan["requestContract"];
  entries: ProductTruthAmazonCatalogRawCaptureEntry[];
  counts: {
    planned: number;
    attempted: number;
    captured: number;
    failed: 0;
  };
  claims: {
    amazonGetCalls: number;
    retries: 0;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    marketplaceMutations: 0;
  };
}

export interface ProductTruthAmazonCatalogIdentifierEvidence {
  marketplaceId: string;
  identifierType: string;
  identifier: string;
  classification: "OUTER_MARKETPLACE_CATALOG_IDENTIFIER";
  baseUnitIdentityProof: false;
}

export interface ProductTruthAmazonCatalogListingEvidenceEntry {
  ordinal: number;
  listingKey: string;
  storeIndex: number;
  sku: string;
  asin: string;
  listingTitle: string;
  repairLane: ProductTruthAmazonCatalogCaptureTarget["repairLane"];
  rawCapture: {
    file: string;
    sha256: string;
    byteLength: number;
    capturedAt: string;
  };
  catalog: {
    asin: string;
    attributes: JsonObject;
    identifiers: ProductTruthAmazonCatalogIdentifierEvidence[];
    images: unknown[];
    productTypes: unknown[];
    relationships: unknown[];
    summaries: unknown[];
  };
  authority: {
    structuredMarketplaceEvidence: true;
    titleOnlyIdentityProof: false;
    identifiersAreBaseUnitProof: false;
    authorizesCanonicalMaterialization: false;
  };
}

export interface ProductTruthAmazonCatalogListingEvidence {
  schemaVersion: typeof PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION;
  compiledAt: string;
  source: {
    planSha256: string;
    captureSha256: string;
    targetSetSha256: string;
  };
  entries: ProductTruthAmazonCatalogListingEvidenceEntry[];
  counts: {
    targets: number;
    entriesWithIdentifiers: number;
    identifierCount: number;
    entriesWithAttributes: number;
    entriesWithImages: number;
  };
  claims: {
    offlineCompilation: true;
    networkCalls: 0;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    marketplaceMutations: 0;
    titleOnlyIdentityProof: false;
    identifiersAreBaseUnitProof: false;
    authorizesCanonicalMaterialization: false;
    createsAdditionalCatalog: false;
  };
}

export class ProductTruthAmazonCatalogEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthAmazonCatalogEvidenceError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthAmazonCatalogEvidenceError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("AMAZON_CATALOG_INSTANT_INVALID", label);
  }
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("AMAZON_CATALOG_SOURCE_INVALID", `${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("AMAZON_CATALOG_SOURCE_INVALID", `${label} must be an array`);
  }
  return value;
}

function exactSha(value: string, label: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    fail("AMAZON_CATALOG_SHA_INVALID", label);
  }
  return normalized;
}

function assertCanonicalSource(input: {
  label: string;
  json: string;
  canonicalJson: string;
  expectedSha256: string;
}): string {
  const expected = exactSha(input.expectedSha256, input.label);
  if (input.json !== input.canonicalJson || sha256(input.json) !== expected) {
    fail("AMAZON_CATALOG_SOURCE_BINDING_MISMATCH", input.label);
  }
  return expected;
}

function exactAsin(value: string, label: string): string {
  const asin = value.trim().toLocaleUpperCase("en-US");
  if (!/^[A-Z0-9]{10}$/u.test(asin)) {
    fail("AMAZON_CATALOG_ASIN_INVALID", label);
  }
  return asin;
}

function targetSetSha256(
  targets: readonly ProductTruthAmazonCatalogCaptureTarget[],
): string {
  return sha256(renderProductTruthOperationalJson(targets));
}

export function compileProductTruthAmazonCatalogCapturePlan(input: {
  generatedAt: string;
  listingKeys: readonly string[];
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  manifestSha256: string;
  recipeRepairScope: ProductTruthRecipeRepairScope;
  recipeRepairScopeJson: string;
  recipeRepairScopeSha256: string;
}): ProductTruthAmazonCatalogCapturePlan {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  const policyErrors = validatePhase1ScopeManifestV3Policy(input.manifest);
  if (
    input.manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION
    || !input.manifest.authoritative
    || input.manifest.blockers.length
    || policyErrors.length
  ) {
    fail(
      "AMAZON_CATALOG_MANIFEST_INVALID",
      policyErrors.join("; ") || "manifest is not authoritative",
    );
  }
  const manifestSha256 = assertCanonicalSource({
    label: "manifest",
    json: input.manifestJson,
    canonicalJson: renderPhase1ScopeManifestJson(input.manifest),
    expectedSha256: input.manifestSha256,
  });
  if (
    input.recipeRepairScope.schemaVersion
      !== PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION
  ) {
    fail("AMAZON_CATALOG_RECIPE_SCOPE_INVALID", "schemaVersion");
  }
  const recipeRepairScopeSha256 = assertCanonicalSource({
    label: "recipeRepairScope",
    json: input.recipeRepairScopeJson,
    canonicalJson: renderProductTruthRecipeRepairScope(input.recipeRepairScope),
    expectedSha256: input.recipeRepairScopeSha256,
  });
  if (
    input.recipeRepairScope.source.manifest.sha256 !== manifestSha256
    || input.recipeRepairScope.source.manifest.listingCount
      !== input.manifest.listings.length
    || input.recipeRepairScope.counts.denominator !== input.manifest.listings.length
    || input.recipeRepairScope.entries.length !== input.manifest.listings.length
    || input.recipeRepairScope.counts.currentRecipePresent
      + input.recipeRepairScope.counts.currentRecipeMissing
      !== input.manifest.listings.length
    || input.recipeRepairScope.laneCounts.reduce(
      (sum, row) => sum + row.count,
      0,
    ) !== input.manifest.listings.length
    || !input.recipeRepairScope.claims.readOnlySources
    || input.recipeRepairScope.claims.databaseWrites !== 0
    || input.recipeRepairScope.claims.providerCalls !== 0
    || input.recipeRepairScope.claims.paidCalls !== 0
    || input.recipeRepairScope.claims.marketplaceMutations !== 0
    || input.recipeRepairScope.claims.authorizesExecution
    || input.recipeRepairScope.claims.historicalStateIsIdentityProof
    || input.recipeRepairScope.claims.historicalStatusAuthorizesRecipe
    || input.recipeRepairScope.claims.variantMismatchAutoPromoted
    || input.recipeRepairScope.claims.createsAdditionalCatalog
    || !input.recipeRepairScope.claims.repairLaneIsPriorityNotTruthMutation
  ) {
    fail(
      "AMAZON_CATALOG_SOURCE_BINDING_MISMATCH",
      "manifest and recipe repair scope do not bind one denominator",
    );
  }
  if (
    input.listingKeys.length < 1
    || input.listingKeys.length > PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS
    || new Set(input.listingKeys).size !== input.listingKeys.length
    || input.listingKeys.some((value) => !value || value !== value.trim())
  ) {
    fail(
      "AMAZON_CATALOG_EXPLICIT_SCOPE_INVALID",
      `expected 1-${PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS} unique exact listing keys`,
    );
  }
  const manifestByKey = new Map(
    input.manifest.listings.map((row) => [row.listingKey, row]),
  );
  const repairByKey = new Map(
    input.recipeRepairScope.entries.map((row) => [row.listingKey, row]),
  );
  if (
    manifestByKey.size !== input.manifest.listings.length
    || repairByKey.size !== input.recipeRepairScope.entries.length
    || input.manifest.listings.some((manifestRow) => {
      const repairRow = repairByKey.get(manifestRow.listingKey);
      return !repairRow
        || repairRow.channel !== manifestRow.channel
        || repairRow.storeIndex !== manifestRow.storeIndex
        || repairRow.sku !== manifestRow.sku
        || repairRow.listingId !== manifestRow.listingId
        || repairRow.listingTitle !== manifestRow.title;
    })
  ) {
    fail(
      "AMAZON_CATALOG_SOURCE_SET_MISMATCH",
      "manifest and recipe repair scope listing sets differ",
    );
  }
  const targets = input.listingKeys.map((listingKey, index) => {
    const manifestRow = manifestByKey.get(listingKey);
    const repairRow = repairByKey.get(listingKey);
    if (!manifestRow || !repairRow) {
      fail("AMAZON_CATALOG_TARGET_NOT_FOUND", listingKey);
    }
    if (
      manifestRow.channel !== "amazon"
      || repairRow.channel !== "amazon"
      || repairRow.recipeStatus !== "MISSING"
      || !ELIGIBLE_REPAIR_LANES.has(repairRow.repairLane)
      || manifestRow.storeIndex !== repairRow.storeIndex
      || manifestRow.sku !== repairRow.sku
      || manifestRow.listingId !== repairRow.listingId
      || manifestRow.title !== repairRow.listingTitle
    ) {
      fail("AMAZON_CATALOG_TARGET_INELIGIBLE", listingKey);
    }
    return {
      ordinal: index + 1,
      listingKey,
      storeIndex: manifestRow.storeIndex,
      sku: manifestRow.sku,
      asin: exactAsin(manifestRow.listingId, listingKey),
      listingTitle: manifestRow.title,
      repairLane: repairRow.repairLane as ProductTruthAmazonCatalogCaptureTarget["repairLane"],
      sourceReportId: manifestRow.sourceReportId,
      sourceCapturedAt: manifestRow.sourceCapturedAt,
      sourceContentSha256: exactSha(
        manifestRow.sourceContentSha256,
        `${listingKey}.sourceContentSha256`,
      ),
      manifestRowSha256: sha256(renderProductTruthOperationalJson(manifestRow)),
      recipeScopeEntrySha256: sha256(
        renderProductTruthOperationalJson(repairRow),
      ),
    };
  });
  return {
    schemaVersion: PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_PLAN_VERSION,
    generatedAt,
    source: {
      manifest: {
        schemaVersion: input.manifest.schemaVersion,
        sha256: manifestSha256,
        listingCount: input.manifest.listings.length,
      },
      recipeRepairScope: {
        schemaVersion: input.recipeRepairScope.schemaVersion,
        sha256: recipeRepairScopeSha256,
        generatedAt: input.recipeRepairScope.generatedAt,
      },
    },
    requestContract: {
      api: "Amazon Catalog Items 2022-04-01",
      method: "GET",
      marketplaceId: PRODUCT_TRUTH_AMAZON_CATALOG_MARKETPLACE_ID,
      includedData: PRODUCT_TRUTH_AMAZON_CATALOG_INCLUDED_DATA,
      concurrency: 1,
      attemptsPerTarget: 1,
      maxTargets: PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS,
    },
    targetSetSha256: targetSetSha256(targets),
    targets,
    claims: {
      explicitScopeOnly: true,
      readOnlyAmazonApi: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      authorizesCanonicalMaterialization: false,
      identifiersAreBaseUnitProof: false,
    },
  };
}

export function validateProductTruthAmazonCatalogCapturePlan(
  plan: ProductTruthAmazonCatalogCapturePlan,
): void {
  if (
    plan.schemaVersion !== PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_PLAN_VERSION
    || plan.targets.length < 1
    || plan.targets.length > PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS
    || plan.targets.some((target, index) => target.ordinal !== index + 1)
    || new Set(plan.targets.map((target) => target.listingKey)).size
      !== plan.targets.length
    || targetSetSha256(plan.targets) !== plan.targetSetSha256
    || plan.requestContract.api !== "Amazon Catalog Items 2022-04-01"
    || plan.requestContract.method !== "GET"
    || plan.requestContract.marketplaceId
      !== PRODUCT_TRUTH_AMAZON_CATALOG_MARKETPLACE_ID
    || plan.requestContract.includedData
      !== PRODUCT_TRUTH_AMAZON_CATALOG_INCLUDED_DATA
    || plan.requestContract.concurrency !== 1
    || plan.requestContract.attemptsPerTarget !== 1
    || plan.requestContract.maxTargets !== PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS
    || !plan.claims.explicitScopeOnly
    || !plan.claims.readOnlyAmazonApi
    || plan.claims.databaseWrites !== 0
    || plan.claims.providerCalls !== 0
    || plan.claims.paidCalls !== 0
    || plan.claims.marketplaceMutations !== 0
    || plan.claims.authorizesCanonicalMaterialization
    || plan.claims.identifiersAreBaseUnitProof
  ) {
    fail("AMAZON_CATALOG_PLAN_INVALID", "request or safety contract drifted");
  }
  canonicalInstant(plan.generatedAt, "plan.generatedAt");
  for (const target of plan.targets) {
    exactAsin(target.asin, target.listingKey);
    if (
      target.storeIndex < 1
      || !Number.isInteger(target.storeIndex)
      || target.listingKey !== `amazon:${target.storeIndex}:${target.sku}`
      || !target.sku
      || target.sku !== target.sku.trim()
      || !ELIGIBLE_REPAIR_LANES.has(target.repairLane)
    ) {
      fail("AMAZON_CATALOG_PLAN_INVALID", `${target.listingKey}.storeIndex`);
    }
    exactSha(target.sourceContentSha256, `${target.listingKey}.sourceContentSha256`);
    exactSha(target.manifestRowSha256, `${target.listingKey}.manifestRowSha256`);
    exactSha(
      target.recipeScopeEntrySha256,
      `${target.listingKey}.recipeScopeEntrySha256`,
    );
  }
  exactSha(plan.source.manifest.sha256, "plan.source.manifest.sha256");
  exactSha(
    plan.source.recipeRepairScope.sha256,
    "plan.source.recipeRepairScope.sha256",
  );
}

function identifiers(value: unknown): ProductTruthAmazonCatalogIdentifierEvidence[] {
  return array(value, "identifiers").flatMap((group): ProductTruthAmazonCatalogIdentifierEvidence[] => {
    const row = object(group, "identifier group");
    const marketplaceId = typeof row.marketplaceId === "string"
      ? row.marketplaceId.trim()
      : "";
    return array(row.identifiers, "identifier group.identifiers").map((item) => {
      const identifier = object(item, "identifier");
      const identifierType = typeof identifier.identifierType === "string"
        ? identifier.identifierType.trim()
        : "";
      const raw = typeof identifier.identifier === "string"
        ? identifier.identifier.trim()
        : "";
      if (!marketplaceId || !identifierType || !raw) {
        fail("AMAZON_CATALOG_IDENTIFIER_INVALID", "blank identifier field");
      }
      return {
        marketplaceId,
        identifierType,
        identifier: raw,
        classification: "OUTER_MARKETPLACE_CATALOG_IDENTIFIER",
        baseUnitIdentityProof: false,
      };
    });
  }).sort((left, right) =>
    left.marketplaceId.localeCompare(right.marketplaceId, "en-US")
    || left.identifierType.localeCompare(right.identifierType, "en-US")
    || left.identifier.localeCompare(right.identifier, "en-US"));
}

export function compileProductTruthAmazonCatalogListingEvidence(input: {
  compiledAt: string;
  plan: ProductTruthAmazonCatalogCapturePlan;
  planJson: string;
  planSha256: string;
  capture: ProductTruthAmazonCatalogCapture;
  captureJson: string;
  captureSha256: string;
  rawResponses: ReadonlyMap<string, { json: string; value: unknown }>;
}): ProductTruthAmazonCatalogListingEvidence {
  const compiledAt = canonicalInstant(input.compiledAt, "compiledAt");
  validateProductTruthAmazonCatalogCapturePlan(input.plan);
  const planSha256 = assertCanonicalSource({
    label: "plan",
    json: input.planJson,
    canonicalJson: renderProductTruthAmazonCatalogCapturePlan(input.plan),
    expectedSha256: input.planSha256,
  });
  if (
    input.capture.schemaVersion !== PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_VERSION
    || input.capture.plan.sha256 !== planSha256
    || input.capture.plan.targetSetSha256 !== input.plan.targetSetSha256
    || input.capture.plan.targetCount !== input.plan.targets.length
    || input.capture.entries.length !== input.plan.targets.length
    || input.capture.counts.planned !== input.plan.targets.length
    || input.capture.counts.attempted !== input.plan.targets.length
    || input.capture.counts.captured !== input.plan.targets.length
    || input.capture.counts.failed !== 0
    || input.capture.claims.amazonGetCalls !== input.plan.targets.length
    || input.capture.claims.retries !== 0
    || input.capture.claims.databaseWrites !== 0
    || input.capture.claims.providerCalls !== 0
    || input.capture.claims.paidCalls !== 0
    || input.capture.claims.marketplaceMutations !== 0
  ) {
    fail("AMAZON_CATALOG_CAPTURE_INVALID", "capture does not bind the plan");
  }
  const captureSha256 = assertCanonicalSource({
    label: "capture",
    json: input.captureJson,
    canonicalJson: renderProductTruthAmazonCatalogCapture(input.capture),
    expectedSha256: input.captureSha256,
  });
  const captureByListing = new Map(
    input.capture.entries.map((entry) => [entry.listingKey, entry]),
  );
  const entries = input.plan.targets.map((target) => {
    const capture = captureByListing.get(target.listingKey);
    if (
      !capture
      || capture.ordinal !== target.ordinal
      || capture.storeIndex !== target.storeIndex
      || capture.asin !== target.asin
    ) {
      fail("AMAZON_CATALOG_CAPTURE_TARGET_MISMATCH", target.listingKey);
    }
    canonicalInstant(capture.capturedAt, `${target.listingKey}.capturedAt`);
    const raw = input.rawResponses.get(capture.rawFile);
    if (
      !raw
      || raw.json !== renderProductTruthOperationalJson(raw.value)
      || sha256(raw.json) !== capture.rawSha256
      || Buffer.byteLength(raw.json, "utf8") !== capture.rawByteLength
    ) {
      fail("AMAZON_CATALOG_RAW_BINDING_MISMATCH", target.listingKey);
    }
    const response = object(raw.value, target.listingKey);
    if (exactAsin(String(response.asin ?? ""), target.listingKey) !== target.asin) {
      fail("AMAZON_CATALOG_RESPONSE_ASIN_MISMATCH", target.listingKey);
    }
    const attributes = response.attributes === undefined
      ? {}
      : object(response.attributes, `${target.listingKey}.attributes`);
    const identifierEvidence = identifiers(response.identifiers);
    return {
      ordinal: target.ordinal,
      listingKey: target.listingKey,
      storeIndex: target.storeIndex,
      sku: target.sku,
      asin: target.asin,
      listingTitle: target.listingTitle,
      repairLane: target.repairLane,
      rawCapture: {
        file: capture.rawFile,
        sha256: capture.rawSha256,
        byteLength: capture.rawByteLength,
        capturedAt: capture.capturedAt,
      },
      catalog: {
        asin: target.asin,
        attributes,
        identifiers: identifierEvidence,
        images: array(response.images, `${target.listingKey}.images`),
        productTypes: array(
          response.productTypes,
          `${target.listingKey}.productTypes`,
        ),
        relationships: array(
          response.relationships,
          `${target.listingKey}.relationships`,
        ),
        summaries: array(response.summaries, `${target.listingKey}.summaries`),
      },
      authority: {
        structuredMarketplaceEvidence: true,
        titleOnlyIdentityProof: false,
        identifiersAreBaseUnitProof: false,
        authorizesCanonicalMaterialization: false,
      },
    } satisfies ProductTruthAmazonCatalogListingEvidenceEntry;
  });
  return {
    schemaVersion: PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION,
    compiledAt,
    source: {
      planSha256,
      captureSha256,
      targetSetSha256: input.plan.targetSetSha256,
    },
    entries,
    counts: {
      targets: entries.length,
      entriesWithIdentifiers: entries.filter(
        (entry) => entry.catalog.identifiers.length > 0,
      ).length,
      identifierCount: entries.reduce(
        (sum, entry) => sum + entry.catalog.identifiers.length,
        0,
      ),
      entriesWithAttributes: entries.filter(
        (entry) => Object.keys(entry.catalog.attributes).length > 0,
      ).length,
      entriesWithImages: entries.filter(
        (entry) => entry.catalog.images.length > 0,
      ).length,
    },
    claims: {
      offlineCompilation: true,
      networkCalls: 0,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      titleOnlyIdentityProof: false,
      identifiersAreBaseUnitProof: false,
      authorizesCanonicalMaterialization: false,
      createsAdditionalCatalog: false,
    },
  };
}

export function renderProductTruthAmazonCatalogCapturePlan(
  value: ProductTruthAmazonCatalogCapturePlan,
): string {
  return renderProductTruthOperationalJson(value);
}

export function renderProductTruthAmazonCatalogCapture(
  value: ProductTruthAmazonCatalogCapture,
): string {
  return renderProductTruthOperationalJson(value);
}

export function renderProductTruthAmazonCatalogListingEvidence(
  value: ProductTruthAmazonCatalogListingEvidence,
): string {
  return renderProductTruthOperationalJson(value);
}
