import { createHash } from "node:crypto";

export const PRODUCT_TRUTH_EXPANSION_CAMPAIGN_VERSION =
  "product-truth-expansion-campaign/1.0.0" as const;
export const PRODUCT_TRUTH_EXPANSION_CAMPAIGN_POLICY_VERSION =
  "product-truth-expansion-campaign-policy/1.0.0" as const;
export const PRODUCT_TRUTH_EXPANSION_ACTIVE_SNAPSHOT_VERSION =
  "product-truth-expansion-active-snapshot/1.0.0" as const;
export const PRODUCT_TRUTH_EXPANSION_CHECKPOINT_VERSION =
  "product-truth-expansion-checkpoint/1.0.0" as const;

export const PRODUCT_TRUTH_EXPANSION_DIMENSIONS = [
  "brand",
  "group",
  "retailer",
  "demand",
] as const;

export const PRODUCT_TRUTH_EXPANSION_RETAILERS = [
  "walmart",
  "target",
  "publix",
  "samsclub",
  "costco",
] as const;

const PHASE1_MANIFEST_VERSION = "phase1-authoritative-scope-manifest/v3" as const;
const PHASE1_READINESS_VERSION = "product-truth-consumer-readiness/1.0.0" as const;
const CAMPAIGN_KEY_VERSION = "product-truth-expansion-campaign-key/1.0.0" as const;
const ITEM_DEDUP_VERSION = "product-truth-expansion-item-dedup/1.0.0" as const;
const MAX_CAMPAIGN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_SNAPSHOT_AGE_MS = 60 * 60 * 1_000;

export type ProductTruthExpansionDimension =
  (typeof PRODUCT_TRUTH_EXPANSION_DIMENSIONS)[number];
export type ProductTruthExpansionRetailer =
  (typeof PRODUCT_TRUTH_EXPANSION_RETAILERS)[number];
export type ProductTruthExpansionCampaignStatus = "READY" | "BLOCKED";
export type ProductTruthExpansionCheckpointStatus =
  | "IN_PROGRESS"
  | "BLOCKED"
  | "COMPLETE";

export interface ProductTruthExpansionScopeInput {
  dimension: ProductTruthExpansionDimension;
  selectors: readonly string[];
  sourceArtifactSha256: string;
}

export interface ProductTruthExpansionClubApproval {
  approvedBy: "owner";
  decision: "ALLOW_PHASE2_CLUB_SOURCES";
  approvalId: string;
  approvalArtifactSha256: string;
  campaignId: string;
  scopeArtifactSha256: string;
  retailers: readonly ("samsclub" | "costco")[];
  issuedAt: string;
  expiresAt: string;
}

export interface ProductTruthExpansionSourcePolicyInput {
  procurementZip: "33765";
  firstPartyOnly: true;
  marketplaceSellersAllowed: false;
  retailers: readonly ProductTruthExpansionRetailer[];
  allowClubs: boolean;
  allowBjs: false;
  clubApproval: ProductTruthExpansionClubApproval | null;
}

export interface ProductTruthExpansionSourceRouteInput {
  retailer: ProductTruthExpansionRetailer;
  provider: string;
  operation: string;
  firstPartyOnly: true;
}

export interface ProductTruthExpansionProviderCeilingInput {
  provider: string;
  operation: string;
  maxCalls: number;
  maxCredits: number;
  reserveFloorCredits: number;
}

export interface ProductTruthExpansionPhase1Proof {
  manifest: {
    schemaVersion: typeof PHASE1_MANIFEST_VERSION;
    sha256: string;
    authoritative: boolean;
    blockerCount: number;
    liveListingCount: number;
  };
  readiness: {
    schemaVersion: typeof PHASE1_READINESS_VERSION;
    reportSha256: string;
    manifestSha256: string;
    capturedAt: string;
    denominator: number;
    reconciled: number;
    classified: number;
    integrityBlockerCount: number;
    phase1Completion: "PASS" | "FAIL";
  };
  ownerCompletion: {
    approvedBy: "owner";
    decision: "PHASE1_COMPLETE";
    approvalId: string;
    approvalArtifactSha256: string;
    approvedAt: string;
    manifestSha256: string;
    readinessReportSha256: string;
  } | null;
}

export interface ProductTruthExpansionActiveCampaignSnapshot {
  schemaVersion: typeof PRODUCT_TRUTH_EXPANSION_ACTIVE_SNAPSHOT_VERSION;
  capturedAt: string;
  activeCampaignKeys: readonly string[];
  payloadSha256: string;
}

export interface ProductTruthExpansionCampaignInput {
  campaignId: string;
  createdAt: string;
  expiresAt: string;
  phase1Proof: ProductTruthExpansionPhase1Proof | null;
  scope: ProductTruthExpansionScopeInput;
  sourcePolicy: ProductTruthExpansionSourcePolicyInput;
  sourceRoutes: readonly ProductTruthExpansionSourceRouteInput[];
  providerCeilings: readonly ProductTruthExpansionProviderCeilingInput[];
  limits: {
    maxDiscoveredItems: number;
    maxAcceptedItems: number;
  };
  matcherVersion: string;
  activeCampaignSnapshot: ProductTruthExpansionActiveCampaignSnapshot | null;
  activeCampaignSnapshotMaxAgeMs: number;
  checkpointEveryDiscoveredItems: number;
  completionCriteria: {
    minimumAcceptedItems: number;
    minimumCatalogReadyBasisPoints: number;
    maximumUnresolvedItems: number;
    requireScopeExhausted: true;
    requireExactReconciliation: true;
    requireNoPendingItems: true;
    requireNoUnsettledPaidOutcomes: true;
    requireFinalQualityReport: true;
  };
}

export interface ProductTruthExpansionCampaignArtifact {
  schemaVersion: typeof PRODUCT_TRUTH_EXPANSION_CAMPAIGN_VERSION;
  policyVersion: typeof PRODUCT_TRUTH_EXPANSION_CAMPAIGN_POLICY_VERSION;
  campaignId: string;
  createdAt: string;
  expiresAt: string;
  campaignKey: string;
  status: ProductTruthExpansionCampaignStatus;
  blockers: readonly string[];
  phase1Proof: ProductTruthExpansionPhase1Proof | null;
  scope: ProductTruthExpansionScopeInput;
  sourcePolicy: ProductTruthExpansionSourcePolicyInput;
  sourceRoutes: readonly ProductTruthExpansionSourceRouteInput[];
  budget: {
    providerCeilings: readonly ProductTruthExpansionProviderCeilingInput[];
    totalMaxCalls: number;
    totalMaxCredits: number;
  };
  limits: {
    maxDiscoveredItems: number;
    maxAcceptedItems: number;
  };
  dedup: {
    campaignKeyVersion: typeof CAMPAIGN_KEY_VERSION;
    itemDedupVersion: typeof ITEM_DEDUP_VERSION;
    matcherVersion: string;
    activeCampaignSnapshot: ProductTruthExpansionActiveCampaignSnapshot | null;
    activeCampaignSnapshotMaxAgeMs: number;
  };
  checkpointPolicy: {
    checkpointEveryDiscoveredItems: number;
    appendOnlyHashChain: true;
    cumulativeState: true;
  };
  completionCriteria: ProductTruthExpansionCampaignInput["completionCriteria"];
  claims: {
    databaseReads: false;
    databaseWrites: false;
    networkCalls: false;
    providerCalls: false;
    paidCalls: false;
    modelCalls: false;
    catalogMutations: false;
    marketplaceMutations: false;
    procurementMutations: false;
    executionAuthorized: false;
    ownerActivationGranted: false;
  };
}

export interface SealedProductTruthExpansionCampaign {
  artifact: ProductTruthExpansionCampaignArtifact;
  artifactSha256: string;
}

export interface ProductTruthExpansionAcceptedItemInput {
  itemKey: string;
  canonicalVariantId: string;
  identityEvidenceSha256: string;
  contentEvidenceSha256: string | null;
  evidenceStatus: "IDENTITY_READY" | "CATALOG_READY";
}

export interface ProductTruthExpansionRejectedItemInput {
  itemKey: string;
  reasonCode:
    | "DUPLICATE_EXISTING"
    | "OUT_OF_SCOPE"
    | "VARIANT_AMBIGUOUS"
    | "UNSOURCEABLE"
    | "POLICY_REJECTED";
}

export interface ProductTruthExpansionProviderUsageInput {
  provider: string;
  operation: string;
  callsUsed: number;
  creditsUsed: number;
}

export interface ProductTruthExpansionCheckpointInput {
  capturedAt: string;
  scopeExhausted: boolean;
  discoveredItemKeys: readonly string[];
  acceptedItems: readonly ProductTruthExpansionAcceptedItemInput[];
  rejectedItems: readonly ProductTruthExpansionRejectedItemInput[];
  pendingItemKeys: readonly string[];
  providerUsage: readonly ProductTruthExpansionProviderUsageInput[];
  unsettledPaidOutcomeKeys: readonly string[];
  finalQualityReportSha256: string | null;
}

export interface ProductTruthExpansionCheckpointArtifact {
  schemaVersion: typeof PRODUCT_TRUTH_EXPANSION_CHECKPOINT_VERSION;
  campaignKey: string;
  campaignArtifactSha256: string;
  sequence: number;
  previousCheckpointSha256: string | null;
  capturedAt: string;
  status: ProductTruthExpansionCheckpointStatus;
  blockers: readonly string[];
  scopeExhausted: boolean;
  discoveredItemKeys: readonly string[];
  acceptedItems: readonly ProductTruthExpansionAcceptedItemInput[];
  rejectedItems: readonly ProductTruthExpansionRejectedItemInput[];
  pendingItemKeys: readonly string[];
  providerUsage: readonly ProductTruthExpansionProviderUsageInput[];
  unsettledPaidOutcomeKeys: readonly string[];
  finalQualityReportSha256: string | null;
  reconciliation: {
    discovered: number;
    accepted: number;
    rejected: number;
    pending: number;
    catalogReadyAccepted: number;
    unresolved: number;
    catalogReadyBasisPoints: number;
    partitionComplete: true;
    totalCallsUsed: number;
    totalCreditsUsed: number;
  };
  claims: {
    checkpointBuildDatabaseReads: false;
    checkpointBuildDatabaseWrites: false;
    checkpointBuildNetworkCalls: false;
    checkpointBuildProviderCalls: false;
    checkpointBuildPaidCalls: false;
    checkpointBuildModelCalls: false;
    executionAuthorized: false;
  };
}

export interface SealedProductTruthExpansionCheckpoint {
  artifact: ProductTruthExpansionCheckpointArtifact;
  checkpointSha256: string;
}

export class ProductTruthExpansionCampaignError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthExpansionCampaignError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthExpansionCampaignError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(lexicalCompare);
  const wanted = [...expected].sort(lexicalCompare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("EXPANSION_ARTIFACT_INVALID", `${label} keys must be exactly ${wanted.join(", ")}`);
  }
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactText(value: unknown, label: string, maximum = 200): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("EXPANSION_INPUT_INVALID", `${label} must be 1-${maximum} exact printable characters`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const text = exactText(value, label, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    fail("EXPANSION_INPUT_INVALID", `${label} contains unsupported characters`);
  }
  return text;
}

function providerIdentifier(value: unknown, label: string): string {
  const text = exactText(value, label, 100).toLowerCase();
  if (!/^[a-z][a-z0-9._:-]*$/.test(text) || text.includes("*")) {
    fail("EXPANSION_INPUT_INVALID", `${label} must be an explicit provider/operation identifier`);
  }
  return text;
}

function versionIdentifier(value: unknown, label: string): string {
  const text = exactText(value, label, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) {
    fail("EXPANSION_INPUT_INVALID", `${label} contains unsupported version characters`);
  }
  return text;
}

function itemKey(value: unknown, label: string): string {
  return exactText(value, label, 240);
}

function exactSha256(value: unknown, label: string): string {
  const text = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    fail("EXPANSION_INPUT_INVALID", `${label} must be an exact lowercase SHA-256`);
  }
  return text;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 80);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail("EXPANSION_INPUT_INVALID", `${label} must be a canonical UTC ISO-8601 instant`);
  }
  return text;
}

function integerInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(
      "EXPANSION_INPUT_INVALID",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return Number(value);
}

function canonicalJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("EXPANSION_HASH_INVALID", "non-finite JSON number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === undefined) {
    fail("EXPANSION_HASH_INVALID", "canonical JSON accepts JSON data only");
  }
  if (seen.has(value)) fail("EXPANSION_HASH_INVALID", "canonical JSON cannot contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, seen));
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(lexicalCompare)) {
      if (record[key] === undefined) {
        fail("EXPANSION_HASH_INVALID", `undefined is not allowed at ${key}`);
      }
      result[key] = canonicalJsonValue(record[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function renderProductTruthExpansionJson(value: unknown): string {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

export function productTruthExpansionSha256(value: unknown): string {
  return createHash("sha256").update(renderProductTruthExpansionJson(value)).digest("hex");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(lexicalCompare);
}

function normalizeSelector(value: unknown, label: string): string {
  const text = exactText(value, label, 160)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return exactText(text, label, 160);
}

function normalizeRetailer(value: unknown, label: string): ProductTruthExpansionRetailer {
  const text = normalizeSelector(value, label).replace(/[\s_-]+/g, "");
  if (text === "bj" || text === "bjs" || text === "bj's" || text === "bj’s") {
    fail("BJS_FORBIDDEN", `${label} attempts to include BJ's`);
  }
  if (
    text !== "walmart"
    && text !== "target"
    && text !== "publix"
    && text !== "samsclub"
    && text !== "costco"
  ) {
    fail("SOURCE_FORBIDDEN", `${label} is not an allowed first-party source`);
  }
  return text;
}

function normalizeScope(input: ProductTruthExpansionScopeInput): ProductTruthExpansionScopeInput {
  if (!PRODUCT_TRUTH_EXPANSION_DIMENSIONS.includes(input.dimension)) {
    fail("EXPANSION_SCOPE_INVALID", "scope.dimension is unsupported");
  }
  if (!Array.isArray(input.selectors) || input.selectors.length < 1 || input.selectors.length > 100) {
    fail("EXPANSION_SCOPE_INVALID", "scope.selectors must contain 1-100 bounded selectors");
  }
  const selectors = sortedUnique(input.selectors.map((value, index) =>
    input.dimension === "retailer"
      ? normalizeRetailer(value, `scope.selectors[${index}]`)
      : normalizeSelector(value, `scope.selectors[${index}]`)));
  return {
    dimension: input.dimension,
    selectors,
    sourceArtifactSha256: exactSha256(
      input.sourceArtifactSha256,
      "scope.sourceArtifactSha256",
    ),
  };
}

export function deriveProductTruthExpansionCampaignKey(input: {
  scope: ProductTruthExpansionScopeInput;
  procurementZip: unknown;
}): string {
  const scope = normalizeScope(input.scope);
  if (input.procurementZip !== "33765") {
    fail("PROCUREMENT_ZIP_FORBIDDEN", "Phase 2 procurement ZIP must be exactly 33765");
  }
  return `ptexp_${productTruthExpansionSha256({
    version: CAMPAIGN_KEY_VERSION,
    procurementZip: "33765",
    dimension: scope.dimension,
    selectors: scope.selectors,
  })}`;
}

function normalizeCampaignKey(value: unknown, label: string): string {
  const text = exactText(value, label, 70);
  if (!/^ptexp_[a-f0-9]{64}$/.test(text)) {
    fail("EXPANSION_INPUT_INVALID", `${label} must be a canonical expansion campaign key`);
  }
  return text;
}

export function buildProductTruthExpansionActiveCampaignSnapshot(input: {
  capturedAt: string;
  activeCampaignKeys: readonly string[];
}): ProductTruthExpansionActiveCampaignSnapshot {
  if (!Array.isArray(input.activeCampaignKeys) || input.activeCampaignKeys.length > 10_000) {
    fail("EXPANSION_INPUT_INVALID", "activeCampaignKeys must contain at most 10,000 keys");
  }
  const payload = {
    schemaVersion: PRODUCT_TRUTH_EXPANSION_ACTIVE_SNAPSHOT_VERSION,
    capturedAt: canonicalInstant(input.capturedAt, "activeCampaignSnapshot.capturedAt"),
    activeCampaignKeys: sortedUnique(input.activeCampaignKeys.map((value, index) =>
      normalizeCampaignKey(value, `activeCampaignKeys[${index}]`))),
  };
  return { ...payload, payloadSha256: productTruthExpansionSha256(payload) };
}

function validateActiveSnapshot(
  value: ProductTruthExpansionActiveCampaignSnapshot,
): ProductTruthExpansionActiveCampaignSnapshot {
  if (!isRecord(value)) {
    fail("ACTIVE_CAMPAIGN_SNAPSHOT_INVALID", "active campaign snapshot must be an object");
  }
  exactKeys(
    value,
    ["schemaVersion", "capturedAt", "activeCampaignKeys", "payloadSha256"],
    "activeCampaignSnapshot",
  );
  if (value.schemaVersion !== PRODUCT_TRUTH_EXPANSION_ACTIVE_SNAPSHOT_VERSION) {
    fail("ACTIVE_CAMPAIGN_SNAPSHOT_INVALID", "active campaign snapshot version is unsupported");
  }
  if (!Array.isArray(value.activeCampaignKeys)) {
    fail("ACTIVE_CAMPAIGN_SNAPSHOT_INVALID", "activeCampaignKeys must be an array");
  }
  const rebuilt = buildProductTruthExpansionActiveCampaignSnapshot({
    capturedAt: value.capturedAt,
    activeCampaignKeys: value.activeCampaignKeys,
  });
  if (
    renderProductTruthExpansionJson(rebuilt) !== renderProductTruthExpansionJson(value)
    || rebuilt.payloadSha256 !== exactSha256(value.payloadSha256, "activeCampaignSnapshot.payloadSha256")
  ) {
    fail("ACTIVE_CAMPAIGN_SNAPSHOT_TAMPERED", "active campaign snapshot is not canonical/hash-bound");
  }
  return rebuilt;
}

function normalizePhase1Proof(
  proof: ProductTruthExpansionPhase1Proof,
  createdAt: string,
): { proof: ProductTruthExpansionPhase1Proof; blockers: string[] } {
  const manifestSha256 = exactSha256(proof.manifest.sha256, "phase1.manifest.sha256");
  const manifestBlockerCount = integerInRange(
    proof.manifest.blockerCount,
    "phase1.manifest.blockerCount",
    0,
    1_000_000,
  );
  const liveListingCount = integerInRange(
    proof.manifest.liveListingCount,
    "phase1.manifest.liveListingCount",
    0,
    10_000_000,
  );
  const readinessReportSha256 = exactSha256(
    proof.readiness.reportSha256,
    "phase1.readiness.reportSha256",
  );
  const readinessManifestSha256 = exactSha256(
    proof.readiness.manifestSha256,
    "phase1.readiness.manifestSha256",
  );
  if (readinessManifestSha256 !== manifestSha256) {
    fail("PHASE1_PROOF_BINDING_INVALID", "readiness is not bound to the Phase 1 manifest");
  }
  const readinessCapturedAt = canonicalInstant(
    proof.readiness.capturedAt,
    "phase1.readiness.capturedAt",
  );
  if (Date.parse(readinessCapturedAt) > Date.parse(createdAt)) {
    fail("PHASE1_PROOF_BINDING_INVALID", "readiness cannot be captured after campaign creation");
  }
  const denominator = integerInRange(
    proof.readiness.denominator,
    "phase1.readiness.denominator",
    0,
    10_000_000,
  );
  const reconciled = integerInRange(
    proof.readiness.reconciled,
    "phase1.readiness.reconciled",
    0,
    10_000_000,
  );
  const classified = integerInRange(
    proof.readiness.classified,
    "phase1.readiness.classified",
    0,
    10_000_000,
  );
  const integrityBlockerCount = integerInRange(
    proof.readiness.integrityBlockerCount,
    "phase1.readiness.integrityBlockerCount",
    0,
    1_000_000,
  );
  let ownerCompletion: ProductTruthExpansionPhase1Proof["ownerCompletion"] = null;
  if (proof.ownerCompletion !== null) {
    const approvedAt = canonicalInstant(
      proof.ownerCompletion.approvedAt,
      "phase1.ownerCompletion.approvedAt",
    );
    if (Date.parse(approvedAt) < Date.parse(readinessCapturedAt) || Date.parse(approvedAt) > Date.parse(createdAt)) {
      fail("PHASE1_PROOF_BINDING_INVALID", "owner completion timestamp does not bind readiness to campaign");
    }
    if (
      proof.ownerCompletion.manifestSha256 !== manifestSha256
      || proof.ownerCompletion.readinessReportSha256 !== readinessReportSha256
    ) {
      fail("PHASE1_PROOF_BINDING_INVALID", "owner completion is not bound to manifest/readiness hashes");
    }
    ownerCompletion = {
      approvedBy: proof.ownerCompletion.approvedBy,
      decision: proof.ownerCompletion.decision,
      approvalId: identifier(proof.ownerCompletion.approvalId, "phase1.ownerCompletion.approvalId"),
      approvalArtifactSha256: exactSha256(
        proof.ownerCompletion.approvalArtifactSha256,
        "phase1.ownerCompletion.approvalArtifactSha256",
      ),
      approvedAt,
      manifestSha256,
      readinessReportSha256,
    };
  }
  const normalized: ProductTruthExpansionPhase1Proof = {
    manifest: {
      schemaVersion: proof.manifest.schemaVersion,
      sha256: manifestSha256,
      authoritative: proof.manifest.authoritative,
      blockerCount: manifestBlockerCount,
      liveListingCount,
    },
    readiness: {
      schemaVersion: proof.readiness.schemaVersion,
      reportSha256: readinessReportSha256,
      manifestSha256,
      capturedAt: readinessCapturedAt,
      denominator,
      reconciled,
      classified,
      integrityBlockerCount,
      phase1Completion: proof.readiness.phase1Completion,
    },
    ownerCompletion,
  };
  const blockers: string[] = [];
  if (proof.manifest.schemaVersion !== PHASE1_MANIFEST_VERSION) {
    blockers.push("PHASE1_MANIFEST_VERSION_INVALID");
  }
  if (proof.manifest.authoritative !== true || manifestBlockerCount !== 0 || liveListingCount < 1) {
    blockers.push("PHASE1_MANIFEST_NOT_AUTHORITATIVE");
  }
  if (proof.readiness.schemaVersion !== PHASE1_READINESS_VERSION) {
    blockers.push("PHASE1_READINESS_VERSION_INVALID");
  }
  if (
    denominator !== liveListingCount
    || reconciled !== denominator
    || classified !== denominator
  ) {
    blockers.push("PHASE1_READINESS_NOT_RECONCILED");
  }
  if (integrityBlockerCount !== 0 || proof.readiness.phase1Completion !== "PASS") {
    blockers.push("PHASE1_READINESS_INCOMPLETE");
  }
  if (
    ownerCompletion === null
    || ownerCompletion.approvedBy !== "owner"
    || ownerCompletion.decision !== "PHASE1_COMPLETE"
  ) {
    blockers.push("PHASE1_OWNER_COMPLETION_MISSING");
  }
  return { proof: normalized, blockers: sortedUnique(blockers) };
}

function normalizeClubApproval(input: {
  approval: ProductTruthExpansionClubApproval | null;
  clubs: readonly ("samsclub" | "costco")[];
  campaignId: string;
  scopeArtifactSha256: string;
  createdAt: string;
}): ProductTruthExpansionClubApproval | null {
  if (input.clubs.length === 0) {
    if (input.approval !== null) {
      fail("CLUBS_NOT_AUTHORIZED", "club approval cannot be carried into a non-club campaign");
    }
    return null;
  }
  if (input.approval === null) {
    fail("CLUBS_NOT_AUTHORIZED", "Sam's Club/Costco require an exact owner approval");
  }
  const approvedClubs = sortedUnique(input.approval.retailers.map((retailer, index) => {
    const normalized = normalizeRetailer(retailer, `clubApproval.retailers[${index}]`);
    if (normalized !== "samsclub" && normalized !== "costco") {
      fail("CLUBS_NOT_AUTHORIZED", "club approval may cover only Sam's Club/Costco");
    }
    return normalized;
  })) as ("samsclub" | "costco")[];
  if (renderProductTruthExpansionJson(approvedClubs) !== renderProductTruthExpansionJson(input.clubs)) {
    fail("CLUBS_NOT_AUTHORIZED", "club approval retailer set must exactly match campaign clubs");
  }
  const issuedAt = canonicalInstant(input.approval.issuedAt, "clubApproval.issuedAt");
  const expiresAt = canonicalInstant(input.approval.expiresAt, "clubApproval.expiresAt");
  if (Date.parse(issuedAt) > Date.parse(input.createdAt) || Date.parse(expiresAt) < Date.parse(input.createdAt)) {
    fail("CLUBS_NOT_AUTHORIZED", "club approval is not current at campaign sealing time");
  }
  if (
    input.approval.approvedBy !== "owner"
    || input.approval.decision !== "ALLOW_PHASE2_CLUB_SOURCES"
    || input.approval.campaignId !== input.campaignId
    || input.approval.scopeArtifactSha256 !== input.scopeArtifactSha256
  ) {
    fail("CLUBS_NOT_AUTHORIZED", "club approval is not bound to this campaign and scope");
  }
  return {
    approvedBy: "owner",
    decision: "ALLOW_PHASE2_CLUB_SOURCES",
    approvalId: identifier(input.approval.approvalId, "clubApproval.approvalId"),
    approvalArtifactSha256: exactSha256(
      input.approval.approvalArtifactSha256,
      "clubApproval.approvalArtifactSha256",
    ),
    campaignId: input.campaignId,
    scopeArtifactSha256: input.scopeArtifactSha256,
    retailers: approvedClubs,
    issuedAt,
    expiresAt,
  };
}

function normalizeSourcePolicy(input: {
  policy: ProductTruthExpansionSourcePolicyInput;
  campaignId: string;
  scope: ProductTruthExpansionScopeInput;
  createdAt: string;
}): ProductTruthExpansionSourcePolicyInput {
  if (input.policy.allowBjs !== false) {
    fail("BJS_FORBIDDEN", "BJ's is forbidden for every Phase 2 campaign");
  }
  if (input.policy.procurementZip !== "33765") {
    fail("PROCUREMENT_ZIP_FORBIDDEN", "Phase 2 procurement ZIP must be exactly 33765");
  }
  if (input.policy.firstPartyOnly !== true || input.policy.marketplaceSellersAllowed !== false) {
    fail("FIRST_PARTY_ONLY_REQUIRED", "Phase 2 sources must be first-party-only");
  }
  if (!Array.isArray(input.policy.retailers) || input.policy.retailers.length < 1) {
    fail("SOURCE_FORBIDDEN", "at least one explicit first-party retailer is required");
  }
  const retailers = sortedUnique(input.policy.retailers.map((retailer, index) =>
    normalizeRetailer(retailer, `sourcePolicy.retailers[${index}]`))) as ProductTruthExpansionRetailer[];
  const clubs = retailers.filter(
    (retailer): retailer is "samsclub" | "costco" => retailer === "samsclub" || retailer === "costco",
  );
  if (input.policy.allowClubs !== (clubs.length > 0)) {
    fail("CLUBS_NOT_AUTHORIZED", "allowClubs must exactly reflect requested club retailers");
  }
  const clubApproval = normalizeClubApproval({
    approval: input.policy.clubApproval,
    clubs,
    campaignId: input.campaignId,
    scopeArtifactSha256: input.scope.sourceArtifactSha256,
    createdAt: input.createdAt,
  });
  if (input.scope.dimension === "retailer") {
    const missing = input.scope.selectors.filter((selector) =>
      !retailers.includes(selector as ProductTruthExpansionRetailer));
    if (missing.length > 0) {
      fail("EXPANSION_SCOPE_INVALID", "retailer scope selectors must be included in source policy");
    }
  }
  return {
    procurementZip: "33765",
    firstPartyOnly: true,
    marketplaceSellersAllowed: false,
    retailers,
    allowClubs: clubs.length > 0,
    allowBjs: false,
    clubApproval,
  };
}

function normalizeProviderCeilings(
  values: readonly ProductTruthExpansionProviderCeilingInput[],
): ProductTruthExpansionProviderCeilingInput[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 50) {
    fail("EXPANSION_BUDGET_INVALID", "providerCeilings must contain 1-50 exact ceilings");
  }
  const seen = new Set<string>();
  return values.map((value, index) => {
    const provider = providerIdentifier(value.provider, `providerCeilings[${index}].provider`);
    const operation = providerIdentifier(value.operation, `providerCeilings[${index}].operation`);
    const key = `${provider}\u0000${operation}`;
    if (seen.has(key)) {
      fail("EXPANSION_BUDGET_INVALID", `duplicate provider ceiling ${provider}/${operation}`);
    }
    seen.add(key);
    return {
      provider,
      operation,
      maxCalls: integerInRange(value.maxCalls, `providerCeilings[${index}].maxCalls`, 1, 10_000_000),
      maxCredits: integerInRange(value.maxCredits, `providerCeilings[${index}].maxCredits`, 0, 1_000_000_000),
      reserveFloorCredits: integerInRange(
        value.reserveFloorCredits,
        `providerCeilings[${index}].reserveFloorCredits`,
        0,
        1_000_000_000,
      ),
    };
  }).sort((left, right) => lexicalCompare(
    `${left.provider}\u0000${left.operation}`,
    `${right.provider}\u0000${right.operation}`,
  ));
}

function normalizeSourceRoutes(input: {
  routes: readonly ProductTruthExpansionSourceRouteInput[];
  policy: ProductTruthExpansionSourcePolicyInput;
  ceilings: readonly ProductTruthExpansionProviderCeilingInput[];
}): ProductTruthExpansionSourceRouteInput[] {
  if (!Array.isArray(input.routes) || input.routes.length < 1 || input.routes.length > 100) {
    fail("SOURCE_ROUTE_INVALID", "sourceRoutes must contain 1-100 explicit routes");
  }
  const ceilingKeys = new Set(input.ceilings.map((row) => `${row.provider}\u0000${row.operation}`));
  const rows = new Map<string, ProductTruthExpansionSourceRouteInput>();
  input.routes.forEach((route, index) => {
    const retailer = normalizeRetailer(route.retailer, `sourceRoutes[${index}].retailer`);
    const provider = providerIdentifier(route.provider, `sourceRoutes[${index}].provider`);
    const operation = providerIdentifier(route.operation, `sourceRoutes[${index}].operation`);
    if (route.firstPartyOnly !== true) {
      fail("FIRST_PARTY_ONLY_REQUIRED", "every source route must be first-party-only");
    }
    if (!input.policy.retailers.includes(retailer)) {
      fail("SOURCE_ROUTE_INVALID", `route retailer ${retailer} is outside source policy`);
    }
    if (!ceilingKeys.has(`${provider}\u0000${operation}`)) {
      fail("SOURCE_ROUTE_INVALID", `route ${provider}/${operation} has no exact provider ceiling`);
    }
    const key = `${retailer}\u0000${provider}\u0000${operation}`;
    rows.set(key, { retailer, provider, operation, firstPartyOnly: true });
  });
  for (const retailer of input.policy.retailers) {
    if (![...rows.values()].some((row) => row.retailer === retailer)) {
      fail("SOURCE_ROUTE_INVALID", `retailer ${retailer} has no explicit source route`);
    }
  }
  for (const ceilingKey of ceilingKeys) {
    if (![...rows.values()].some((row) => `${row.provider}\u0000${row.operation}` === ceilingKey)) {
      fail("EXPANSION_BUDGET_INVALID", `provider ceiling ${ceilingKey.replace("\u0000", "/")} is not route-bound`);
    }
  }
  return [...rows.values()].sort((left, right) => lexicalCompare(
    `${left.retailer}\u0000${left.provider}\u0000${left.operation}`,
    `${right.retailer}\u0000${right.provider}\u0000${right.operation}`,
  ));
}

function normalizeCompletionCriteria(
  input: ProductTruthExpansionCampaignInput["completionCriteria"],
  limits: ProductTruthExpansionCampaignInput["limits"],
): ProductTruthExpansionCampaignInput["completionCriteria"] {
  if (
    input.requireScopeExhausted !== true
    || input.requireExactReconciliation !== true
    || input.requireNoPendingItems !== true
    || input.requireNoUnsettledPaidOutcomes !== true
    || input.requireFinalQualityReport !== true
  ) {
    fail("COMPLETION_CRITERIA_INVALID", "all fail-closed completion requirements must be true");
  }
  return {
    minimumAcceptedItems: integerInRange(
      input.minimumAcceptedItems,
      "completionCriteria.minimumAcceptedItems",
      0,
      limits.maxAcceptedItems,
    ),
    minimumCatalogReadyBasisPoints: integerInRange(
      input.minimumCatalogReadyBasisPoints,
      "completionCriteria.minimumCatalogReadyBasisPoints",
      0,
      10_000,
    ),
    maximumUnresolvedItems: integerInRange(
      input.maximumUnresolvedItems,
      "completionCriteria.maximumUnresolvedItems",
      0,
      limits.maxDiscoveredItems,
    ),
    requireScopeExhausted: true,
    requireExactReconciliation: true,
    requireNoPendingItems: true,
    requireNoUnsettledPaidOutcomes: true,
    requireFinalQualityReport: true,
  };
}

function safeSum(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) fail("EXPANSION_BUDGET_INVALID", `${label} exceeds safe integer range`);
  return total;
}

export function sealProductTruthExpansionCampaign(
  input: ProductTruthExpansionCampaignInput,
): SealedProductTruthExpansionCampaign {
  const campaignId = identifier(input.campaignId, "campaignId");
  const createdAt = canonicalInstant(input.createdAt, "createdAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  const lifetimeMs = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetimeMs <= 0 || lifetimeMs > MAX_CAMPAIGN_LIFETIME_MS) {
    fail("EXPANSION_INPUT_INVALID", "campaign lifetime must be positive and at most 30 days");
  }
  const scope = normalizeScope(input.scope);
  const sourcePolicy = normalizeSourcePolicy({ policy: input.sourcePolicy, campaignId, scope, createdAt });
  const campaignKey = deriveProductTruthExpansionCampaignKey({
    scope,
    procurementZip: sourcePolicy.procurementZip,
  });
  const ceilings = normalizeProviderCeilings(input.providerCeilings);
  const routes = normalizeSourceRoutes({ routes: input.sourceRoutes, policy: sourcePolicy, ceilings });
  const limits = {
    maxDiscoveredItems: integerInRange(
      input.limits.maxDiscoveredItems,
      "limits.maxDiscoveredItems",
      1,
      1_000_000,
    ),
    maxAcceptedItems: integerInRange(
      input.limits.maxAcceptedItems,
      "limits.maxAcceptedItems",
      1,
      1_000_000,
    ),
  };
  if (limits.maxAcceptedItems > limits.maxDiscoveredItems) {
    fail("EXPANSION_LIMIT_INVALID", "maxAcceptedItems cannot exceed maxDiscoveredItems");
  }
  const matcherVersion = versionIdentifier(input.matcherVersion, "matcherVersion");
  const activeCampaignSnapshotMaxAgeMs = integerInRange(
    input.activeCampaignSnapshotMaxAgeMs,
    "activeCampaignSnapshotMaxAgeMs",
    1,
    MAX_ACTIVE_SNAPSHOT_AGE_MS,
  );
  const checkpointEveryDiscoveredItems = integerInRange(
    input.checkpointEveryDiscoveredItems,
    "checkpointEveryDiscoveredItems",
    1,
    limits.maxDiscoveredItems,
  );
  const completionCriteria = normalizeCompletionCriteria(input.completionCriteria, limits);
  const blockers: string[] = [];
  let phase1Proof: ProductTruthExpansionPhase1Proof | null = null;
  if (input.phase1Proof === null) {
    blockers.push("PHASE1_PROOF_MISSING");
  } else {
    const normalized = normalizePhase1Proof(input.phase1Proof, createdAt);
    phase1Proof = normalized.proof;
    blockers.push(...normalized.blockers);
  }
  let activeCampaignSnapshot: ProductTruthExpansionActiveCampaignSnapshot | null = null;
  if (input.activeCampaignSnapshot === null) {
    blockers.push("ACTIVE_CAMPAIGN_SNAPSHOT_MISSING");
  } else {
    activeCampaignSnapshot = validateActiveSnapshot(input.activeCampaignSnapshot);
    const snapshotAgeMs = Date.parse(createdAt) - Date.parse(activeCampaignSnapshot.capturedAt);
    if (snapshotAgeMs < 0) {
      fail("ACTIVE_CAMPAIGN_SNAPSHOT_INVALID", "active campaign snapshot cannot be from the future");
    }
    if (snapshotAgeMs > activeCampaignSnapshotMaxAgeMs) {
      blockers.push("ACTIVE_CAMPAIGN_SNAPSHOT_STALE");
    }
    if (activeCampaignSnapshot.activeCampaignKeys.includes(campaignKey)) {
      blockers.push("CAMPAIGN_KEY_ALREADY_ACTIVE");
    }
  }
  const sortedBlockers = sortedUnique(blockers);
  const artifact: ProductTruthExpansionCampaignArtifact = {
    schemaVersion: PRODUCT_TRUTH_EXPANSION_CAMPAIGN_VERSION,
    policyVersion: PRODUCT_TRUTH_EXPANSION_CAMPAIGN_POLICY_VERSION,
    campaignId,
    createdAt,
    expiresAt,
    campaignKey,
    status: sortedBlockers.length === 0 ? "READY" : "BLOCKED",
    blockers: sortedBlockers,
    phase1Proof,
    scope,
    sourcePolicy,
    sourceRoutes: routes,
    budget: {
      providerCeilings: ceilings,
      totalMaxCalls: safeSum(ceilings.map((row) => row.maxCalls), "totalMaxCalls"),
      totalMaxCredits: safeSum(ceilings.map((row) => row.maxCredits), "totalMaxCredits"),
    },
    limits,
    dedup: {
      campaignKeyVersion: CAMPAIGN_KEY_VERSION,
      itemDedupVersion: ITEM_DEDUP_VERSION,
      matcherVersion,
      activeCampaignSnapshot,
      activeCampaignSnapshotMaxAgeMs,
    },
    checkpointPolicy: {
      checkpointEveryDiscoveredItems,
      appendOnlyHashChain: true,
      cumulativeState: true,
    },
    completionCriteria,
    claims: {
      databaseReads: false,
      databaseWrites: false,
      networkCalls: false,
      providerCalls: false,
      paidCalls: false,
      modelCalls: false,
      catalogMutations: false,
      marketplaceMutations: false,
      procurementMutations: false,
      executionAuthorized: false,
      ownerActivationGranted: false,
    },
  };
  return { artifact, artifactSha256: productTruthExpansionSha256(artifact) };
}

function campaignInputFromArtifact(
  artifact: ProductTruthExpansionCampaignArtifact,
): ProductTruthExpansionCampaignInput {
  return {
    campaignId: artifact.campaignId,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    phase1Proof: artifact.phase1Proof,
    scope: artifact.scope,
    sourcePolicy: artifact.sourcePolicy,
    sourceRoutes: artifact.sourceRoutes,
    providerCeilings: artifact.budget.providerCeilings,
    limits: artifact.limits,
    matcherVersion: artifact.dedup.matcherVersion,
    activeCampaignSnapshot: artifact.dedup.activeCampaignSnapshot,
    activeCampaignSnapshotMaxAgeMs: artifact.dedup.activeCampaignSnapshotMaxAgeMs,
    checkpointEveryDiscoveredItems: artifact.checkpointPolicy.checkpointEveryDiscoveredItems,
    completionCriteria: artifact.completionCriteria,
  };
}

export function validateSealedProductTruthExpansionCampaign(
  value: unknown,
): SealedProductTruthExpansionCampaign {
  if (!isRecord(value)) fail("EXPANSION_ARTIFACT_INVALID", "sealed campaign must be an object");
  exactKeys(value, ["artifact", "artifactSha256"], "sealedCampaign");
  if (!isRecord(value.artifact)) fail("EXPANSION_ARTIFACT_INVALID", "artifact must be an object");
  const artifact = value.artifact as unknown as ProductTruthExpansionCampaignArtifact;
  if (
    artifact.schemaVersion !== PRODUCT_TRUTH_EXPANSION_CAMPAIGN_VERSION
    || artifact.policyVersion !== PRODUCT_TRUTH_EXPANSION_CAMPAIGN_POLICY_VERSION
  ) {
    fail("EXPANSION_ARTIFACT_INVALID", "campaign schema/policy version is unsupported");
  }
  const artifactSha256 = exactSha256(value.artifactSha256, "artifactSha256");
  if (productTruthExpansionSha256(artifact) !== artifactSha256) {
    fail("EXPANSION_ARTIFACT_TAMPERED", "campaign artifact SHA-256 does not match its payload");
  }
  const rebuilt = sealProductTruthExpansionCampaign(campaignInputFromArtifact(artifact));
  if (
    rebuilt.artifactSha256 !== artifactSha256
    || renderProductTruthExpansionJson(rebuilt.artifact) !== renderProductTruthExpansionJson(artifact)
  ) {
    fail("EXPANSION_ARTIFACT_TAMPERED", "campaign artifact is not canonical under current policy");
  }
  return rebuilt;
}

function normalizeAcceptedItems(
  values: readonly ProductTruthExpansionAcceptedItemInput[],
): ProductTruthExpansionAcceptedItemInput[] {
  if (!Array.isArray(values)) fail("CHECKPOINT_RECONCILIATION_FAILED", "acceptedItems must be an array");
  const rows = new Map<string, ProductTruthExpansionAcceptedItemInput>();
  values.forEach((value, index) => {
    const key = itemKey(value.itemKey, `acceptedItems[${index}].itemKey`);
    const status = value.evidenceStatus;
    if (status !== "IDENTITY_READY" && status !== "CATALOG_READY") {
      fail("CHECKPOINT_RECONCILIATION_FAILED", `acceptedItems[${index}].evidenceStatus is invalid`);
    }
    const contentEvidenceSha256 = value.contentEvidenceSha256 === null
      ? null
      : exactSha256(value.contentEvidenceSha256, `acceptedItems[${index}].contentEvidenceSha256`);
    if (
      (status === "CATALOG_READY" && contentEvidenceSha256 === null)
      || (status === "IDENTITY_READY" && contentEvidenceSha256 !== null)
    ) {
      fail("CHECKPOINT_RECONCILIATION_FAILED", "content evidence must exactly match evidenceStatus");
    }
    const row: ProductTruthExpansionAcceptedItemInput = {
      itemKey: key,
      canonicalVariantId: identifier(
        value.canonicalVariantId,
        `acceptedItems[${index}].canonicalVariantId`,
      ),
      identityEvidenceSha256: exactSha256(
        value.identityEvidenceSha256,
        `acceptedItems[${index}].identityEvidenceSha256`,
      ),
      contentEvidenceSha256,
      evidenceStatus: status,
    };
    const existing = rows.get(key);
    if (existing && renderProductTruthExpansionJson(existing) !== renderProductTruthExpansionJson(row)) {
      fail("CHECKPOINT_RECONCILIATION_FAILED", `accepted item ${key} has conflicting records`);
    }
    rows.set(key, row);
  });
  return [...rows.values()].sort((left, right) => lexicalCompare(left.itemKey, right.itemKey));
}

function normalizeRejectedItems(
  values: readonly ProductTruthExpansionRejectedItemInput[],
): ProductTruthExpansionRejectedItemInput[] {
  if (!Array.isArray(values)) fail("CHECKPOINT_RECONCILIATION_FAILED", "rejectedItems must be an array");
  const allowedReasons = new Set([
    "DUPLICATE_EXISTING",
    "OUT_OF_SCOPE",
    "VARIANT_AMBIGUOUS",
    "UNSOURCEABLE",
    "POLICY_REJECTED",
  ]);
  const rows = new Map<string, ProductTruthExpansionRejectedItemInput>();
  values.forEach((value, index) => {
    const key = itemKey(value.itemKey, `rejectedItems[${index}].itemKey`);
    if (!allowedReasons.has(value.reasonCode)) {
      fail("CHECKPOINT_RECONCILIATION_FAILED", `rejectedItems[${index}].reasonCode is invalid`);
    }
    const row: ProductTruthExpansionRejectedItemInput = { itemKey: key, reasonCode: value.reasonCode };
    const existing = rows.get(key);
    if (existing && existing.reasonCode !== row.reasonCode) {
      fail("CHECKPOINT_RECONCILIATION_FAILED", `rejected item ${key} has conflicting reasons`);
    }
    rows.set(key, row);
  });
  return [...rows.values()].sort((left, right) => lexicalCompare(left.itemKey, right.itemKey));
}

function normalizeProviderUsage(
  values: readonly ProductTruthExpansionProviderUsageInput[],
  ceilings: readonly ProductTruthExpansionProviderCeilingInput[],
): ProductTruthExpansionProviderUsageInput[] {
  if (!Array.isArray(values)) fail("CHECKPOINT_BUDGET_INVALID", "providerUsage must be an array");
  const ceilingByKey = new Map(ceilings.map((row) => [`${row.provider}\u0000${row.operation}`, row]));
  const rows = new Map<string, ProductTruthExpansionProviderUsageInput>();
  values.forEach((value, index) => {
    const provider = providerIdentifier(value.provider, `providerUsage[${index}].provider`);
    const operation = providerIdentifier(value.operation, `providerUsage[${index}].operation`);
    const key = `${provider}\u0000${operation}`;
    const ceiling = ceilingByKey.get(key);
    if (!ceiling || rows.has(key)) {
      fail("CHECKPOINT_BUDGET_INVALID", `provider usage ${provider}/${operation} is absent or duplicate`);
    }
    const callsUsed = integerInRange(value.callsUsed, `providerUsage[${index}].callsUsed`, 0, ceiling.maxCalls);
    const creditsUsed = integerInRange(
      value.creditsUsed,
      `providerUsage[${index}].creditsUsed`,
      0,
      ceiling.maxCredits,
    );
    rows.set(key, { provider, operation, callsUsed, creditsUsed });
  });
  if (rows.size !== ceilingByKey.size) {
    fail("CHECKPOINT_BUDGET_INVALID", "providerUsage must reconcile every exact provider ceiling");
  }
  return [...rows.values()].sort((left, right) => lexicalCompare(
    `${left.provider}\u0000${left.operation}`,
    `${right.provider}\u0000${right.operation}`,
  ));
}

function buildCheckpointArtifact(input: {
  campaign: SealedProductTruthExpansionCampaign;
  sequence: number;
  previousCheckpointSha256: string | null;
  checkpoint: ProductTruthExpansionCheckpointInput;
}): ProductTruthExpansionCheckpointArtifact {
  const campaign = input.campaign.artifact;
  const capturedAt = canonicalInstant(input.checkpoint.capturedAt, "checkpoint.capturedAt");
  if (Date.parse(capturedAt) < Date.parse(campaign.createdAt) || Date.parse(capturedAt) > Date.parse(campaign.expiresAt)) {
    fail("CHECKPOINT_INVALID", "checkpoint timestamp is outside the sealed campaign lifetime");
  }
  if (typeof input.checkpoint.scopeExhausted !== "boolean") {
    fail("CHECKPOINT_INVALID", "scopeExhausted must be boolean");
  }
  if (!Array.isArray(input.checkpoint.discoveredItemKeys)) {
    fail("CHECKPOINT_RECONCILIATION_FAILED", "discoveredItemKeys must be an array");
  }
  const discoveredItemKeys = sortedUnique(input.checkpoint.discoveredItemKeys.map((value, index) =>
    itemKey(value, `discoveredItemKeys[${index}]`)));
  const acceptedItems = normalizeAcceptedItems(input.checkpoint.acceptedItems);
  const rejectedItems = normalizeRejectedItems(input.checkpoint.rejectedItems);
  if (!Array.isArray(input.checkpoint.pendingItemKeys)) {
    fail("CHECKPOINT_RECONCILIATION_FAILED", "pendingItemKeys must be an array");
  }
  const pendingItemKeys = sortedUnique(input.checkpoint.pendingItemKeys.map((value, index) =>
    itemKey(value, `pendingItemKeys[${index}]`)));
  if (!Array.isArray(input.checkpoint.unsettledPaidOutcomeKeys)) {
    fail("CHECKPOINT_RECONCILIATION_FAILED", "unsettledPaidOutcomeKeys must be an array");
  }
  const unsettledPaidOutcomeKeys = sortedUnique(
    input.checkpoint.unsettledPaidOutcomeKeys.map((value, index) =>
      itemKey(value, `unsettledPaidOutcomeKeys[${index}]`)),
  );
  const finalQualityReportSha256 = input.checkpoint.finalQualityReportSha256 === null
    ? null
    : exactSha256(input.checkpoint.finalQualityReportSha256, "finalQualityReportSha256");
  if (discoveredItemKeys.length > campaign.limits.maxDiscoveredItems) {
    fail("CHECKPOINT_LIMIT_EXCEEDED", "unique discovered items exceed campaign ceiling");
  }
  if (acceptedItems.length > campaign.limits.maxAcceptedItems) {
    fail("CHECKPOINT_LIMIT_EXCEEDED", "accepted items exceed campaign ceiling");
  }
  const discovered = new Set(discoveredItemKeys);
  const acceptedKeys = new Set(acceptedItems.map((row) => row.itemKey));
  const rejectedKeys = new Set(rejectedItems.map((row) => row.itemKey));
  const pendingKeys = new Set(pendingItemKeys);
  for (const key of [...acceptedKeys, ...rejectedKeys, ...pendingKeys]) {
    if (!discovered.has(key)) {
      fail("CHECKPOINT_RECONCILIATION_FAILED", `classified item ${key} was not discovered`);
    }
  }
  for (const key of acceptedKeys) {
    if (rejectedKeys.has(key) || pendingKeys.has(key)) {
      fail("CHECKPOINT_RECONCILIATION_FAILED", `accepted item ${key} has another classification`);
    }
  }
  for (const key of rejectedKeys) {
    if (pendingKeys.has(key)) {
      fail("CHECKPOINT_RECONCILIATION_FAILED", `rejected item ${key} is also pending`);
    }
  }
  const classified = new Set([...acceptedKeys, ...rejectedKeys, ...pendingKeys]);
  if (classified.size !== discovered.size) {
    fail("CHECKPOINT_RECONCILIATION_FAILED", "accepted/rejected/pending must exactly partition discovery");
  }
  const providerUsage = normalizeProviderUsage(
    input.checkpoint.providerUsage,
    campaign.budget.providerCeilings,
  );
  const catalogReadyAccepted = acceptedItems.filter((row) => row.evidenceStatus === "CATALOG_READY").length;
  const unresolved = rejectedItems.filter(
    (row) => row.reasonCode === "VARIANT_AMBIGUOUS" || row.reasonCode === "UNSOURCEABLE",
  ).length;
  const catalogReadyBasisPoints = acceptedItems.length === 0
    ? 10_000
    : Math.floor((catalogReadyAccepted * 10_000) / acceptedItems.length);
  const blockers: string[] = [];
  if (!input.checkpoint.scopeExhausted) blockers.push("SCOPE_NOT_EXHAUSTED");
  if (pendingItemKeys.length > 0) blockers.push("PENDING_ITEMS_REMAIN");
  if (acceptedItems.length < campaign.completionCriteria.minimumAcceptedItems) {
    blockers.push("MINIMUM_ACCEPTED_ITEMS_NOT_MET");
  }
  if (catalogReadyBasisPoints < campaign.completionCriteria.minimumCatalogReadyBasisPoints) {
    blockers.push("CATALOG_READY_TARGET_NOT_MET");
  }
  if (unresolved > campaign.completionCriteria.maximumUnresolvedItems) {
    blockers.push("MAXIMUM_UNRESOLVED_ITEMS_EXCEEDED");
  }
  if (unsettledPaidOutcomeKeys.length > 0) blockers.push("UNSETTLED_PAID_OUTCOMES");
  if (finalQualityReportSha256 === null) blockers.push("FINAL_QUALITY_REPORT_MISSING");
  const sortedBlockers = sortedUnique(blockers);
  const status: ProductTruthExpansionCheckpointStatus = sortedBlockers.length === 0
    ? "COMPLETE"
    : input.checkpoint.scopeExhausted
      ? "BLOCKED"
      : "IN_PROGRESS";
  return {
    schemaVersion: PRODUCT_TRUTH_EXPANSION_CHECKPOINT_VERSION,
    campaignKey: campaign.campaignKey,
    campaignArtifactSha256: input.campaign.artifactSha256,
    sequence: input.sequence,
    previousCheckpointSha256: input.previousCheckpointSha256,
    capturedAt,
    status,
    blockers: sortedBlockers,
    scopeExhausted: input.checkpoint.scopeExhausted,
    discoveredItemKeys,
    acceptedItems,
    rejectedItems,
    pendingItemKeys,
    providerUsage,
    unsettledPaidOutcomeKeys,
    finalQualityReportSha256,
    reconciliation: {
      discovered: discoveredItemKeys.length,
      accepted: acceptedItems.length,
      rejected: rejectedItems.length,
      pending: pendingItemKeys.length,
      catalogReadyAccepted,
      unresolved,
      catalogReadyBasisPoints,
      partitionComplete: true,
      totalCallsUsed: safeSum(providerUsage.map((row) => row.callsUsed), "totalCallsUsed"),
      totalCreditsUsed: safeSum(providerUsage.map((row) => row.creditsUsed), "totalCreditsUsed"),
    },
    claims: {
      checkpointBuildDatabaseReads: false,
      checkpointBuildDatabaseWrites: false,
      checkpointBuildNetworkCalls: false,
      checkpointBuildProviderCalls: false,
      checkpointBuildPaidCalls: false,
      checkpointBuildModelCalls: false,
      executionAuthorized: false,
    },
  };
}

function assertCheckpointProgression(input: {
  campaign: ProductTruthExpansionCampaignArtifact;
  previous: ProductTruthExpansionCheckpointArtifact;
  next: ProductTruthExpansionCheckpointArtifact;
}): void {
  const previous = input.previous;
  const next = input.next;
  if (previous.status === "COMPLETE") {
    fail("CHECKPOINT_CHAIN_INVALID", "a completed campaign cannot receive another checkpoint");
  }
  if (Date.parse(next.capturedAt) < Date.parse(previous.capturedAt)) {
    fail("CHECKPOINT_CHAIN_INVALID", "checkpoint time cannot move backwards");
  }
  const previousDiscovered = new Set(previous.discoveredItemKeys);
  const nextDiscovered = new Set(next.discoveredItemKeys);
  for (const key of previousDiscovered) {
    if (!nextDiscovered.has(key)) fail("CHECKPOINT_CHAIN_INVALID", `discovered item ${key} disappeared`);
  }
  const newlyDiscovered = next.discoveredItemKeys.filter((key) => !previousDiscovered.has(key)).length;
  if (newlyDiscovered > input.campaign.checkpointPolicy.checkpointEveryDiscoveredItems) {
    fail("CHECKPOINT_CADENCE_EXCEEDED", "new discoveries exceed checkpoint cadence");
  }
  if (previous.scopeExhausted && (
    !next.scopeExhausted || next.discoveredItemKeys.length !== previous.discoveredItemKeys.length
  )) {
    fail("CHECKPOINT_CHAIN_INVALID", "scope exhaustion cannot be reversed or discover new items");
  }
  const nextAccepted = new Map(next.acceptedItems.map((row) => [row.itemKey, row]));
  const nextRejected = new Map(next.rejectedItems.map((row) => [row.itemKey, row]));
  for (const row of previous.acceptedItems) {
    const current = nextAccepted.get(row.itemKey);
    if (!current) fail("CHECKPOINT_CHAIN_INVALID", `accepted item ${row.itemKey} disappeared`);
    if (
      current.canonicalVariantId !== row.canonicalVariantId
      || current.identityEvidenceSha256 !== row.identityEvidenceSha256
      || (row.evidenceStatus === "CATALOG_READY" && renderProductTruthExpansionJson(current) !== renderProductTruthExpansionJson(row))
    ) {
      fail("CHECKPOINT_CHAIN_INVALID", `accepted item ${row.itemKey} was rewritten`);
    }
  }
  for (const row of previous.rejectedItems) {
    const current = nextRejected.get(row.itemKey);
    if (!current || current.reasonCode !== row.reasonCode) {
      fail("CHECKPOINT_CHAIN_INVALID", `rejected item ${row.itemKey} was rewritten`);
    }
  }
  const previousAcceptedKeys = new Set(previous.acceptedItems.map((row) => row.itemKey));
  const previousRejectedKeys = new Set(previous.rejectedItems.map((row) => row.itemKey));
  for (const row of next.acceptedItems) {
    if (previousRejectedKeys.has(row.itemKey)) {
      fail("CHECKPOINT_CHAIN_INVALID", `rejected item ${row.itemKey} became accepted`);
    }
  }
  for (const row of next.rejectedItems) {
    if (previousAcceptedKeys.has(row.itemKey)) {
      fail("CHECKPOINT_CHAIN_INVALID", `accepted item ${row.itemKey} became rejected`);
    }
  }
  const previousUsage = new Map(previous.providerUsage.map((row) => [
    `${row.provider}\u0000${row.operation}`,
    row,
  ]));
  for (const row of next.providerUsage) {
    const old = previousUsage.get(`${row.provider}\u0000${row.operation}`);
    if (!old || row.callsUsed < old.callsUsed || row.creditsUsed < old.creditsUsed) {
      fail("CHECKPOINT_CHAIN_INVALID", `provider usage ${row.provider}/${row.operation} moved backwards`);
    }
  }
  if (
    previous.finalQualityReportSha256 !== null
    && previous.finalQualityReportSha256 !== next.finalQualityReportSha256
  ) {
    fail("CHECKPOINT_CHAIN_INVALID", "final quality report binding cannot change");
  }
}

export function sealProductTruthExpansionCheckpoint(input: {
  campaign: SealedProductTruthExpansionCampaign;
  previousCheckpoint?: SealedProductTruthExpansionCheckpoint | null;
  checkpoint: ProductTruthExpansionCheckpointInput;
}): SealedProductTruthExpansionCheckpoint {
  const campaign = validateSealedProductTruthExpansionCampaign(input.campaign);
  if (campaign.artifact.status !== "READY") {
    fail("CAMPAIGN_NOT_READY", "blocked Phase 2 campaign cannot create checkpoints");
  }
  const previous = input.previousCheckpoint == null
    ? null
    : validateSealedProductTruthExpansionCheckpoint(input.previousCheckpoint, campaign);
  const sequence = previous === null ? 1 : previous.artifact.sequence + 1;
  const artifact = buildCheckpointArtifact({
    campaign,
    sequence,
    previousCheckpointSha256: previous?.checkpointSha256 ?? null,
    checkpoint: input.checkpoint,
  });
  const previousDiscovered = previous?.artifact.discoveredItemKeys ?? [];
  const delta = artifact.discoveredItemKeys.filter((key) => !previousDiscovered.includes(key)).length;
  if (delta > campaign.artifact.checkpointPolicy.checkpointEveryDiscoveredItems) {
    fail("CHECKPOINT_CADENCE_EXCEEDED", "discoveries exceed sealed checkpoint cadence");
  }
  if (previous !== null) {
    assertCheckpointProgression({ campaign: campaign.artifact, previous: previous.artifact, next: artifact });
  }
  return { artifact, checkpointSha256: productTruthExpansionSha256(artifact) };
}

function checkpointInputFromArtifact(
  artifact: ProductTruthExpansionCheckpointArtifact,
): ProductTruthExpansionCheckpointInput {
  return {
    capturedAt: artifact.capturedAt,
    scopeExhausted: artifact.scopeExhausted,
    discoveredItemKeys: artifact.discoveredItemKeys,
    acceptedItems: artifact.acceptedItems,
    rejectedItems: artifact.rejectedItems,
    pendingItemKeys: artifact.pendingItemKeys,
    providerUsage: artifact.providerUsage,
    unsettledPaidOutcomeKeys: artifact.unsettledPaidOutcomeKeys,
    finalQualityReportSha256: artifact.finalQualityReportSha256,
  };
}

export function validateSealedProductTruthExpansionCheckpoint(
  value: unknown,
  campaignValue: SealedProductTruthExpansionCampaign,
): SealedProductTruthExpansionCheckpoint {
  const campaign = validateSealedProductTruthExpansionCampaign(campaignValue);
  if (!isRecord(value)) fail("CHECKPOINT_INVALID", "sealed checkpoint must be an object");
  exactKeys(value, ["artifact", "checkpointSha256"], "sealedCheckpoint");
  if (!isRecord(value.artifact)) fail("CHECKPOINT_INVALID", "checkpoint artifact must be an object");
  const artifact = value.artifact as unknown as ProductTruthExpansionCheckpointArtifact;
  if (
    artifact.schemaVersion !== PRODUCT_TRUTH_EXPANSION_CHECKPOINT_VERSION
    || artifact.campaignKey !== campaign.artifact.campaignKey
    || artifact.campaignArtifactSha256 !== campaign.artifactSha256
  ) {
    fail("CHECKPOINT_INVALID", "checkpoint is not bound to the sealed campaign");
  }
  const checkpointSha256 = exactSha256(value.checkpointSha256, "checkpointSha256");
  if (productTruthExpansionSha256(artifact) !== checkpointSha256) {
    fail("CHECKPOINT_TAMPERED", "checkpoint SHA-256 does not match its payload");
  }
  const sequence = integerInRange(artifact.sequence, "checkpoint.sequence", 1, 1_000_000);
  const previousCheckpointSha256 = artifact.previousCheckpointSha256 === null
    ? null
    : exactSha256(artifact.previousCheckpointSha256, "previousCheckpointSha256");
  if ((sequence === 1) !== (previousCheckpointSha256 === null)) {
    fail("CHECKPOINT_CHAIN_INVALID", "only sequence 1 may omit previous checkpoint hash");
  }
  const rebuiltArtifact = buildCheckpointArtifact({
    campaign,
    sequence,
    previousCheckpointSha256,
    checkpoint: checkpointInputFromArtifact(artifact),
  });
  if (renderProductTruthExpansionJson(rebuiltArtifact) !== renderProductTruthExpansionJson(artifact)) {
    fail("CHECKPOINT_TAMPERED", "checkpoint is not canonical under sealed campaign policy");
  }
  return { artifact: rebuiltArtifact, checkpointSha256 };
}
