import {
  verifyWalmartListingIntegrityCatalogArtifacts,
  walmartListingIntegrityCatalogSha256,
  type WalmartListingIntegrityCatalogCensus,
  type WalmartListingIntegrityScanPlan,
} from "./listing-integrity-catalog-orchestrator";
import {
  verifyWalmartListingIntegrityTerminalFailureDisposition,
  type WalmartListingIntegrityTerminalFailureDisposition,
} from "./listing-integrity-terminal-failure";
import {
  WALMART_LISTING_INTEGRITY_MAIN_FAILURE_DISPOSITION_SCHEMA,
  verifyWalmartListingIntegrityMainFailureDisposition,
  type WalmartListingIntegrityMainFailureDisposition,
} from "./listing-integrity-main-failure-disposition";

export const WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA =
  "walmart-listing-integrity-controlled-pool/v3" as const;
export const WALMART_LISTING_INTEGRITY_LEGACY_CONTROLLED_POOL_SCHEMA =
  "walmart-listing-integrity-controlled-pool/v2" as const;
export const WALMART_LISTING_INTEGRITY_LEGACY_CONTROLLED_POOL_V1_SCHEMA =
  "walmart-listing-integrity-controlled-pool/v1" as const;
export const WALMART_LISTING_INTEGRITY_LIVE_VERIFICATION_SCHEMA =
  "walmart-listing-integrity-live-canary-verification/v1" as const;
export const WALMART_LISTING_INTEGRITY_NO_CHANGE_VERIFICATION_SCHEMA =
  "walmart-listing-integrity-no-change-verification/v1" as const;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingIntegrityPerformanceRow {
  sku: unknown;
  storeIndex: unknown;
  units30: unknown;
  sales30: unknown;
  orders30: unknown;
  returns30: unknown;
  units90: unknown;
  sales90: unknown;
  orders90: unknown;
  returns90: unknown;
  computedAt: unknown;
}

export interface WalmartListingIntegrityCompletedCase {
  completionMode: "REPAIRED" | "AUDITED_NO_CHANGE";
  listingKey: string;
  sku: string;
  itemId: string;
  storeIndex: number;
  feedId: string | null;
  payloadSha256: string | null;
  qualifiedAt: string;
  beforeCapturedAt: string;
  afterCapturedAt: string;
  checksPassed: number;
  verificationBodySha256: string;
  verificationFileSha256: string;
  galleryFileSha256: string;
  verificationPath: string;
  galleryPath: string;
}

export interface WalmartListingIntegrityQuarantinedCase {
  listingKey: string;
  sku: string;
  itemId: string;
  storeIndex: number;
  createdAt: string;
  status: "QUARANTINED_UNRESOLVED";
  outcome: "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_TARGET"
    | "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_MAIN";
  nextAction: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN";
  dispositionBodySha256: string;
  dispositionFileSha256: string;
  dispositionPath: string;
}

export interface WalmartListingIntegrityControlledPoolItem {
  ordinal: number;
  listingKey: string;
  storeIndex: number;
  sku: string;
  itemId: string;
  title: string;
  stage: "PRODUCT_TRUTH_READY" | "SOURCE_REQUIRED";
  nextAction: "FRESH_SOURCE_AWARE_AUDIT" | "ENRICH_EXACT_PRODUCT_TRUTH";
  titleOuterCount: number | null;
  deterministicFindings: string[];
  reasonCodes: string[];
  productTruthBlockers: string[];
  performance: {
    computedAt: string | null;
    units30: number;
    sales30: number;
    orders30: number;
    returns30: number;
    units90: number;
    sales90: number;
    orders90: number;
    returns90: number;
    returnRate90: number | null;
  };
  authority: {
    productTruthReady: boolean;
    freshBuyerRereadReady: false;
    repairPlanReady: false;
    ownerPermitReady: false;
    walmartWriteAuthorized: false;
  };
}

export interface WalmartListingIntegrityControlledPool {
  schemaVersion: typeof WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA;
  poolId: string;
  bodySha256: string;
  createdAt: string;
  storeIndex: number;
  source: {
    censusId: string;
    censusBodySha256: string;
    censusFileSha256: string;
    scanPlanId: string;
    scanPlanBodySha256: string;
    scanPlanFileSha256: string;
    authoritativeManifestSha256: string;
  };
  policy: {
    mode: "READ_ONLY_CONTROLLED_POOL";
    requestedSize: number;
    sourceRequiredPreviewSize: number;
    strictSequence: true;
    maxApplyInFlight: 1;
    automaticRetryAllowed: false;
    unknownPostReplayAllowed: false;
    walmartWritesAllowed: false;
    modelCallsAllowed: false;
    paidProviderCallsAllowed: false;
    terminalFailureMayQuarantineAndAdvance: true;
  };
  completedListingKeys: string[];
  quarantinedListingKeys: string[];
  processedControlListingKeys?: string[];
  reservedListingKeys?: string[];
  readmission?: WalmartListingIntegrityControlledPoolReadmission;
  quarantinedItems: WalmartListingIntegrityQuarantinedCase[];
  items: WalmartListingIntegrityControlledPoolItem[];
  sourceRequiredItems: WalmartListingIntegrityControlledPoolItem[];
  sourceReadiness: {
    candidateCount: number;
    repairReadyCount: number;
    sourceRequiredCount: number;
    quarantinedCount: number;
  };
  externalEffects: {
    databaseReads: number;
    databaseWrites: 0;
    walmartReads: 0;
    walmartWrites: 0;
    modelCalls: 0;
    paidProviderCalls: 0;
  };
}

export interface WalmartListingIntegrityControlledPoolReadmission {
  schemaVersion: "walmart-listing-integrity-controlled-pool-readmission/v1";
  artifactFileSha256: string;
  artifactBodySha256: string;
  items: Array<{
    listingKey: string;
    priorStateBodySha256: string;
    reasonCode: "ALGORITHM_FALSE_NEGATIVE_FIXED";
  }>;
}

export interface WalmartListingIntegrityProductTruthReadiness {
  listingKey: string;
  storeIndex: number;
  sku: string;
  listingImprovementReady: boolean;
  componentCount: number;
  blockers: string[];
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactText(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be bounded exact text`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  const digest = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label} must be SHA-256`);
  return digest;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function nonNegativeNumber(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function instant(value: unknown, label: string): string {
  const text = exactText(value, label, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

export function parseWalmartListingIntegrityCompletedCase(input: {
  verification: unknown;
  verificationFileSha256: string;
  galleryFileSha256: string;
  verificationPath: string;
  galleryPath: string;
}): WalmartListingIntegrityCompletedCase {
  const value = record(input.verification, "live verification");
  const claimedBodySha = exactSha(value.body_sha256, "live verification body_sha256");
  const body = { ...value };
  delete body.body_sha256;
  if (walmartListingIntegrityCatalogSha256(body) !== claimedBodySha) {
    throw new Error("live verification body SHA mismatch");
  }
  const repaired = value.schema_version === WALMART_LISTING_INTEGRITY_LIVE_VERIFICATION_SCHEMA;
  const noChange = value.schema_version
    === WALMART_LISTING_INTEGRITY_NO_CHANGE_VERIFICATION_SCHEMA;
  if ((!repaired && !noChange) || value.status !== "LIVE_SURFACE_PASS") {
    throw new Error("live verification is not a supported PASS artifact");
  }
  const listing = record(value.listing, "live verification listing");
  const before = record(value.before, "live verification before");
  const after = record(value.after, "live verification after");
  const checks = record(value.checks, "live verification checks");
  const qualification = record(
    value.qualification_boundary,
    "live verification qualification boundary",
  );
  if (Object.keys(checks).length < 14 || Object.values(checks).some((entry) => entry !== true)) {
    throw new Error("live verification has a failed or missing check");
  }
  const repairedBoundary = repaired
    && qualification.buyer_facing_live_surface_verified === true
    && qualification.frozen_sequence_gate_receipt_emitted === true
    && qualification.next_sku_unblocked === true;
  const noChangeBoundary = noChange
    && value.completion_mode === "AUDITED_NO_CHANGE"
    && value.feed_id === null
    && value.exact_payload_sha256 === null
    && qualification.buyer_facing_live_surface_verified === true
    && qualification.source_aware_qualification_receipt_emitted === true
    && qualification.no_walmart_write_required === true
    && qualification.next_sku_unblocked === true;
  if (!repairedBoundary && !noChangeBoundary) {
    throw new Error("live verification is not bound to final Qualification PASS");
  }
  return {
    completionMode: repaired ? "REPAIRED" : "AUDITED_NO_CHANGE",
    listingKey: exactText(listing.listing_key, "listing.listing_key", 600),
    sku: exactText(listing.sku, "listing.sku", 500),
    itemId: exactText(listing.item_id, "listing.item_id", 100),
    storeIndex: positiveInteger(listing.store_index, "listing.store_index"),
    feedId: repaired ? exactText(value.feed_id, "feed_id", 500) : null,
    payloadSha256: repaired
      ? exactSha(value.exact_payload_sha256, "exact_payload_sha256") : null,
    qualifiedAt: noChange
      ? instant(value.qualified_at, "qualified_at")
      : instant(after.captured_at, "after.captured_at"),
    beforeCapturedAt: instant(before.captured_at, "before.captured_at"),
    afterCapturedAt: instant(after.captured_at, "after.captured_at"),
    checksPassed: Object.keys(checks).length,
    verificationBodySha256: claimedBodySha,
    verificationFileSha256: exactSha(
      input.verificationFileSha256,
      "verificationFileSha256",
    ),
    galleryFileSha256: exactSha(input.galleryFileSha256, "galleryFileSha256"),
    verificationPath: exactText(input.verificationPath, "verificationPath", 2_000),
    galleryPath: exactText(input.galleryPath, "galleryPath", 2_000),
  };
}

export function parseWalmartListingIntegrityQuarantinedCase(input: {
  disposition: unknown;
  dispositionFileSha256: string;
  dispositionPath: string;
}): WalmartListingIntegrityQuarantinedCase {
  const raw = record(input.disposition, "failure disposition");
  const mainFailure = raw.schema_version
    === WALMART_LISTING_INTEGRITY_MAIN_FAILURE_DISPOSITION_SCHEMA;
  const disposition = input.disposition as (
    WalmartListingIntegrityTerminalFailureDisposition
    | WalmartListingIntegrityMainFailureDisposition
  );
  if (mainFailure) {
    verifyWalmartListingIntegrityMainFailureDisposition(
      disposition as WalmartListingIntegrityMainFailureDisposition,
    );
  } else {
    verifyWalmartListingIntegrityTerminalFailureDisposition(
      disposition as WalmartListingIntegrityTerminalFailureDisposition,
    );
  }
  return {
    listingKey: exactText(
      disposition.listing.listing_key,
      "quarantine listing_key",
      600,
    ),
    sku: exactText(disposition.listing.sku, "quarantine sku", 500),
    itemId: exactText(disposition.listing.item_id, "quarantine item_id", 100),
    storeIndex: positiveInteger(
      disposition.listing.store_index,
      "quarantine store_index",
    ),
    createdAt: instant(disposition.created_at, "quarantine created_at"),
    status: "QUARANTINED_UNRESOLVED",
    outcome: mainFailure
      ? "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_MAIN"
      : "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_TARGET",
    nextAction: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN",
    dispositionBodySha256: exactSha(
      disposition.body_sha256,
      "quarantine body_sha256",
    ),
    dispositionFileSha256: exactSha(
      input.dispositionFileSha256,
      "quarantine file SHA",
    ),
    dispositionPath: exactText(
      input.dispositionPath,
      "quarantine disposition path",
      2_000,
    ),
  };
}

function performanceRowsBySku(
  rows: readonly WalmartListingIntegrityPerformanceRow[],
  storeIndex: number,
): Map<string, WalmartListingIntegrityControlledPoolItem["performance"]> {
  const result = new Map<string, WalmartListingIntegrityControlledPoolItem["performance"]>();
  for (const [index, row] of rows.entries()) {
    if (Number(row.storeIndex) !== storeIndex) continue;
    const sku = exactText(row.sku, `performance[${index}].sku`, 500);
    if (result.has(sku)) throw new Error(`duplicate performance row for ${sku}`);
    const units90 = nonNegativeNumber(row.units90);
    const returns90 = nonNegativeNumber(row.returns90);
    result.set(sku, {
      computedAt: row.computedAt == null ? null : instant(
        row.computedAt,
        `performance[${index}].computedAt`,
      ),
      units30: nonNegativeNumber(row.units30),
      sales30: nonNegativeNumber(row.sales30),
      orders30: nonNegativeNumber(row.orders30),
      returns30: nonNegativeNumber(row.returns30),
      units90,
      sales90: nonNegativeNumber(row.sales90),
      orders90: nonNegativeNumber(row.orders90),
      returns90,
      returnRate90: units90 > 0 ? returns90 / units90 : null,
    });
  }
  return result;
}

function zeroPerformance(): WalmartListingIntegrityControlledPoolItem["performance"] {
  return {
    computedAt: null,
    units30: 0,
    sales30: 0,
    orders30: 0,
    returns30: 0,
    units90: 0,
    sales90: 0,
    orders90: 0,
    returns90: 0,
    returnRate90: null,
  };
}

function compareCandidates(
  left: Omit<WalmartListingIntegrityControlledPoolItem, "ordinal">,
  right: Omit<WalmartListingIntegrityControlledPoolItem, "ordinal">,
): number {
  const findingDelta = right.deterministicFindings.length - left.deterministicFindings.length;
  if (findingDelta) return findingDelta;
  const returnDelta = right.performance.returns90 - left.performance.returns90;
  if (returnDelta) return returnDelta;
  const rateDelta = (right.performance.returnRate90 ?? -1)
    - (left.performance.returnRate90 ?? -1);
  if (rateDelta) return rateDelta;
  const unitDelta = right.performance.units90 - left.performance.units90;
  if (unitDelta) return unitDelta;
  const salesDelta = right.performance.sales90 - left.performance.sales90;
  if (salesDelta) return salesDelta;
  return left.listingKey.localeCompare(right.listingKey, "en");
}

function controlledPoolCatalogRows(input: {
  census: WalmartListingIntegrityCatalogCensus;
  excludedListingKeys: ReadonlySet<string>;
}) {
  return input.census.rows.filter((row) => (
    row.published_status === "PUBLISHED"
    && row.lifecycle_status === "ACTIVE"
    && !!row.item_id
    && !!row.title
    && !input.excludedListingKeys.has(row.listing_key)
  ));
}

export function listWalmartListingIntegrityControlledPoolCandidateScopes(input: {
  census: WalmartListingIntegrityCatalogCensus;
  completedListingKeys: readonly string[];
  quarantinedListingKeys?: readonly string[];
  processedControlListingKeys?: readonly string[];
  reservedListingKeys?: readonly string[];
}): Array<{ listingKey: string; storeIndex: number; sku: string }> {
  const excluded = new Set([
    ...input.completedListingKeys,
    ...(input.quarantinedListingKeys ?? []),
    ...(input.processedControlListingKeys ?? []),
    ...(input.reservedListingKeys ?? []),
  ]);
  return controlledPoolCatalogRows({
    census: input.census,
    excludedListingKeys: excluded,
  }).map((row) => ({
    listingKey: row.listing_key,
    storeIndex: row.store_index,
    sku: row.sku,
  }));
}

export function buildWalmartListingIntegrityControlledPool(input: {
  census: WalmartListingIntegrityCatalogCensus;
  scanPlan: WalmartListingIntegrityScanPlan;
  censusFileSha256: string;
  scanPlanFileSha256: string;
  performanceRows: readonly WalmartListingIntegrityPerformanceRow[];
  productTruthReadiness: readonly WalmartListingIntegrityProductTruthReadiness[];
  authoritativeManifestSha256: string;
  databaseReads: number;
  completedCases: readonly WalmartListingIntegrityCompletedCase[];
  quarantinedCases?: readonly WalmartListingIntegrityQuarantinedCase[];
  processedControlListingKeys?: readonly string[];
  reservedListingKeys?: readonly string[];
  readmission?: WalmartListingIntegrityControlledPoolReadmission;
  createdAt: string;
  requestedSize: number;
}): WalmartListingIntegrityControlledPool {
  verifyWalmartListingIntegrityCatalogArtifacts({
    census: input.census,
    plan: input.scanPlan,
  });
  const requestedSize = positiveInteger(input.requestedSize, "requestedSize");
  if (requestedSize > 50) throw new Error("requestedSize must not exceed 50");
  const createdAt = instant(input.createdAt, "createdAt");
  const completedListingKeys = [...new Set(
    input.completedCases.map((entry) => entry.listingKey),
  )].sort((left, right) => left.localeCompare(right, "en"));
  const completed = new Set(completedListingKeys);
  const quarantinedByListing = new Map<
    string,
    WalmartListingIntegrityQuarantinedCase
  >();
  for (const candidate of [...(input.quarantinedCases ?? [])].sort((left, right) => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || right.dispositionFileSha256.localeCompare(left.dispositionFileSha256, "en")
  ))) {
    if (candidate.storeIndex !== input.census.store_index) {
      throw new Error(`quarantine store differs for ${candidate.listingKey}`);
    }
    const previous = quarantinedByListing.get(candidate.listingKey);
    if (previous
      && (previous.sku !== candidate.sku || previous.itemId !== candidate.itemId)) {
      throw new Error(`quarantine identity conflict for ${candidate.listingKey}`);
    }
    if (!previous) quarantinedByListing.set(candidate.listingKey, candidate);
  }
  const quarantinedItems = [...quarantinedByListing.values()].sort(
    (left, right) => left.listingKey.localeCompare(right.listingKey, "en"),
  );
  const quarantinedListingKeys = quarantinedItems.map((entry) => entry.listingKey);
  if (quarantinedListingKeys.some((listingKey) => completed.has(listingKey))) {
    throw new Error("one listing cannot be both completed and quarantined");
  }
  const processedControlListingKeys = [...new Set(input.processedControlListingKeys ?? [])]
    .map((listingKey, index) => exactText(
      listingKey,
      `processedControlListingKeys[${index}]`,
      600,
    ))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (processedControlListingKeys.some((listingKey) => (
    !listingKey.startsWith(`walmart:${input.census.store_index}:`)
  ))) {
    throw new Error("processed control listing key belongs to another store");
  }
  const reservedListingKeys = [...new Set(input.reservedListingKeys ?? [])]
    .map((listingKey, index) => exactText(
      listingKey,
      `reservedListingKeys[${index}]`,
      600,
    ))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (reservedListingKeys.some((listingKey) => (
    !listingKey.startsWith(`walmart:${input.census.store_index}:`)
    || completed.has(listingKey)
    || quarantinedByListing.has(listingKey)
  ))) {
    throw new Error("reserved listing key is invalid or already terminal");
  }
  const readmission = input.readmission ? {
    schemaVersion: input.readmission.schemaVersion,
    artifactFileSha256: exactSha(
      input.readmission.artifactFileSha256,
      "readmission.artifactFileSha256",
    ),
    artifactBodySha256: exactSha(
      input.readmission.artifactBodySha256,
      "readmission.artifactBodySha256",
    ),
    items: [...input.readmission.items]
      .map((item, index) => ({
        listingKey: exactText(item.listingKey, `readmission.items[${index}].listingKey`, 600),
        priorStateBodySha256: exactSha(
          item.priorStateBodySha256,
          `readmission.items[${index}].priorStateBodySha256`,
        ),
        reasonCode: item.reasonCode,
      }))
      .sort((left, right) => left.listingKey.localeCompare(right.listingKey, "en")),
  } : undefined;
  const readmittedListingKeys = new Set(readmission?.items.map((item) => item.listingKey) ?? []);
  if (readmission && (
    readmission.schemaVersion !== "walmart-listing-integrity-controlled-pool-readmission/v1"
    || readmission.items.length < 1
    || readmission.items.length > requestedSize
    || readmittedListingKeys.size !== readmission.items.length
    || readmission.items.some((item) => (
      item.reasonCode !== "ALGORITHM_FALSE_NEGATIVE_FIXED"
      || !item.listingKey.startsWith(`walmart:${input.census.store_index}:`)
      || completed.has(item.listingKey)
      || quarantinedByListing.has(item.listingKey)
      || processedControlListingKeys.includes(item.listingKey)
      || reservedListingKeys.includes(item.listingKey)
    ))
  )) {
    throw new Error("controlled readmission is invalid or still excluded");
  }
  const excluded = new Set([
    ...completedListingKeys,
    ...quarantinedListingKeys,
    ...processedControlListingKeys,
    ...reservedListingKeys,
  ]);
  const performance = performanceRowsBySku(input.performanceRows, input.census.store_index);
  const candidateRows = controlledPoolCatalogRows({
    census: input.census,
    excludedListingKeys: excluded,
  });
  const readiness = new Map<string, WalmartListingIntegrityProductTruthReadiness>();
  for (const [index, row] of input.productTruthReadiness.entries()) {
    const listingKey = exactText(row.listingKey, `productTruthReadiness[${index}].listingKey`, 600);
    if (readiness.has(listingKey)
      || row.storeIndex !== input.census.store_index
      || row.sku !== listingKey.slice(`walmart:${row.storeIndex}:`.length)
      || !Array.isArray(row.blockers)
      || row.blockers.some((blocker) => typeof blocker !== "string")
      || !Number.isSafeInteger(row.componentCount)
      || row.componentCount < 0) {
      throw new Error(`invalid or duplicate Product Truth readiness for ${listingKey}`);
    }
    readiness.set(listingKey, row);
  }
  if (readiness.size !== candidateRows.length
    || candidateRows.some((row) => !readiness.has(row.listing_key))) {
    throw new Error("Product Truth readiness must cover every exact controlled-pool candidate");
  }
  const candidates = candidateRows
    .map((row): Omit<WalmartListingIntegrityControlledPoolItem, "ordinal"> => {
      const truth = readiness.get(row.listing_key)!;
      const productTruthReady = truth.listingImprovementReady
        && truth.componentCount === 1;
      return {
      listingKey: row.listing_key,
      storeIndex: row.store_index,
      sku: row.sku,
      itemId: row.item_id!,
      title: row.title!,
      stage: productTruthReady ? "PRODUCT_TRUTH_READY" : "SOURCE_REQUIRED",
      nextAction: productTruthReady
        ? "FRESH_SOURCE_AWARE_AUDIT"
        : "ENRICH_EXACT_PRODUCT_TRUTH",
      titleOuterCount: row.title_outer_count?.status === "EXACT"
        ? Number(row.title_outer_count.value)
        : null,
      deterministicFindings: [...row.deterministic_findings],
      reasonCodes: [...row.reason_codes],
      productTruthBlockers: [...truth.blockers],
      performance: performance.get(row.sku) ?? zeroPerformance(),
      authority: {
        productTruthReady,
        freshBuyerRereadReady: false,
        repairPlanReady: false,
        ownerPermitReady: false,
        walmartWriteAuthorized: false,
      },
    };
    })
    .sort((left, right) => (
      Number(readmittedListingKeys.has(right.listingKey))
      - Number(readmittedListingKeys.has(left.listingKey))
      || compareCandidates(left, right)
    ));
  const eligible = candidates
    .filter((row) => row.authority.productTruthReady)
    .slice(0, requestedSize)
    .map((row, ordinal) => ({ ...row, ordinal }));
  const sourceRequired = candidates
    .filter((row) => !row.authority.productTruthReady)
    .slice(0, requestedSize)
    .map((row, ordinal) => ({ ...row, ordinal }));
  const selectedListingKeys = new Set(
    [...eligible, ...sourceRequired].map((item) => item.listingKey),
  );
  if (readmission?.items.some((item) => !selectedListingKeys.has(item.listingKey))) {
    throw new Error("every active readmission must enter this exact controlled pool");
  }
  const databaseReads = positiveInteger(input.databaseReads, "databaseReads");
  const body = {
    schemaVersion: WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA,
    createdAt,
    storeIndex: input.census.store_index,
    source: {
      censusId: input.census.census_id,
      censusBodySha256: input.census.body_sha256,
      censusFileSha256: exactSha(input.censusFileSha256, "censusFileSha256"),
      scanPlanId: input.scanPlan.plan_id,
      scanPlanBodySha256: input.scanPlan.body_sha256,
      scanPlanFileSha256: exactSha(input.scanPlanFileSha256, "scanPlanFileSha256"),
      authoritativeManifestSha256: exactSha(
        input.authoritativeManifestSha256,
        "authoritativeManifestSha256",
      ),
    },
    policy: {
      mode: "READ_ONLY_CONTROLLED_POOL" as const,
      requestedSize,
      sourceRequiredPreviewSize: requestedSize,
      strictSequence: true as const,
      maxApplyInFlight: 1 as const,
      automaticRetryAllowed: false as const,
      unknownPostReplayAllowed: false as const,
      walmartWritesAllowed: false as const,
      modelCallsAllowed: false as const,
      paidProviderCallsAllowed: false as const,
      terminalFailureMayQuarantineAndAdvance: true as const,
    },
    completedListingKeys,
    quarantinedListingKeys,
    processedControlListingKeys,
    reservedListingKeys,
    quarantinedItems,
    items: eligible,
    sourceRequiredItems: sourceRequired,
    ...(readmission ? { readmission } : {}),
    sourceReadiness: {
      candidateCount: candidates.length,
      repairReadyCount: candidates.filter((row) => row.authority.productTruthReady).length,
      sourceRequiredCount: candidates.filter((row) => !row.authority.productTruthReady).length,
      quarantinedCount: quarantinedItems.length,
    },
    externalEffects: {
      databaseReads,
      databaseWrites: 0 as const,
      walmartReads: 0 as const,
      walmartWrites: 0 as const,
      modelCalls: 0 as const,
      paidProviderCalls: 0 as const,
    },
  };
  const bodySha256 = walmartListingIntegrityCatalogSha256(body);
  return {
    ...body,
    poolId: `controlled-pool-${bodySha256.slice(0, 20)}`,
    bodySha256,
  };
}

export function verifyWalmartListingIntegrityControlledPool(
  value: WalmartListingIntegrityControlledPool,
): void {
  const { poolId, bodySha256, ...body } = value;
  const rebuilt = walmartListingIntegrityCatalogSha256(body);
  const reservedListingKeys = value.reservedListingKeys ?? [];
  const processedControlListingKeys = value.processedControlListingKeys ?? [];
  const reservedSet = new Set(reservedListingKeys);
  const processedControlSet = new Set(processedControlListingKeys);
  const readmissionItems = value.readmission?.items ?? [];
  const readmissionSet = new Set(readmissionItems.map((item) => item.listingKey));
  const selectedSet = new Set([
    ...value.items.map((item) => item.listingKey),
    ...value.sourceRequiredItems.map((item) => item.listingKey),
  ]);
  if (bodySha256 !== rebuilt || poolId !== `controlled-pool-${rebuilt.slice(0, 20)}`) {
    throw new Error("controlled pool seal mismatch");
  }
  if (value.schemaVersion !== WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA
    || value.policy.mode !== "READ_ONLY_CONTROLLED_POOL"
    || value.policy.maxApplyInFlight !== 1
    || value.policy.walmartWritesAllowed !== false
    || value.policy.automaticRetryAllowed !== false
    || value.policy.terminalFailureMayQuarantineAndAdvance !== true
    || value.items.length > value.policy.requestedSize
    || value.sourceRequiredItems.length > value.policy.sourceRequiredPreviewSize
    || value.sourceReadiness.candidateCount
      !== value.sourceReadiness.repairReadyCount + value.sourceReadiness.sourceRequiredCount
    || value.sourceReadiness.quarantinedCount !== value.quarantinedItems.length
    || value.quarantinedItems.length !== value.quarantinedListingKeys.length
    || (value.readmission !== undefined && (
      value.readmission.schemaVersion
        !== "walmart-listing-integrity-controlled-pool-readmission/v1"
      || !/^[a-f0-9]{64}$/u.test(value.readmission.artifactFileSha256)
      || !/^[a-f0-9]{64}$/u.test(value.readmission.artifactBodySha256)
      || readmissionItems.length < 1
      || readmissionItems.length > value.policy.requestedSize
      || readmissionSet.size !== readmissionItems.length
      || readmissionItems.some((item, index) => (
        item.reasonCode !== "ALGORITHM_FALSE_NEGATIVE_FIXED"
        || (index > 0
          && readmissionItems[index - 1]!.listingKey.localeCompare(item.listingKey, "en") >= 0)
        || value.completedListingKeys.includes(item.listingKey)
        || value.quarantinedListingKeys.includes(item.listingKey)
        || processedControlSet.has(item.listingKey)
        || reservedSet.has(item.listingKey)
        || !selectedSet.has(item.listingKey)
        || !/^[a-f0-9]{64}$/u.test(item.priorStateBodySha256)
      ))
    ))
    || processedControlSet.size !== processedControlListingKeys.length
    || processedControlListingKeys.some((key, index) => (
      typeof key !== "string"
      || !key.startsWith(`walmart:${value.storeIndex}:`)
      || (index > 0 && processedControlListingKeys[index - 1]!.localeCompare(key, "en") >= 0)
    ))
    || value.quarantinedItems.some((item, index) => (
      item.listingKey !== value.quarantinedListingKeys[index]
      || item.status !== "QUARANTINED_UNRESOLVED"
      || ![
        "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_TARGET",
        "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_MAIN",
      ].includes(item.outcome)
      || item.nextAction !== "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN"
    ))
    || value.completedListingKeys.some((key) => value.quarantinedListingKeys.includes(key))
    || reservedSet.size !== reservedListingKeys.length
    || reservedListingKeys.some((key, index) => (
      typeof key !== "string"
      || !key.startsWith(`walmart:${value.storeIndex}:`)
      || (index > 0 && reservedListingKeys[index - 1]!.localeCompare(key, "en") >= 0)
      || value.completedListingKeys.includes(key)
      || value.quarantinedListingKeys.includes(key)
      || processedControlSet.has(key)
    ))
    || value.items.some((item, index) => (
      item.ordinal !== index
      || reservedSet.has(item.listingKey)
      || processedControlSet.has(item.listingKey)
      || item.stage !== "PRODUCT_TRUTH_READY"
      || item.nextAction !== "FRESH_SOURCE_AWARE_AUDIT"
      || item.authority.productTruthReady !== true
      || item.authority.walmartWriteAuthorized !== false
    ))
    || value.sourceRequiredItems.some((item, index) => (
      item.ordinal !== index
      || reservedSet.has(item.listingKey)
      || processedControlSet.has(item.listingKey)
      || item.stage !== "SOURCE_REQUIRED"
      || item.nextAction !== "ENRICH_EXACT_PRODUCT_TRUTH"
      || item.authority.productTruthReady !== false
      || item.authority.walmartWriteAuthorized !== false
    ))) {
    throw new Error("controlled pool policy or item state is invalid");
  }
}
