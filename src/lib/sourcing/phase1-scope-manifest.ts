import { createHash } from "node:crypto";

import { buildProductTruthListingScope } from "./product-truth-listing-scope";
import {
  PHASE1_CONNECTED_STORE_CENSUS_POLICY_VERSION,
  PHASE1_CONNECTED_STORE_CENSUS_VERSION,
  inspectPhase1ConnectedStoreCensusArtifact,
  parsePhase1ConnectedStoreCensusArtifact,
  phase1CensusSha256Hex,
  renderPhase1ConnectedStoreCensusJson,
  type Phase1ConnectedStoreCensusArtifact,
} from "./phase1-connected-store-census";

export const PHASE1_SCOPE_DISPOSITION_VERSION =
  "phase1-scope-disposition/v2" as const;
export const PHASE1_SCOPE_BUILDER_POLICY_VERSION =
  "phase1-scope-builder-policy/1.1.0" as const;
export const PHASE1_SCOPE_MANIFEST_VERSION =
  "phase1-authoritative-scope-manifest/v3" as const;

export type Phase1Channel = "amazon" | "walmart";
export type Phase1ScopeDisposition =
  | "IN_SCOPE"
  | "EXCLUDED_OWNER_CONFIRMED"
  | "UNRESOLVED";

export interface Phase1OwnerDecision {
  authority: "OWNER";
  decisionId: string;
  decidedBy: string;
  decidedAt: string;
  reason: string;
}

export interface Phase1SourceReportAttestation {
  reportType: string;
  reportId: string;
  capturedAt: string;
  expectedRowCount: number;
  /** Exact bytes of the locally supplied raw marketplace report. */
  expectedContentSha256: string;
}

export interface Phase1ScopeDispositionEntry {
  channel: Phase1Channel;
  scopeKey: string;
  storeIndex: number;
  accountId: string;
  storeId: string;
  marketplaceId?: string | null;
  disposition: Phase1ScopeDisposition;
  decision: Phase1OwnerDecision;
  report?: Phase1SourceReportAttestation | null;
}

export interface Phase1ScopeDispositionDocument {
  schemaVersion: typeof PHASE1_SCOPE_DISPOSITION_VERSION;
  scopes: Phase1ScopeDispositionEntry[];
}

export interface Phase1LocalReportInput {
  channel: Phase1Channel;
  scopeKey: string;
  /** Stable display name only. The manifest deliberately does not need an absolute path. */
  sourceName: string;
  content: string;
}

export interface Phase1ConnectedStoreCensusInput {
  /** Stable display name only. Absolute paths are not persisted. */
  sourceName: string;
  /** Exact canonical bytes emitted by build-phase1-connected-store-census. */
  content: string;
}

export interface BuildPhase1ScopeManifestInput {
  asOf: string;
  connectedStoreCensus: Phase1ConnectedStoreCensusInput;
  /**
   * Retained only so older callers fail with a precise blocker. A competing
   * hand-entered denominator is never accepted once census is authoritative.
   */
  requiredScopes?: Record<Phase1Channel, string[]>;
  disposition: unknown;
  reports: Phase1LocalReportInput[];
  maxReportAgeHours?: number;
  maxReportSkewHours?: number;
}

export type Phase1BlockerCode =
  | "INVALID_AS_OF"
  | "INVALID_CONFIGURATION"
  | "MISSING_CONNECTED_STORE_CENSUS"
  | "INVALID_CONNECTED_STORE_CENSUS"
  | "BLOCKED_CONNECTED_STORE_CENSUS"
  | "CONNECTED_STORE_CENSUS_AS_OF_MISMATCH"
  | "MANUAL_REQUIRED_SCOPES_FORBIDDEN"
  | "CENSUS_DISPOSITION_IDENTITY_MISMATCH"
  | "INVALID_DISPOSITION_DOCUMENT"
  | "INVALID_DISPOSITION_ENTRY"
  | "MISSING_REQUIRED_SCOPE_DECLARATION"
  | "DUPLICATE_REQUIRED_SCOPE"
  | "MISSING_ACCOUNT_DISPOSITION"
  | "DUPLICATE_ACCOUNT_DISPOSITION"
  | "UNDECLARED_SCOPE"
  | "UNRESOLVED_ACCOUNT_DISPOSITION"
  | "INVALID_OWNER_DECISION"
  | "INVALID_SCOPE_IDENTITY"
  | "INVALID_STORE_INDEX"
  | "SCOPE_STORE_INDEX_MISMATCH"
  | "DUPLICATE_STORE_INDEX_MAPPING"
  | "MISSING_SOURCE_REPORT_ATTESTATION"
  | "UNEXPECTED_SOURCE_REPORT_ATTESTATION"
  | "INVALID_SOURCE_REPORT_ATTESTATION"
  | "MISSING_LOCAL_REPORT"
  | "UNEXPECTED_LOCAL_REPORT"
  | "DUPLICATE_LOCAL_REPORT"
  | "INVALID_LOCAL_REPORT_INPUT"
  | "REPORT_TYPE_MISMATCH"
  | "REPORT_TIMESTAMP_INVALID"
  | "REPORT_TIMESTAMP_IN_FUTURE"
  | "REPORT_STALE"
  | "REPORT_SNAPSHOT_SKEW"
  | "REPORT_CONTENT_HASH_MISMATCH"
  | "REPORT_ROW_COUNT_MISMATCH"
  | "REPORT_FORMAT_MISMATCH"
  | "SUSPICIOUS_KNOWN_ROW_CAP"
  | "DUPLICATE_REPORT_CONTENT"
  | "DUPLICATE_SOURCE_REPORT_ID"
  | "REPORT_PARSE_ERROR"
  | "MISSING_REQUIRED_COLUMN"
  | "AMBIGUOUS_REQUIRED_COLUMN"
  | "MALFORMED_REPORT_ROW"
  | "INVALID_RAW_SKU"
  | "UNKNOWN_SOURCE_STATUS"
  | "MISSING_LISTING_IDENTITY"
  | "CONTRADICTORY_LIVE_STATUS"
  | "DUPLICATE_LISTING_KEY"
  | "RAW_SKU_COLLISION";

export interface Phase1ManifestBlocker {
  code: Phase1BlockerCode;
  channel: Phase1Channel | null;
  scopeKey: string | null;
  message: string;
  details: Record<string, unknown> | null;
}

export interface Phase1ScopeDispositionRecord {
  channel: Phase1Channel;
  scopeKey: string;
  storeIndex: number;
  accountId: string;
  storeId: string;
  marketplaceId: string | null;
  disposition: Phase1ScopeDisposition;
  decisionId: string;
  decidedBy: string;
  decidedAt: string;
  reason: string;
}

export interface Phase1SourceReportRecord {
  channel: Phase1Channel;
  scopeKey: string;
  storeIndex: number;
  accountId: string;
  storeId: string;
  marketplaceId: string | null;
  reportType: string;
  reportId: string;
  capturedAt: string;
  sourceName: string;
  contentSha256: string;
  byteLength: number;
  delimiter: "comma" | "tab";
  headers: string[];
  totalRows: number;
  expectedRowCount: number;
  liveRows: number;
  statusCounts: Record<string, number>;
}

export type Phase1ListingLifecycleStatus = "NOT_STARTED";

export interface Phase1ScopeListing {
  channel: Phase1Channel;
  scopeKey: string;
  storeIndex: number;
  accountId: string;
  storeId: string;
  marketplaceId: string | null;
  listingKey: string;
  listingId: string;
  sku: string;
  title: string;
  sourceStatus: string;
  sourceLifecycleStatus: string | null;
  phase1Status: Phase1ListingLifecycleStatus;
  sourceReportId: string;
  sourceCapturedAt: string;
  sourceContentSha256: string;
}

export interface Phase1ScopeCollision {
  type: "RAW_SKU" | "CASE_INSENSITIVE_RAW_SKU" | "LISTING_ID_REUSED";
  key: string;
  blocking: boolean;
  listingKeys: string[];
  rawSkus: string[];
}

export interface Phase1ScopeManifest {
  schemaVersion: typeof PHASE1_SCOPE_MANIFEST_VERSION;
  phase: "PHASE_1_CURRENT_BUSINESS_COVERAGE";
  asOf: string;
  authoritative: boolean;
  policy: {
    builderPolicyVersion: typeof PHASE1_SCOPE_BUILDER_POLICY_VERSION;
    dispositionSchemaVersion: typeof PHASE1_SCOPE_DISPOSITION_VERSION;
    dispositionInputSha256: string;
    requiredScopesSha256: string;
    connectedStoreCensusSchemaVersion: typeof PHASE1_CONNECTED_STORE_CENSUS_VERSION;
    connectedStoreCensusPolicyVersion: typeof PHASE1_CONNECTED_STORE_CENSUS_POLICY_VERSION;
    connectedStoreCensusContentSha256: string;
    connectedStoreCaptureSha256: string;
    amazonLivePredicate: "status=ACTIVE";
    walmartLivePredicate: "publishedStatus=PUBLISHED";
    rawSkuDeduplication: "FORBIDDEN_WITHOUT_SEMANTIC_CONFIRMATION";
    maxReportAgeHours: number;
    maxReportSkewHours: number;
  };
  connectedStoreCensus: Phase1ConnectedStoreCensusArtifact | null;
  requiredScopes: Record<Phase1Channel, string[]>;
  scopeDispositions: Phase1ScopeDispositionRecord[];
  sourceReports: Phase1SourceReportRecord[];
  counts: {
    requiredScopes: number;
    inScopeReports: number;
    sourceRows: number;
    liveListings: number;
    amazonLiveListings: number;
    walmartLiveListings: number;
    blockerCount: number;
    collisionGroups: number;
  };
  listings: Phase1ScopeListing[];
  collisions: Phase1ScopeCollision[];
  blockers: Phase1ManifestBlocker[];
}

interface ParsedDelimitedText {
  delimiter: "comma" | "tab";
  headers: string[];
  rows: string[][];
  errors: string[];
}

interface NormalizedDispositionEntry extends Phase1ScopeDispositionEntry {
  scopeKey: string;
  marketplaceId: string | null;
  decision: Phase1OwnerDecision & { decidedAt: string };
  report: (Phase1SourceReportAttestation & { capturedAt: string }) | null;
}

const EXPECTED_REPORT_TYPE: Record<Phase1Channel, string> = {
  amazon: "GET_MERCHANT_LISTINGS_ALL_DATA",
  walmart: "ITEM_CATALOG",
};

const EXPECTED_REPORT_DELIMITERS: Record<
  Phase1Channel,
  readonly ParsedDelimitedText["delimiter"][]
> = {
  amazon: ["tab"],
  // Walmart ITEM v4 exports have been observed as both CSV and TSV. The
  // parser remains strict about one delimiter per report and required columns.
  walmart: ["comma", "tab"],
};

/*
 * Unknown statuses are blockers: silently treating a newly introduced status
 * as non-live could drop a sellable listing from the Phase 1 denominator.
 * Expand these sets only after validating a real raw report revision.
 */
const KNOWN_SOURCE_STATUSES: Record<Phase1Channel, ReadonlySet<string>> = {
  amazon: new Set(["ACTIVE", "INACTIVE", "INCOMPLETE"]),
  walmart: new Set(["PUBLISHED", "UNPUBLISHED"]),
};

const KNOWN_WALMART_LIFECYCLE_STATUSES = new Set([
  "ACTIVE",
  "ARCHIVED",
  "RETIRED",
]);

const KNOWN_SUSPICIOUS_EXACT_ROW_CAPS: Record<Phase1Channel, readonly number[]> = {
  amazon: [1000],
  walmart: [],
};

const DEFAULT_MAX_REPORT_AGE_HOURS = 36;
const DEFAULT_MAX_REPORT_SKEW_HOURS = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 ? result : null;
}

function normalizeScopeKey(value: string): string {
  return value.trim().toLowerCase();
}

function scopeId(channel: Phase1Channel, scopeKey: string): string {
  return `${channel}:${normalizeScopeKey(scopeKey)}`;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return null;
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function positiveStoreIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function normalizeStatus(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareChannel(a: Phase1Channel, b: Phase1Channel): number {
  return compareText(a, b);
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function detectDelimiter(text: string): "\t" | "," {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

/** RFC-4180-style parser used for both comma and tab exports. It performs no I/O. */
export function parsePhase1DelimitedText(text: string): ParsedDelimitedText {
  const delimiter = detectDelimiter(text);
  const rawRows: string[][] = [];
  const errors: string[] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const finishCell = (): void => {
    row.push(cell);
    cell = "";
  };
  const finishRow = (): void => {
    finishCell();
    if (row.some((value) => value.trim().length > 0)) rawRows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (character === delimiter) {
      finishCell();
    } else if (character === "\n") {
      finishRow();
    } else if (character === "\r") {
      if (text[index + 1] !== "\n") finishRow();
    } else {
      cell += character;
    }
  }

  if (inQuotes) errors.push("Unclosed quoted field at end of report.");
  if (cell.length > 0 || row.length > 0) finishRow();

  const headers = (rawRows.shift() ?? []).map((value, index) =>
    index === 0 ? value.replace(/^\uFEFF/, "").trim() : value.trim(),
  );
  if (headers.length === 0) errors.push("Report has no header row.");
  for (let index = 0; index < rawRows.length; index += 1) {
    if (rawRows[index].length !== headers.length) {
      errors.push(
        `Data row ${index + 2} has ${rawRows[index].length} cells; expected ${headers.length}.`,
      );
    }
  }

  return {
    delimiter: delimiter === "\t" ? "tab" : "comma",
    headers,
    rows: rawRows,
    errors,
  };
}

function headerIndex(headers: string[]): Map<string, number> {
  const result = new Map<string, number>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!result.has(normalized)) result.set(normalized, index);
  });
  return result;
}

function readCell(
  row: string[],
  indexes: Map<string, number>,
  aliases: readonly string[],
): string {
  for (const alias of aliases) {
    const index = indexes.get(normalizeHeader(alias));
    if (index !== undefined) return (row[index] ?? "").trim();
  }
  return "";
}

function readExactCell(
  row: string[],
  indexes: Map<string, number>,
  aliases: readonly string[],
): string {
  for (const alias of aliases) {
    const index = indexes.get(normalizeHeader(alias));
    if (index !== undefined) return row[index] ?? "";
  }
  return "";
}

function matchingColumnIndexes(
  headers: readonly string[],
  aliases: readonly string[],
): number[] {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  const result: number[] = [];
  headers.forEach((header, index) => {
    if (normalizedAliases.has(normalizeHeader(header))) result.push(index);
  });
  return result;
}

const AMAZON_COLUMNS = {
  sku: ["seller-sku", "seller sku", "merchant-sku"],
  listingId: ["asin1", "asin"],
  title: ["item-name", "item name", "title"],
  status: ["status"],
} as const;

const WALMART_COLUMNS = {
  sku: ["SKU", "Seller SKU", "sellerSku", "merchantSku"],
  listingId: ["Item ID", "itemId", "WPID", "Walmart Item ID"],
  title: ["Product Name", "Item Name", "Product Title", "title"],
  status: [
    "Published Status",
    "publishedStatus",
    "Publish Status",
    "Publishing Status",
  ],
  lifecycleStatus: ["Lifecycle Status", "lifecycleStatus", "Lifecycle"],
} as const;

function sortDetails(value: Record<string, unknown> | null): string {
  return value == null ? "" : stableJsonStringify(value, 0);
}

function sortBlockers(blockers: Phase1ManifestBlocker[]): void {
  blockers.sort((a, b) =>
    compareText(a.code, b.code) ||
    compareText(a.channel ?? "", b.channel ?? "") ||
    compareText(a.scopeKey ?? "", b.scopeKey ?? "") ||
    compareText(a.message, b.message) ||
    compareText(sortDetails(a.details), sortDetails(b.details)),
  );
}

function parseDisposition(
  value: unknown,
  asOfMs: number | null,
  addBlocker: (blocker: Phase1ManifestBlocker) => void,
): NormalizedDispositionEntry[] {
  if (!isRecord(value)) {
    addBlocker({
      code: "INVALID_DISPOSITION_DOCUMENT",
      channel: null,
      scopeKey: null,
      message: "Disposition input must be a JSON object.",
      details: null,
    });
    return [];
  }
  if (value.schemaVersion !== PHASE1_SCOPE_DISPOSITION_VERSION) {
    addBlocker({
      code: "INVALID_DISPOSITION_DOCUMENT",
      channel: null,
      scopeKey: null,
      message: `Disposition schemaVersion must be ${PHASE1_SCOPE_DISPOSITION_VERSION}.`,
      details: { received: value.schemaVersion ?? null },
    });
  }
  if (!Array.isArray(value.scopes)) {
    addBlocker({
      code: "INVALID_DISPOSITION_DOCUMENT",
      channel: null,
      scopeKey: null,
      message: "Disposition document must contain a scopes array.",
      details: null,
    });
    return [];
  }

  const normalized: NormalizedDispositionEntry[] = [];
  value.scopes.forEach((raw, index) => {
    if (!isRecord(raw)) {
      addBlocker({
        code: "INVALID_DISPOSITION_ENTRY",
        channel: null,
        scopeKey: null,
        message: `Disposition scopes[${index}] must be an object.`,
        details: null,
      });
      return;
    }
    const channel = raw.channel === "amazon" || raw.channel === "walmart"
      ? raw.channel
      : null;
    const rawScopeKey = nonEmptyString(raw.scopeKey);
    const key = rawScopeKey ? normalizeScopeKey(rawScopeKey) : null;
    if (!channel || !key) {
      addBlocker({
        code: "INVALID_DISPOSITION_ENTRY",
        channel,
        scopeKey: key,
        message: `Disposition scopes[${index}] needs channel amazon|walmart and scopeKey.`,
        details: null,
      });
      return;
    }

    const storeIndex = positiveStoreIndex(raw.storeIndex);
    if (storeIndex === null) {
      addBlocker({
        code: "INVALID_STORE_INDEX",
        channel,
        scopeKey: key,
        message: "Every scope needs an explicit positive integer storeIndex.",
        details: { received: raw.storeIndex ?? null },
      });
    }
    const conventionalScope = /^store([1-9][0-9]*)$/.exec(key);
    if (
      conventionalScope &&
      storeIndex !== null &&
      Number(conventionalScope[1]) !== storeIndex
    ) {
      addBlocker({
        code: "SCOPE_STORE_INDEX_MISMATCH",
        channel,
        scopeKey: key,
        message: "A conventional storeN scopeKey must map to the same numeric storeIndex.",
        details: {
          scopeKeyStoreIndex: Number(conventionalScope[1]),
          declaredStoreIndex: storeIndex,
        },
      });
    }

    const accountId = nonEmptyString(raw.accountId);
    const storeId = nonEmptyString(raw.storeId);
    const marketplaceId = raw.marketplaceId == null
      ? null
      : nonEmptyString(raw.marketplaceId);
    if (!accountId || !storeId || (channel === "amazon" && !marketplaceId)) {
      addBlocker({
        code: "INVALID_SCOPE_IDENTITY",
        channel,
        scopeKey: key,
        message: "Every scope needs accountId and storeId; Amazon also needs marketplaceId.",
        details: {
          hasAccountId: Boolean(accountId),
          hasStoreId: Boolean(storeId),
          hasMarketplaceId: Boolean(marketplaceId),
        },
      });
    }

    const disposition =
      raw.disposition === "IN_SCOPE" ||
      raw.disposition === "EXCLUDED_OWNER_CONFIRMED" ||
      raw.disposition === "UNRESOLVED"
        ? raw.disposition
        : null;
    if (!disposition) {
      addBlocker({
        code: "INVALID_DISPOSITION_ENTRY",
        channel,
        scopeKey: key,
        message: "Disposition must be IN_SCOPE, EXCLUDED_OWNER_CONFIRMED, or UNRESOLVED.",
        details: { received: raw.disposition ?? null },
      });
      return;
    }

    const decision = isRecord(raw.decision) ? raw.decision : null;
    const decisionId = decision ? nonEmptyString(decision.decisionId) : null;
    const decidedBy = decision ? nonEmptyString(decision.decidedBy) : null;
    const decidedAt = decision ? normalizeIsoTimestamp(decision.decidedAt) : null;
    const reason = decision ? nonEmptyString(decision.reason) : null;
    if (
      !decision ||
      decision.authority !== "OWNER" ||
      !decisionId ||
      !decidedBy ||
      !decidedAt ||
      !reason ||
      (asOfMs !== null && Date.parse(decidedAt) > asOfMs)
    ) {
      addBlocker({
        code: "INVALID_OWNER_DECISION",
        channel,
        scopeKey: key,
        message: "Every account/store disposition needs a complete OWNER decision at or before asOf.",
        details: null,
      });
    }

    const reportRaw = raw.report == null ? null : isRecord(raw.report) ? raw.report : null;
    let report: NormalizedDispositionEntry["report"] = null;
    if (disposition === "IN_SCOPE") {
      if (!reportRaw) {
        addBlocker({
          code: "MISSING_SOURCE_REPORT_ATTESTATION",
          channel,
          scopeKey: key,
          message: "IN_SCOPE disposition requires source report metadata.",
          details: null,
        });
      } else {
        const reportType = nonEmptyString(reportRaw.reportType);
        const reportId = nonEmptyString(reportRaw.reportId);
        const capturedAt = normalizeIsoTimestamp(reportRaw.capturedAt);
        const expectedRowCount = nonNegativeInteger(reportRaw.expectedRowCount);
        const expectedContentSha256 = nonEmptyString(
          reportRaw.expectedContentSha256,
        )?.toLowerCase();
        if (
          !reportType ||
          !reportId ||
          !capturedAt ||
          expectedRowCount == null ||
          !expectedContentSha256 ||
          !/^[a-f0-9]{64}$/.test(expectedContentSha256)
        ) {
          addBlocker({
            code: "INVALID_SOURCE_REPORT_ATTESTATION",
            channel,
            scopeKey: key,
            message: "Report metadata needs reportType, reportId, zoned capturedAt, non-negative expectedRowCount, and the exact raw-report SHA-256.",
            details: null,
          });
        } else {
          report = {
            reportType,
            reportId,
            capturedAt,
            expectedRowCount,
            expectedContentSha256,
          };
        }
      }
    } else if (raw.report != null) {
      addBlocker({
        code: "UNEXPECTED_SOURCE_REPORT_ATTESTATION",
        channel,
        scopeKey: key,
        message: `${disposition} scope must not carry an in-scope report attestation.`,
        details: null,
      });
    }

    normalized.push({
      channel,
      scopeKey: key,
      storeIndex: storeIndex ?? 0,
      accountId: accountId ?? "",
      storeId: storeId ?? "",
      marketplaceId,
      disposition,
      decision: {
        authority: "OWNER",
        decisionId: decisionId ?? "",
        decidedBy: decidedBy ?? "",
        decidedAt: decidedAt ?? "",
        reason: reason ?? "",
      },
      report,
    });
  });
  return normalized;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    const child = value[key];
    if (child !== undefined) result[key] = stableJsonValue(child);
  }
  return result;
}

export function stableJsonStringify(value: unknown, spaces = 2): string {
  return JSON.stringify(stableJsonValue(value), null, spaces);
}

function canonicalDispositionHashPayload(
  entries: readonly NormalizedDispositionEntry[],
): {
  schemaVersion: typeof PHASE1_SCOPE_DISPOSITION_VERSION;
  scopes: NormalizedDispositionEntry[];
} {
  const scopes = entries
    .map((entry) => ({
      channel: entry.channel,
      scopeKey: entry.scopeKey,
      storeIndex: entry.storeIndex,
      accountId: entry.accountId,
      storeId: entry.storeId,
      marketplaceId: entry.marketplaceId,
      disposition: entry.disposition,
      decision: { ...entry.decision },
      report: entry.report ? { ...entry.report } : null,
    }))
    .sort((left, right) =>
      compareText(
        stableJsonStringify(left, 0),
        stableJsonStringify(right, 0),
      ),
    );
  return {
    schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
    scopes,
  };
}

/**
 * Runtime validation for the v3 policy binding. This prevents a v2 artifact
 * from being accepted merely because its top-level schemaVersion was edited.
 * The hashes are recomputed from the exact facts carried by the manifest.
 */
export function validatePhase1ScopeManifestV3Policy(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["manifest must be an object"];
  if (value.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION) {
    errors.push(`schemaVersion must be ${PHASE1_SCOPE_MANIFEST_VERSION}`);
  }

  const policy = isRecord(value.policy) ? value.policy : null;
  if (!policy) return [...errors, "policy must be an object"];
  if (policy.builderPolicyVersion !== PHASE1_SCOPE_BUILDER_POLICY_VERSION) {
    errors.push(
      `policy.builderPolicyVersion must be ${PHASE1_SCOPE_BUILDER_POLICY_VERSION}`,
    );
  }
  if (policy.dispositionSchemaVersion !== PHASE1_SCOPE_DISPOSITION_VERSION) {
    errors.push(
      `policy.dispositionSchemaVersion must be ${PHASE1_SCOPE_DISPOSITION_VERSION}`,
    );
  }
  if (policy.amazonLivePredicate !== "status=ACTIVE") {
    errors.push("policy.amazonLivePredicate is not current");
  }
  if (policy.walmartLivePredicate !== "publishedStatus=PUBLISHED") {
    errors.push("policy.walmartLivePredicate is not current");
  }
  if (
    policy.rawSkuDeduplication !==
    "FORBIDDEN_WITHOUT_SEMANTIC_CONFIRMATION"
  ) {
    errors.push("policy.rawSkuDeduplication is not current");
  }
  if (positiveFinite(policy.maxReportAgeHours) === null) {
    errors.push("policy.maxReportAgeHours must be positive and finite");
  }
  if (positiveFinite(policy.maxReportSkewHours) === null) {
    errors.push("policy.maxReportSkewHours must be positive and finite");
  }

  let embeddedCensus: Phase1ConnectedStoreCensusArtifact | null = null;
  if (!isRecord(value.connectedStoreCensus)) {
    errors.push("connectedStoreCensus must be an embedded canonical census artifact");
  } else {
    const inspected = inspectPhase1ConnectedStoreCensusArtifact(
      value.connectedStoreCensus,
    );
    embeddedCensus = inspected.artifact;
    errors.push(...inspected.errors.map((error) => `connectedStoreCensus: ${error}`));
    const canonicalCensusJson = renderPhase1ConnectedStoreCensusJson(
      inspected.artifact,
    );
    if (
      policy.connectedStoreCensusContentSha256
      !== phase1CensusSha256Hex(canonicalCensusJson)
    ) {
      errors.push(
        "policy.connectedStoreCensusContentSha256 does not match embedded census",
      );
    }
    if (
      policy.connectedStoreCaptureSha256
      !== inspected.artifact.policy.captureSha256
    ) {
      errors.push(
        "policy.connectedStoreCaptureSha256 does not match embedded census capture",
      );
    }
    if (inspected.artifact.asOf !== value.asOf) {
      errors.push("connectedStoreCensus.asOf must equal manifest asOf");
    }
  }
  if (
    policy.connectedStoreCensusSchemaVersion
    !== PHASE1_CONNECTED_STORE_CENSUS_VERSION
  ) {
    errors.push(
      `policy.connectedStoreCensusSchemaVersion must be ${PHASE1_CONNECTED_STORE_CENSUS_VERSION}`,
    );
  }
  if (
    policy.connectedStoreCensusPolicyVersion
    !== PHASE1_CONNECTED_STORE_CENSUS_POLICY_VERSION
  ) {
    errors.push(
      `policy.connectedStoreCensusPolicyVersion must be ${PHASE1_CONNECTED_STORE_CENSUS_POLICY_VERSION}`,
    );
  }
  if (
    typeof policy.connectedStoreCensusContentSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(policy.connectedStoreCensusContentSha256)
  ) {
    errors.push(
      "policy.connectedStoreCensusContentSha256 must be a lowercase SHA-256",
    );
  }
  if (
    typeof policy.connectedStoreCaptureSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(policy.connectedStoreCaptureSha256)
  ) {
    errors.push("policy.connectedStoreCaptureSha256 must be a lowercase SHA-256");
  }

  const requiredScopes = isRecord(value.requiredScopes)
    ? value.requiredScopes
    : null;
  let canonicalRequiredScopes: Record<Phase1Channel, string[]> | null = null;
  if (!requiredScopes) {
    errors.push("requiredScopes must be an object");
  } else {
    canonicalRequiredScopes = { amazon: [], walmart: [] };
    for (const channel of ["amazon", "walmart"] as const) {
      const raw = requiredScopes[channel];
      if (
        !Array.isArray(raw)
        || raw.length === 0
        || raw.some((scope) =>
          typeof scope !== "string"
          || scope !== normalizeScopeKey(scope)
          || scope.length === 0
        )
      ) {
        errors.push(`requiredScopes.${channel} is not canonical`);
        canonicalRequiredScopes = null;
        continue;
      }
      const sorted = [...new Set(raw)].sort(compareText);
      if (
        sorted.length !== raw.length
        || sorted.some((scope, index) => scope !== raw[index])
      ) {
        errors.push(`requiredScopes.${channel} must be sorted and unique`);
        canonicalRequiredScopes = null;
        continue;
      }
      if (canonicalRequiredScopes) canonicalRequiredScopes[channel] = sorted;
    }
  }
  if (canonicalRequiredScopes) {
    if (
      embeddedCensus
      && stableJsonStringify(canonicalRequiredScopes, 0)
        !== stableJsonStringify(embeddedCensus.requiredScopes, 0)
    ) {
      errors.push("requiredScopes do not equal the connected-store census denominator");
    }
    const expected = sha256Hex(
      `${stableJsonStringify(canonicalRequiredScopes, 0)}\n`,
    );
    if (policy.requiredScopesSha256 !== expected) {
      errors.push("policy.requiredScopesSha256 does not match requiredScopes");
    }
  } else if (
    typeof policy.requiredScopesSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(policy.requiredScopesSha256)
  ) {
    errors.push("policy.requiredScopesSha256 must be a lowercase SHA-256");
  }

  const rawDispositions = Array.isArray(value.scopeDispositions)
    ? value.scopeDispositions
    : null;
  const rawReports = Array.isArray(value.sourceReports)
    ? value.sourceReports
    : null;
  const rawListings = Array.isArray(value.listings)
    ? value.listings
    : null;
  if (!rawDispositions) errors.push("scopeDispositions must be an array");
  if (!rawReports) errors.push("sourceReports must be an array");
  if (!rawListings) errors.push("listings must be an array");

  const requiredScopeIds = canonicalRequiredScopes
    ? new Set(
      (["amazon", "walmart"] as const).flatMap((channel) =>
        canonicalRequiredScopes[channel].map((scopeKey) => `${channel}:${scopeKey}`)
      ),
    )
    : null;
  const rawDispositionsByScope = new Map<string, Record<string, unknown>[]>();
  if (rawDispositions) {
    for (const raw of rawDispositions) {
      if (!isRecord(raw)) continue;
      if (
        (raw.channel !== "amazon" && raw.channel !== "walmart")
        || typeof raw.scopeKey !== "string"
        || raw.scopeKey !== normalizeScopeKey(raw.scopeKey)
        || raw.scopeKey.length === 0
      ) continue;
      const id = `${raw.channel}:${raw.scopeKey}`;
      const group = rawDispositionsByScope.get(id) ?? [];
      group.push(raw);
      rawDispositionsByScope.set(id, group);
    }
  }
  if (requiredScopeIds) {
    for (const id of requiredScopeIds) {
      const count = rawDispositionsByScope.get(id)?.length ?? 0;
      if (count !== 1) {
        errors.push(`scopeDispositions must contain exactly one disposition for required scope ${id}`);
      }
    }
    for (const id of rawDispositionsByScope.keys()) {
      if (!requiredScopeIds.has(id)) {
        errors.push(`scopeDispositions contains unexpected scope ${id}`);
      }
    }
  }

  const reconstructed: NormalizedDispositionEntry[] = [];
  if (rawDispositions && rawReports) {
    for (const raw of rawDispositions) {
      if (!isRecord(raw)) {
        errors.push("scopeDispositions contains a non-object entry");
        continue;
      }
      const channel = raw.channel === "amazon" || raw.channel === "walmart"
        ? raw.channel
        : null;
      const scopeKey = typeof raw.scopeKey === "string" ? raw.scopeKey : null;
      const disposition =
        raw.disposition === "IN_SCOPE"
        || raw.disposition === "EXCLUDED_OWNER_CONFIRMED"
        || raw.disposition === "UNRESOLVED"
          ? raw.disposition
          : null;
      if (
        !channel
        || !scopeKey
        || scopeKey !== normalizeScopeKey(scopeKey)
        || !disposition
        || positiveStoreIndex(raw.storeIndex) === null
        || typeof raw.accountId !== "string"
        || typeof raw.storeId !== "string"
        || (raw.marketplaceId !== null && typeof raw.marketplaceId !== "string")
        || typeof raw.decisionId !== "string"
        || typeof raw.decidedBy !== "string"
        || typeof raw.decidedAt !== "string"
        || typeof raw.reason !== "string"
      ) {
        errors.push("scopeDispositions contains a non-canonical entry");
        continue;
      }
      let report: NormalizedDispositionEntry["report"] = null;
      if (disposition === "IN_SCOPE") {
        const matches = rawReports.filter((candidate) =>
          isRecord(candidate)
          && candidate.channel === channel
          && candidate.scopeKey === scopeKey
        );
        if (matches.length !== 1 || !isRecord(matches[0])) {
          errors.push(
            `scope ${channel}:${scopeKey} must have exactly one source report`,
          );
          continue;
        }
        const source = matches[0];
        if (
          typeof source.reportType !== "string"
          || typeof source.reportId !== "string"
          || typeof source.capturedAt !== "string"
          || nonNegativeInteger(source.expectedRowCount) === null
          || typeof source.contentSha256 !== "string"
          || !/^[a-f0-9]{64}$/.test(source.contentSha256)
        ) {
          errors.push(`source report for ${channel}:${scopeKey} is not canonical`);
          continue;
        }
        report = {
          reportType: source.reportType,
          reportId: source.reportId,
          capturedAt: source.capturedAt,
          expectedRowCount: source.expectedRowCount as number,
          expectedContentSha256: source.contentSha256,
        };
      }
      reconstructed.push({
        channel,
        scopeKey,
        storeIndex: raw.storeIndex as number,
        accountId: raw.accountId,
        storeId: raw.storeId,
        marketplaceId: raw.marketplaceId as string | null,
        disposition,
        decision: {
          authority: "OWNER",
          decisionId: raw.decisionId,
          decidedBy: raw.decidedBy,
          decidedAt: raw.decidedAt,
          reason: raw.reason,
        },
        report,
      });
    }
    if (reconstructed.length === rawDispositions.length) {
      const censusScopes = new Map(
        (embeddedCensus?.capture?.scopes ?? [])
          .filter((scope) => scope.connectionStatus !== "NOT_CONNECTED")
          .map((scope) => [`${scope.channel}:${scope.scopeKey}`, scope]),
      );
      for (const disposition of reconstructed) {
        const censusScope = censusScopes.get(
          `${disposition.channel}:${disposition.scopeKey}`,
        );
        if (
          censusScope
          && (
            disposition.storeIndex !== censusScope.storeIndex
            || disposition.accountId !== censusScope.accountId
            || disposition.storeId !== censusScope.storeId
            || disposition.marketplaceId !== censusScope.marketplaceId
          )
        ) {
          errors.push(
            `scope ${disposition.channel}:${disposition.scopeKey} identity does not match connectedStoreCensus`,
          );
        }
      }
      const expected = sha256Hex(
        `${stableJsonStringify(canonicalDispositionHashPayload(reconstructed), 0)}\n`,
      );
      if (policy.dispositionInputSha256 !== expected) {
        errors.push(
          "policy.dispositionInputSha256 does not match owner dispositions and report attestations",
        );
      }
    }
  }

  if (rawReports) {
    const reportsByScope = new Map<string, Record<string, unknown>[]>();
    const reportIds = new Map<string, number>();
    for (const raw of rawReports) {
      if (!isRecord(raw)) {
        errors.push("sourceReports contains a non-object entry");
        continue;
      }
      if (
        (raw.channel !== "amazon" && raw.channel !== "walmart")
        || typeof raw.scopeKey !== "string"
        || raw.scopeKey !== normalizeScopeKey(raw.scopeKey)
        || raw.scopeKey.length === 0
      ) {
        errors.push("sourceReports contains a non-canonical scope identity");
        continue;
      }
      const id = `${raw.channel}:${raw.scopeKey}`;
      const group = reportsByScope.get(id) ?? [];
      group.push(raw);
      reportsByScope.set(id, group);
      if (typeof raw.reportId === "string" && raw.reportId.length > 0) {
        reportIds.set(raw.reportId, (reportIds.get(raw.reportId) ?? 0) + 1);
      }

      const dispositionGroup = rawDispositionsByScope.get(id) ?? [];
      const disposition = dispositionGroup.length === 1
        ? dispositionGroup[0]
        : null;
      if (!disposition || disposition.disposition !== "IN_SCOPE") {
        errors.push(`sourceReports contains a report without one IN_SCOPE disposition for ${id}`);
      }
      const statusCounts = isRecord(raw.statusCounts) ? raw.statusCounts : null;
      const statusEntries = statusCounts
        ? Object.entries(statusCounts)
        : [];
      const statusCountsAreCanonical = statusCounts !== null
        && statusEntries.every(([, count]) => nonNegativeInteger(count) !== null);
      const statusTotal = statusCountsAreCanonical
        ? statusEntries.reduce((sum, [, count]) => sum + (count as number), 0)
        : null;
      const expectedLiveRows = statusCountsAreCanonical
        ? statusEntries.reduce((sum, [status, count]) => {
          const live = raw.channel === "amazon"
            ? status === "ACTIVE"
            : status.startsWith("PUBLISHED|");
          return sum + (live ? count as number : 0);
        }, 0)
        : null;
      if (
        positiveStoreIndex(raw.storeIndex) === null
        || typeof raw.accountId !== "string"
        || typeof raw.storeId !== "string"
        || (raw.marketplaceId !== null && typeof raw.marketplaceId !== "string")
        || raw.reportType !== EXPECTED_REPORT_TYPE[raw.channel]
        || typeof raw.reportId !== "string"
        || raw.reportId.length === 0
        || typeof raw.capturedAt !== "string"
        || typeof raw.sourceName !== "string"
        || raw.sourceName.length === 0
        || typeof raw.contentSha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(raw.contentSha256)
        || nonNegativeInteger(raw.byteLength) === null
        || (raw.delimiter !== "comma" && raw.delimiter !== "tab")
        || !Array.isArray(raw.headers)
        || raw.headers.some((header) => typeof header !== "string")
        || nonNegativeInteger(raw.totalRows) === null
        || nonNegativeInteger(raw.expectedRowCount) === null
        || nonNegativeInteger(raw.liveRows) === null
        || !statusCountsAreCanonical
      ) {
        errors.push(`source report for ${id} is not a canonical complete report record`);
      } else {
        if (raw.totalRows !== raw.expectedRowCount) {
          errors.push(`source report for ${id} does not match its attested row count`);
        }
        if (statusTotal !== raw.totalRows) {
          errors.push(`source report for ${id} statusCounts do not cover every source row`);
        }
        if (expectedLiveRows !== raw.liveRows) {
          errors.push(`source report for ${id} liveRows do not match its live status counts`);
        }
        if (
          raw.channel === "walmart"
          && statusEntries.some(([status, count]) =>
            status.startsWith("PUBLISHED|")
            && status !== "PUBLISHED|ACTIVE"
            && (count as number) > 0
          )
        ) {
          errors.push(`source report for ${id} contains a contradictory published lifecycle status`);
        }
        if (
          disposition
          && (
            raw.storeIndex !== disposition.storeIndex
            || raw.accountId !== disposition.accountId
            || raw.storeId !== disposition.storeId
            || raw.marketplaceId !== disposition.marketplaceId
          )
        ) {
          errors.push(`source report for ${id} identity does not match its disposition`);
        }
      }
    }
    for (const [reportId, count] of reportIds) {
      if (count !== 1) errors.push(`sourceReports contains duplicate reportId ${reportId}`);
    }
    for (const [id, dispositions] of rawDispositionsByScope) {
      if (dispositions.length !== 1) continue;
      const expectedCount = dispositions[0].disposition === "IN_SCOPE" ? 1 : 0;
      const actualCount = reportsByScope.get(id)?.length ?? 0;
      if (actualCount !== expectedCount) {
        errors.push(
          `sourceReports must contain exactly ${expectedCount} report(s) for disposition ${id}`,
        );
      }
    }
    for (const id of reportsByScope.keys()) {
      if (!rawDispositionsByScope.has(id)) {
        errors.push(`sourceReports contains unexpected scope ${id}`);
      }
    }

    if (rawListings) {
      const listingsByScope = new Map<string, number>();
      const listingKeys = new Map<string, number>();
      for (const raw of rawListings) {
        if (!isRecord(raw)) {
          errors.push("listings contains a non-object entry");
          continue;
        }
        if (
          (raw.channel !== "amazon" && raw.channel !== "walmart")
          || typeof raw.scopeKey !== "string"
          || raw.scopeKey !== normalizeScopeKey(raw.scopeKey)
          || raw.scopeKey.length === 0
        ) {
          errors.push("listings contains a non-canonical scope identity");
          continue;
        }
        const id = `${raw.channel}:${raw.scopeKey}`;
        listingsByScope.set(id, (listingsByScope.get(id) ?? 0) + 1);
        if (typeof raw.listingKey === "string") {
          listingKeys.set(raw.listingKey, (listingKeys.get(raw.listingKey) ?? 0) + 1);
        }
        const reportGroup = reportsByScope.get(id) ?? [];
        const report = reportGroup.length === 1 ? reportGroup[0] : null;
        const dispositionGroup = rawDispositionsByScope.get(id) ?? [];
        const disposition = dispositionGroup.length === 1
          ? dispositionGroup[0]
          : null;
        let expectedListingKey: string | null = null;
        try {
          if (
            positiveStoreIndex(raw.storeIndex) !== null
            && typeof raw.sku === "string"
          ) {
            expectedListingKey = buildProductTruthListingScope({
              channel: raw.channel,
              storeIndex: raw.storeIndex as number,
              sku: raw.sku,
            }).listingKey;
          }
        } catch {
          expectedListingKey = null;
        }
        if (
          !report
          || !disposition
          || disposition.disposition !== "IN_SCOPE"
          || expectedListingKey === null
          || raw.listingKey !== expectedListingKey
          || typeof raw.listingId !== "string"
          || raw.listingId.length === 0
          || typeof raw.title !== "string"
          || raw.title.length === 0
          || raw.phase1Status !== "NOT_STARTED"
          || raw.sourceStatus !== (raw.channel === "amazon" ? "ACTIVE" : "PUBLISHED")
          || (raw.channel === "amazon" && raw.sourceLifecycleStatus !== null)
          || (raw.channel === "walmart" && raw.sourceLifecycleStatus !== "ACTIVE")
          || raw.storeIndex !== report.storeIndex
          || raw.accountId !== report.accountId
          || raw.storeId !== report.storeId
          || raw.marketplaceId !== report.marketplaceId
          || raw.sourceReportId !== report.reportId
          || raw.sourceCapturedAt !== report.capturedAt
          || raw.sourceContentSha256 !== report.contentSha256
        ) {
          errors.push(`listing in ${id} is not bound to its exact IN_SCOPE source report`);
        }
      }
      for (const [listingKey, count] of listingKeys) {
        if (count !== 1) errors.push(`listings contains duplicate listingKey ${listingKey}`);
      }
      for (const [id, reports] of reportsByScope) {
        if (reports.length !== 1) continue;
        const liveRows = nonNegativeInteger(reports[0].liveRows);
        if (liveRows !== null && (listingsByScope.get(id) ?? 0) !== liveRows) {
          errors.push(`listings do not contain every live row from source report ${id}`);
        }
      }
      for (const id of listingsByScope.keys()) {
        if (!reportsByScope.has(id)) {
          errors.push(`listings contains unexpected scope ${id}`);
        }
      }

      const counts = isRecord(value.counts) ? value.counts : null;
      const blockers = Array.isArray(value.blockers) ? value.blockers : null;
      const collisions = Array.isArray(value.collisions) ? value.collisions : null;
      if (!counts || !blockers || !collisions || !canonicalRequiredScopes) {
        errors.push("manifest counts, blockers, and collisions must be canonical arrays/objects");
      } else {
        const expectedCounts = {
          requiredScopes:
            canonicalRequiredScopes.amazon.length + canonicalRequiredScopes.walmart.length,
          inScopeReports: rawReports.length,
          sourceRows: rawReports.reduce(
            (sum, report) => sum + (isRecord(report) && nonNegativeInteger(report.totalRows) !== null
              ? report.totalRows as number
              : 0),
            0,
          ),
          liveListings: rawListings.length,
          amazonLiveListings: rawListings.filter(
            (listing) => isRecord(listing) && listing.channel === "amazon",
          ).length,
          walmartLiveListings: rawListings.filter(
            (listing) => isRecord(listing) && listing.channel === "walmart",
          ).length,
          blockerCount: blockers.length,
          collisionGroups: collisions.length,
        };
        for (const [name, expected] of Object.entries(expectedCounts)) {
          if (counts[name] !== expected) {
            errors.push(`counts.${name} does not match the manifest payload`);
          }
        }
      }
    }
  }
  if (
    typeof policy.dispositionInputSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(policy.dispositionInputSha256)
  ) {
    errors.push("policy.dispositionInputSha256 must be a lowercase SHA-256");
  }
  return [...new Set(errors)];
}

function listingComparator(a: Phase1ScopeListing, b: Phase1ScopeListing): number {
  return (
    compareChannel(a.channel, b.channel) ||
    compareText(a.scopeKey, b.scopeKey) ||
    compareText(a.sku.toLowerCase(), b.sku.toLowerCase()) ||
    compareText(a.sku, b.sku) ||
    compareText(a.listingId, b.listingId)
  );
}

function dispositionComparator(
  a: Pick<Phase1ScopeDispositionRecord, "channel" | "scopeKey">,
  b: Pick<Phase1ScopeDispositionRecord, "channel" | "scopeKey">,
): number {
  return compareChannel(a.channel, b.channel) || compareText(a.scopeKey, b.scopeKey);
}

export function buildPhase1ScopeManifest(
  input: BuildPhase1ScopeManifestInput,
): Phase1ScopeManifest {
  const blockers: Phase1ManifestBlocker[] = [];
  const blockerKeys = new Set<string>();
  const addBlocker = (blocker: Phase1ManifestBlocker): void => {
    const normalized: Phase1ManifestBlocker = {
      ...blocker,
      scopeKey: blocker.scopeKey ? normalizeScopeKey(blocker.scopeKey) : null,
    };
    const key = stableJsonStringify(normalized, 0);
    if (!blockerKeys.has(key)) {
      blockerKeys.add(key);
      blockers.push(normalized);
    }
  };

  const asOf = normalizeIsoTimestamp(input.asOf);
  const asOfMs = asOf ? Date.parse(asOf) : null;
  if (!asOf) {
    addBlocker({
      code: "INVALID_AS_OF",
      channel: null,
      scopeKey: null,
      message: "asOf must be a valid timestamp with an explicit timezone.",
      details: { received: input.asOf },
    });
  }

  const maxReportAgeHours = input.maxReportAgeHours ?? DEFAULT_MAX_REPORT_AGE_HOURS;
  const maxReportSkewHours = input.maxReportSkewHours ?? DEFAULT_MAX_REPORT_SKEW_HOURS;
  if (!positiveFinite(maxReportAgeHours) || !positiveFinite(maxReportSkewHours)) {
    addBlocker({
      code: "INVALID_CONFIGURATION",
      channel: null,
      scopeKey: null,
      message: "maxReportAgeHours and maxReportSkewHours must be positive finite numbers.",
      details: { maxReportAgeHours, maxReportSkewHours },
    });
  }

  const requiredScopes: Record<Phase1Channel, string[]> = {
    amazon: [],
    walmart: [],
  };
  let connectedStoreCensus: Phase1ConnectedStoreCensusArtifact | null = null;
  let connectedStoreCensusContentSha256 = "";
  if (input.requiredScopes !== undefined) {
    addBlocker({
      code: "MANUAL_REQUIRED_SCOPES_FORBIDDEN",
      channel: null,
      scopeKey: null,
      message: "requiredScopes cannot be supplied manually; the denominator is derived only from the owner-attested connected-store census.",
      details: null,
    });
  }
  const censusInput = isRecord(input.connectedStoreCensus)
    ? input.connectedStoreCensus
    : null;
  if (
    !censusInput
    || !nonEmptyString(censusInput.sourceName)
    || typeof censusInput.content !== "string"
  ) {
    addBlocker({
      code: "MISSING_CONNECTED_STORE_CENSUS",
      channel: null,
      scopeKey: null,
      message: "A canonical owner-attested connected-store census artifact is required.",
      details: null,
    });
  } else {
    connectedStoreCensusContentSha256 = phase1CensusSha256Hex(censusInput.content);
    const inspected = parsePhase1ConnectedStoreCensusArtifact(censusInput.content);
    connectedStoreCensus = inspected.artifact;
    for (const error of inspected.errors) {
      addBlocker({
        code: "INVALID_CONNECTED_STORE_CENSUS",
        channel: null,
        scopeKey: null,
        message: "Connected-store census artifact failed canonical validation.",
        details: { sourceName: censusInput.sourceName, error },
      });
    }
    if (!inspected.artifact.authoritative) {
      addBlocker({
        code: "BLOCKED_CONNECTED_STORE_CENSUS",
        channel: null,
        scopeKey: null,
        message: "Connected-store census has unresolved or invalid scope evidence.",
        details: { blockerCount: inspected.artifact.counts.blockerCount },
      });
    }
    if (asOf && inspected.artifact.asOf !== asOf) {
      addBlocker({
        code: "CONNECTED_STORE_CENSUS_AS_OF_MISMATCH",
        channel: null,
        scopeKey: null,
        message: "Manifest and connected-store census must use the exact same asOf snapshot boundary.",
        details: { manifestAsOf: asOf, censusAsOf: inspected.artifact.asOf },
      });
    }
    requiredScopes.amazon = [...inspected.artifact.requiredScopes.amazon];
    requiredScopes.walmart = [...inspected.artifact.requiredScopes.walmart];
  }
  for (const channel of ["amazon", "walmart"] as const) {
    if (requiredScopes[channel].length === 0) {
      addBlocker({
        code: "MISSING_REQUIRED_SCOPE_DECLARATION",
        channel,
        scopeKey: null,
        message: `Connected-store census contains no required ${channel} scope.`,
        details: null,
      });
    }
  }

  const dispositionEntries = parseDisposition(input.disposition, asOfMs, addBlocker);
  const dispositionByScope = new Map<string, NormalizedDispositionEntry>();
  const dispositionByStoreIndex = new Map<string, NormalizedDispositionEntry>();
  const dispositionsByReportId = new Map<string, NormalizedDispositionEntry[]>();
  for (const entry of dispositionEntries) {
    const id = scopeId(entry.channel, entry.scopeKey);
    if (dispositionByScope.has(id)) {
      addBlocker({
        code: "DUPLICATE_ACCOUNT_DISPOSITION",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: `Scope ${id} has more than one disposition.`,
        details: null,
      });
    } else {
      dispositionByScope.set(id, entry);
    }
    if (entry.storeIndex > 0) {
      const storeKey = `${entry.channel}:${entry.storeIndex}`;
      const existing = dispositionByStoreIndex.get(storeKey);
      if (existing && existing.scopeKey !== entry.scopeKey) {
        addBlocker({
          code: "DUPLICATE_STORE_INDEX_MAPPING",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: `${storeKey} maps to more than one scopeKey.`,
          details: { scopeKeys: [existing.scopeKey, entry.scopeKey].sort(compareText) },
        });
      } else {
        dispositionByStoreIndex.set(storeKey, entry);
      }
    }
    if (entry.report) {
      const reportKey = `${entry.channel}:${entry.report.reportId}`;
      const group = dispositionsByReportId.get(reportKey) ?? [];
      group.push(entry);
      dispositionsByReportId.set(reportKey, group);
    }
  }
  for (const [reportKey, entries] of [...dispositionsByReportId.entries()].sort(
    ([a], [b]) => compareText(a, b),
  )) {
    if (entries.length < 2) continue;
    const scopes = entries
      .map((entry) => `${entry.channel}:${entry.scopeKey}`)
      .sort(compareText);
    addBlocker({
      code: "DUPLICATE_SOURCE_REPORT_ID",
      channel: null,
      scopeKey: null,
      message: "One marketplace reportId cannot attest multiple account/store scopes.",
      details: {
        channel: entries[0].channel,
        reportId: entries[0].report?.reportId ?? reportKey,
        scopes,
      },
    });
  }

  const requiredIds = new Set<string>();
  const censusScopeById = new Map(
    (connectedStoreCensus?.capture?.scopes ?? [])
      .filter((scope) => scope.connectionStatus !== "NOT_CONNECTED")
      .map((scope) => [scopeId(scope.channel, scope.scopeKey), scope]),
  );
  for (const channel of ["amazon", "walmart"] as const) {
    for (const key of requiredScopes[channel]) {
      const id = scopeId(channel, key);
      requiredIds.add(id);
      const entry = dispositionByScope.get(id);
      if (!entry) {
        addBlocker({
          code: "MISSING_ACCOUNT_DISPOSITION",
          channel,
          scopeKey: key,
          message: `Required scope ${id} has no owner disposition.`,
          details: null,
        });
      } else if (entry.disposition === "UNRESOLVED") {
        addBlocker({
          code: "UNRESOLVED_ACCOUNT_DISPOSITION",
          channel,
          scopeKey: key,
          message: `Required scope ${id} remains unresolved.`,
          details: null,
        });
      }
      const censusScope = censusScopeById.get(id);
      if (
        entry
        && censusScope
        && (
          entry.storeIndex !== censusScope.storeIndex
          || entry.accountId !== censusScope.accountId
          || entry.storeId !== censusScope.storeId
          || entry.marketplaceId !== censusScope.marketplaceId
        )
      ) {
        addBlocker({
          code: "CENSUS_DISPOSITION_IDENTITY_MISMATCH",
          channel,
          scopeKey: key,
          message: `Disposition identity for ${id} does not match the independently captured connected-store identity.`,
          details: {
            census: {
              storeIndex: censusScope.storeIndex,
              accountId: censusScope.accountId,
              storeId: censusScope.storeId,
              marketplaceId: censusScope.marketplaceId,
            },
            disposition: {
              storeIndex: entry.storeIndex,
              accountId: entry.accountId,
              storeId: entry.storeId,
              marketplaceId: entry.marketplaceId,
            },
          },
        });
      }
    }
  }
  for (const entry of dispositionEntries) {
    if (!requiredIds.has(scopeId(entry.channel, entry.scopeKey))) {
      addBlocker({
        code: "UNDECLARED_SCOPE",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: `Disposition ${entry.channel}:${entry.scopeKey} is not present in the connected-store census denominator.`,
        details: null,
      });
    }
  }

  const reportsByScope = new Map<string, Phase1LocalReportInput>();
  const rawReports: unknown[] = Array.isArray(input.reports) ? input.reports : [];
  if (!Array.isArray(input.reports)) {
    addBlocker({
      code: "INVALID_LOCAL_REPORT_INPUT",
      channel: null,
      scopeKey: null,
      message: "Local reports input must be an array.",
      details: null,
    });
  }
  for (let reportIndex = 0; reportIndex < rawReports.length; reportIndex += 1) {
    const rawReport = rawReports[reportIndex];
    if (!isRecord(rawReport)) {
      addBlocker({
        code: "INVALID_LOCAL_REPORT_INPUT",
        channel: null,
        scopeKey: null,
        message: `Local report input ${reportIndex} must be an object.`,
        details: null,
      });
      continue;
    }
    const channel = rawReport.channel === "amazon" || rawReport.channel === "walmart"
      ? rawReport.channel
      : null;
    const rawScopeKey = nonEmptyString(rawReport.scopeKey);
    const sourceName = nonEmptyString(rawReport.sourceName);
    if (!channel || !rawScopeKey || !sourceName || typeof rawReport.content !== "string") {
      addBlocker({
        code: "INVALID_LOCAL_REPORT_INPUT",
        channel,
        scopeKey: rawScopeKey ? normalizeScopeKey(rawScopeKey) : null,
        message: `Local report input ${reportIndex} needs channel, scopeKey, sourceName, and string content.`,
        details: null,
      });
      continue;
    }
    const report: Phase1LocalReportInput = {
      channel,
      scopeKey: normalizeScopeKey(rawScopeKey),
      sourceName,
      content: rawReport.content,
    };
    const key = report.scopeKey;
    const id = scopeId(channel, key);
    if (reportsByScope.has(id)) {
      addBlocker({
        code: "DUPLICATE_LOCAL_REPORT",
        channel,
        scopeKey: key,
        message: `More than one local report was supplied for ${id}.`,
        details: null,
      });
    } else {
      reportsByScope.set(id, { ...report, scopeKey: key });
    }
    const disposition = dispositionByScope.get(id);
    if (!requiredIds.has(id) || !disposition || disposition.disposition !== "IN_SCOPE") {
      addBlocker({
        code: "UNEXPECTED_LOCAL_REPORT",
        channel,
        scopeKey: key,
        message: `Local report ${id} is not backed by a required IN_SCOPE disposition.`,
        details: { sourceName: report.sourceName },
      });
    }
  }

  const scopeDispositions: Phase1ScopeDispositionRecord[] = dispositionEntries.map(
    (entry) => ({
      channel: entry.channel,
      scopeKey: entry.scopeKey,
      storeIndex: entry.storeIndex,
      accountId: entry.accountId,
      storeId: entry.storeId,
      marketplaceId: entry.marketplaceId,
      disposition: entry.disposition,
      decisionId: entry.decision.decisionId,
      decidedBy: entry.decision.decidedBy,
      decidedAt: entry.decision.decidedAt,
      reason: entry.decision.reason,
    }),
  );
  scopeDispositions.sort(dispositionComparator);

  const sourceReports: Phase1SourceReportRecord[] = [];
  const listings: Phase1ScopeListing[] = [];
  const capturedAtValues: Array<{
    channel: Phase1Channel;
    scopeKey: string;
    milliseconds: number;
  }> = [];

  for (const entry of dispositionEntries
    .filter((candidate) => candidate.disposition === "IN_SCOPE")
    .sort(dispositionComparator)) {
    if (entry.storeIndex <= 0) continue;
    const id = scopeId(entry.channel, entry.scopeKey);
    const local = reportsByScope.get(id);
    if (!local) {
      addBlocker({
        code: "MISSING_LOCAL_REPORT",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: `IN_SCOPE disposition ${id} has no matching local report path.`,
        details: null,
      });
      continue;
    }
    if (!entry.report) continue;
    const reportAttestation = entry.report;

    if (reportAttestation.reportType !== EXPECTED_REPORT_TYPE[entry.channel]) {
      addBlocker({
        code: "REPORT_TYPE_MISMATCH",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: `${entry.channel} report type must be ${EXPECTED_REPORT_TYPE[entry.channel]}.`,
        details: { received: reportAttestation.reportType },
      });
    }

    const capturedAtMs = Date.parse(reportAttestation.capturedAt);
    capturedAtValues.push({
      channel: entry.channel,
      scopeKey: entry.scopeKey,
      milliseconds: capturedAtMs,
    });
    if (!Number.isFinite(capturedAtMs)) {
      addBlocker({
        code: "REPORT_TIMESTAMP_INVALID",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: "Source report capturedAt is invalid.",
        details: { capturedAt: reportAttestation.capturedAt },
      });
    } else if (asOfMs !== null) {
      const ageHours = (asOfMs - capturedAtMs) / 3_600_000;
      if (ageHours < 0) {
        addBlocker({
          code: "REPORT_TIMESTAMP_IN_FUTURE",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: "Source report was captured after manifest asOf.",
          details: { capturedAt: reportAttestation.capturedAt, asOf },
        });
      } else if (ageHours > maxReportAgeHours) {
        addBlocker({
          code: "REPORT_STALE",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: "Source report exceeds the configured freshness window.",
          details: { ageHours, maxReportAgeHours },
        });
      }
    }

    const contentSha256 = sha256Hex(local.content);
    if (reportAttestation.expectedContentSha256 !== contentSha256) {
      addBlocker({
        code: "REPORT_CONTENT_HASH_MISMATCH",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: "Local report content does not match its attested SHA-256.",
        details: {
          expected: reportAttestation.expectedContentSha256,
          actual: contentSha256,
        },
      });
    }

    const parsed = parsePhase1DelimitedText(local.content);
    if (!EXPECTED_REPORT_DELIMITERS[entry.channel].includes(parsed.delimiter)) {
      addBlocker({
        code: "REPORT_FORMAT_MISMATCH",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: `${EXPECTED_REPORT_TYPE[entry.channel]} does not use a recognized raw export delimiter.`,
        details: {
          allowedDelimiters: EXPECTED_REPORT_DELIMITERS[entry.channel],
          actualDelimiter: parsed.delimiter,
        },
      });
    }
    for (const error of parsed.errors) {
      addBlocker({
        code: "REPORT_PARSE_ERROR",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: error,
        details: { sourceName: local.sourceName },
      });
    }
    if (parsed.rows.length !== reportAttestation.expectedRowCount) {
      addBlocker({
        code: "REPORT_ROW_COUNT_MISMATCH",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: "Parsed source row count does not match the attested report row count.",
        details: {
          expected: reportAttestation.expectedRowCount,
          actual: parsed.rows.length,
        },
      });
    }
    if (KNOWN_SUSPICIOUS_EXACT_ROW_CAPS[entry.channel].includes(parsed.rows.length)) {
      addBlocker({
        code: "SUSPICIOUS_KNOWN_ROW_CAP",
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        message: `Report stops at the known suspicious ${parsed.rows.length}-row enumeration boundary.`,
        details: { rowCount: parsed.rows.length },
      });
    }

    const indexes = headerIndex(parsed.headers);
    const columns = entry.channel === "amazon" ? AMAZON_COLUMNS : WALMART_COLUMNS;
    for (const [field, aliases] of Object.entries(columns)) {
      const matchingIndexes = matchingColumnIndexes(parsed.headers, aliases);
      if (matchingIndexes.length === 0) {
        addBlocker({
          code: "MISSING_REQUIRED_COLUMN",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: `Source report is missing required ${field} column.`,
          details: { aliases: [...aliases], headers: parsed.headers },
        });
      } else if (matchingIndexes.length > 1) {
        addBlocker({
          code: "AMBIGUOUS_REQUIRED_COLUMN",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: `Source report maps more than one column to required ${field}.`,
          details: {
            aliases: [...aliases],
            matchingHeaders: matchingIndexes.map((index) => parsed.headers[index]),
          },
        });
      }
    }

    const statusCounts = new Map<string, number>();
    const reportListings: Phase1ScopeListing[] = [];
    parsed.rows.forEach((row, rowIndex) => {
      const sku = readExactCell(row, indexes, columns.sku);
      const listingId = readCell(row, indexes, columns.listingId);
      const title = readCell(row, indexes, columns.title);
      const sourceStatus = normalizeStatus(readCell(row, indexes, columns.status));
      const sourceLifecycleStatus = entry.channel === "walmart"
        ? normalizeStatus(readCell(row, indexes, WALMART_COLUMNS.lifecycleStatus))
        : null;
      const statusKey = entry.channel === "walmart"
        ? `${sourceStatus || "(MISSING)"}|${sourceLifecycleStatus || "(MISSING)"}`
        : sourceStatus || "(MISSING)";
      statusCounts.set(statusKey, (statusCounts.get(statusKey) ?? 0) + 1);

      if (!sku || !sourceStatus) {
        addBlocker({
          code: "MALFORMED_REPORT_ROW",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: `Source row ${rowIndex + 2} is missing SKU or status.`,
          details: { hasSku: Boolean(sku), hasStatus: Boolean(sourceStatus) },
        });
      }
      const rawSkuIsExact = Boolean(sku) &&
        sku === sku.trim() &&
        !/[\u0000-\u001f\u007f]/u.test(sku);
      if (sku && !rawSkuIsExact) {
        addBlocker({
          code: "INVALID_RAW_SKU",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: `Source row ${rowIndex + 2} contains a SKU that cannot be preserved as an exact listing key.`,
          details: {
            hasSurroundingWhitespace: sku !== sku.trim(),
            hasControlCharacters: /[\u0000-\u001f\u007f]/u.test(sku),
          },
        });
      }
      if (
        sourceStatus &&
        !KNOWN_SOURCE_STATUSES[entry.channel].has(sourceStatus)
      ) {
        addBlocker({
          code: "UNKNOWN_SOURCE_STATUS",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: `Source row ${rowIndex + 2} uses an unclassified marketplace status; it cannot be silently excluded from live scope.`,
          details: { status: sourceStatus },
        });
      }
      if (
        entry.channel === "walmart" &&
        sourceLifecycleStatus &&
        !KNOWN_WALMART_LIFECYCLE_STATUSES.has(sourceLifecycleStatus)
      ) {
        addBlocker({
          code: "UNKNOWN_SOURCE_STATUS",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: `Source row ${rowIndex + 2} uses an unclassified Walmart lifecycle status.`,
          details: { lifecycleStatus: sourceLifecycleStatus },
        });
      }

      const isLive = entry.channel === "amazon"
        ? sourceStatus === "ACTIVE"
        : sourceStatus === "PUBLISHED";
      if (!isLive) return;

      if (!sku || !rawSkuIsExact || !listingId || !title) {
        addBlocker({
          code: "MISSING_LISTING_IDENTITY",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: `Live source row ${rowIndex + 2} needs SKU, listing ID, and title.`,
          details: {
            hasSku: Boolean(sku),
            rawSkuIsExact,
            hasListingId: Boolean(listingId),
            hasTitle: Boolean(title),
          },
        });
        return;
      }
      if (
        entry.channel === "walmart" &&
        sourceLifecycleStatus !== "ACTIVE"
      ) {
        addBlocker({
          code: "CONTRADICTORY_LIVE_STATUS",
          channel: entry.channel,
          scopeKey: entry.scopeKey,
          message: "A PUBLISHED Walmart row is not lifecycle ACTIVE.",
          details: { sku, lifecycleStatus: sourceLifecycleStatus || null },
        });
      }

      reportListings.push({
        channel: entry.channel,
        scopeKey: entry.scopeKey,
        storeIndex: entry.storeIndex,
        accountId: entry.accountId,
        storeId: entry.storeId,
        marketplaceId: entry.marketplaceId,
        listingKey: buildProductTruthListingScope({
          channel: entry.channel,
          storeIndex: entry.storeIndex,
          sku,
        }).listingKey,
        listingId,
        sku,
        title,
        sourceStatus,
        sourceLifecycleStatus: sourceLifecycleStatus || null,
        phase1Status: "NOT_STARTED",
        sourceReportId: reportAttestation.reportId,
        sourceCapturedAt: reportAttestation.capturedAt,
        sourceContentSha256: contentSha256,
      });
    });

    const statusCountsRecord: Record<string, number> = {};
    for (const [status, count] of [...statusCounts.entries()].sort(([a], [b]) =>
      compareText(a, b),
    )) {
      statusCountsRecord[status] = count;
    }

    sourceReports.push({
      channel: entry.channel,
      scopeKey: entry.scopeKey,
      storeIndex: entry.storeIndex,
      accountId: entry.accountId,
      storeId: entry.storeId,
      marketplaceId: entry.marketplaceId,
      reportType: reportAttestation.reportType,
      reportId: reportAttestation.reportId,
      capturedAt: reportAttestation.capturedAt,
      sourceName: local.sourceName,
      contentSha256,
      byteLength: Buffer.byteLength(local.content, "utf8"),
      delimiter: parsed.delimiter,
      headers: parsed.headers,
      totalRows: parsed.rows.length,
      expectedRowCount: reportAttestation.expectedRowCount,
      liveRows: reportListings.length,
      statusCounts: statusCountsRecord,
    });
    listings.push(...reportListings);
  }

  sourceReports.sort(dispositionComparator);
  listings.sort(listingComparator);

  if (capturedAtValues.length > 1) {
    const sorted = [...capturedAtValues].sort(
      (a, b) => a.milliseconds - b.milliseconds,
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const skewHours = (last.milliseconds - first.milliseconds) / 3_600_000;
    if (skewHours > maxReportSkewHours) {
      addBlocker({
        code: "REPORT_SNAPSHOT_SKEW",
        channel: null,
        scopeKey: null,
        message: "Source reports are too far apart to form one coherent snapshot.",
        details: {
          earliest: `${first.channel}:${first.scopeKey}`,
          latest: `${last.channel}:${last.scopeKey}`,
          skewHours,
          maxReportSkewHours,
        },
      });
    }
  }

  const reportsByHash = new Map<string, Phase1SourceReportRecord[]>();
  for (const report of sourceReports) {
    const group = reportsByHash.get(report.contentSha256) ?? [];
    group.push(report);
    reportsByHash.set(report.contentSha256, group);
  }
  for (const [hash, reports] of reportsByHash) {
    if (reports.length < 2) continue;
    for (const report of reports) {
      addBlocker({
        code: "DUPLICATE_REPORT_CONTENT",
        channel: report.channel,
        scopeKey: report.scopeKey,
        message: "Identical report content was supplied for multiple account/store scopes.",
        details: {
          contentSha256: hash,
          scopes: reports.map((candidate) => `${candidate.channel}:${candidate.scopeKey}`).sort(compareText),
        },
      });
    }
  }

  const collisions: Phase1ScopeCollision[] = [];
  const byListingKey = new Map<string, Phase1ScopeListing[]>();
  const byRawSku = new Map<string, Phase1ScopeListing[]>();
  const byNormalizedSku = new Map<string, Phase1ScopeListing[]>();
  const byListingId = new Map<string, Phase1ScopeListing[]>();
  for (const listing of listings) {
    const listingGroup = byListingKey.get(listing.listingKey) ?? [];
    listingGroup.push(listing);
    byListingKey.set(listing.listingKey, listingGroup);

    const skuGroup = byRawSku.get(listing.sku) ?? [];
    skuGroup.push(listing);
    byRawSku.set(listing.sku, skuGroup);

    const normalizedSku = listing.sku.toLowerCase();
    const normalizedGroup = byNormalizedSku.get(normalizedSku) ?? [];
    normalizedGroup.push(listing);
    byNormalizedSku.set(normalizedSku, normalizedGroup);

    const listingIdKey = `${listing.channel}:${listing.scopeKey}:${listing.listingId}`;
    const idGroup = byListingId.get(listingIdKey) ?? [];
    idGroup.push(listing);
    byListingId.set(listingIdKey, idGroup);
  }

  for (const [key, group] of byListingKey) {
    if (group.length < 2) continue;
    addBlocker({
      code: "DUPLICATE_LISTING_KEY",
      channel: group[0].channel,
      scopeKey: group[0].scopeKey,
      message: `Listing key ${key} occurs more than once in the live scope.`,
      details: { count: group.length },
    });
  }
  for (const [sku, group] of byRawSku) {
    const uniqueKeys = [...new Set(group.map((listing) => listing.listingKey))].sort(compareText);
    if (uniqueKeys.length < 2) continue;
    collisions.push({
      type: "RAW_SKU",
      key: sku,
      blocking: false,
      listingKeys: uniqueKeys,
      rawSkus: [sku],
    });
  }
  for (const [normalizedSku, group] of byNormalizedSku) {
    const rawSkus = [...new Set(group.map((listing) => listing.sku))].sort(compareText);
    if (rawSkus.length < 2) continue;
    collisions.push({
      type: "CASE_INSENSITIVE_RAW_SKU",
      key: normalizedSku,
      blocking: false,
      listingKeys: [...new Set(group.map((listing) => listing.listingKey))].sort(compareText),
      rawSkus,
    });
  }
  for (const [key, group] of byListingId) {
    const listingKeys = [...new Set(group.map((listing) => listing.listingKey))].sort(compareText);
    if (listingKeys.length < 2) continue;
    collisions.push({
      type: "LISTING_ID_REUSED",
      key,
      blocking: false,
      listingKeys,
      rawSkus: [...new Set(group.map((listing) => listing.sku))].sort(compareText),
    });
  }
  collisions.sort((a, b) =>
    compareText(a.type, b.type) || compareText(a.key, b.key),
  );

  sortBlockers(blockers);
  const manifest: Phase1ScopeManifest = {
    schemaVersion: PHASE1_SCOPE_MANIFEST_VERSION,
    phase: "PHASE_1_CURRENT_BUSINESS_COVERAGE",
    asOf: asOf ?? input.asOf,
    authoritative: blockers.length === 0,
    policy: {
      builderPolicyVersion: PHASE1_SCOPE_BUILDER_POLICY_VERSION,
      dispositionSchemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      dispositionInputSha256: sha256Hex(
        `${stableJsonStringify(canonicalDispositionHashPayload(dispositionEntries), 0)}\n`,
      ),
      requiredScopesSha256: sha256Hex(`${stableJsonStringify(requiredScopes, 0)}\n`),
      connectedStoreCensusSchemaVersion: PHASE1_CONNECTED_STORE_CENSUS_VERSION,
      connectedStoreCensusPolicyVersion: PHASE1_CONNECTED_STORE_CENSUS_POLICY_VERSION,
      connectedStoreCensusContentSha256,
      connectedStoreCaptureSha256:
        connectedStoreCensus?.policy.captureSha256 ?? "",
      amazonLivePredicate: "status=ACTIVE",
      walmartLivePredicate: "publishedStatus=PUBLISHED",
      rawSkuDeduplication: "FORBIDDEN_WITHOUT_SEMANTIC_CONFIRMATION",
      maxReportAgeHours,
      maxReportSkewHours,
    },
    connectedStoreCensus,
    requiredScopes,
    scopeDispositions,
    sourceReports,
    counts: {
      requiredScopes: requiredScopes.amazon.length + requiredScopes.walmart.length,
      inScopeReports: sourceReports.length,
      sourceRows: sourceReports.reduce((sum, report) => sum + report.totalRows, 0),
      liveListings: listings.length,
      amazonLiveListings: listings.filter((listing) => listing.channel === "amazon").length,
      walmartLiveListings: listings.filter((listing) => listing.channel === "walmart").length,
      blockerCount: blockers.length,
      collisionGroups: collisions.length,
    },
    listings,
    collisions,
    blockers,
  };
  return manifest;
}

export function renderPhase1ScopeManifestJson(manifest: Phase1ScopeManifest): string {
  return `${stableJsonStringify(manifest, 2)}\n`;
}

function csvCell(value: string | number | null): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderPhase1ScopeManifestCsv(manifest: Phase1ScopeManifest): string {
  const headers = [
    "channel",
    "scopeKey",
    "storeIndex",
    "accountId",
    "storeId",
    "marketplaceId",
    "listingKey",
    "listingId",
    "sku",
    "title",
    "sourceStatus",
    "sourceLifecycleStatus",
    "phase1Status",
    "sourceReportId",
    "sourceCapturedAt",
    "sourceContentSha256",
  ];
  const rows = manifest.listings.map((listing) => [
    listing.channel,
    listing.scopeKey,
    listing.storeIndex,
    listing.accountId,
    listing.storeId,
    listing.marketplaceId,
    listing.listingKey,
    listing.listingId,
    listing.sku,
    listing.title,
    listing.sourceStatus,
    listing.sourceLifecycleStatus,
    listing.phase1Status,
    listing.sourceReportId,
    listing.sourceCapturedAt,
    listing.sourceContentSha256,
  ]);
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderPhase1Sha256Manifest(
  artifacts: ReadonlyArray<{ fileName: string; content: string }>,
): string {
  return `${[...artifacts]
    .sort((a, b) => compareText(a.fileName, b.fileName))
    .map((artifact) => `${sha256Hex(artifact.content)}  ${artifact.fileName}`)
    .join("\n")}\n`;
}
