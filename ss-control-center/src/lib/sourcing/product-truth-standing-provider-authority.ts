import { createHash } from "node:crypto";

import type {
  MeteredProvider,
  MeteredRunPermit,
} from "./metered-call-guard";
import {
  encodeMeteredRunPermit,
  expectedMeteredRunConfirmation,
} from "./metered-call-guard";
import {
  PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
  PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
  expectedProductTruthExecutionConfirmation,
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
  validateProductTruthOperationalApproval,
  type ProductTruthOperationalApproval,
  type ProductTruthOperationalPlan,
} from "./product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
  validateProductTruthTargetedWalmartEvidenceApproval,
  type ProductTruthTargetedWalmartEvidencePlan,
} from "./product-truth-targeted-walmart-evidence-contract";

export const PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_VERSION =
  "product-truth-standing-provider-policy/1.0.0" as const;
export const PRODUCT_TRUTH_UNWRANGLE_BALANCE_EVIDENCE_VERSION =
  "product-truth-unwrangle-balance-evidence/1.2.0" as const;
export const PRODUCT_TRUTH_STANDING_AUTHORIZATION_VERSION =
  "product-truth-standing-authorization/1.0.0" as const;

/**
 * The policy is an owner-custodied project artifact. Pinning its exact bytes here
 * prevents a modified worktree policy from silently expanding provider authority.
 */
export const PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256 =
  "7b7bcc997e340e46c97482c8c9f29f64cefdc8e46eadbd13d459d5953ed03eb0" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

type SupportedPlan =
  | ProductTruthOperationalPlan
  | ProductTruthTargetedWalmartEvidencePlan;

interface ProductTruthStandingProviderRule {
  provider: "oxylabs" | "unwrangle";
  operations: readonly string[];
  maximumUnitsPerCall: number;
}

export interface ProductTruthStandingProviderPolicy {
  schemaVersion: typeof PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_VERSION;
  policyId: string;
  approvedBy: "owner";
  ownerStatement: string;
  issuedAt: string;
  expiresAt: null;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  allowedPlanSchemaVersions: readonly [
    typeof PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
    typeof PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
  ];
  maximumApprovalLifetimeMs: number;
  maximumBalanceEvidenceAgeMs: number;
  maximumListingsPerPlan: number;
  maximumProviderUnitsPerPlan: number;
  unwrangleReserveFloorMinimum: number;
  balanceProbe: {
    provider: "unwrangle";
    operation: "target_search";
    query: "water";
    maxCallsPerPlan: 1;
    maxUnitsPerCall: 2.5;
  };
  providerRules: readonly ProductTruthStandingProviderRule[];
  allowAutomaticProviderEnrichment: true;
  allowCanonicalProductTruthWrites: true;
  allowMarketplaceListingWrites: false;
  allowPriceChanges: false;
  allowInventoryChanges: false;
  allowDelisting: false;
  allowConsumerActivation: false;
  allowProcurement: false;
  allowHarvestCronActivation: false;
  allowClubs: false;
  allowBjs: false;
  requiresAuthoritativePhase1Scope: true;
  requiresExactFirstPartyEvidence: true;
  requiresFreshBalanceEvidence: true;
  requiresNoAutomaticReplay: true;
  requiresNoRetry: true;
  requiresSingleConcurrency: true;
  revocationRequiresOwnerDecision: true;
}

export interface ProductTruthStandingBalanceProbeArtifact {
  schemaVersion: typeof PRODUCT_TRUTH_UNWRANGLE_BALANCE_EVIDENCE_VERSION;
  probeId: string;
  provider: "unwrangle";
  planSha256: string;
  standingPolicySha256: string;
  requestedAt: string;
  observedAt: string;
  httpStatus: 200;
  providerCalls: 1;
  retryCount: 0;
  actualCreditsUsed: 2.5;
  balanceUnits: number;
  reserveFloor: number;
  rawResponseBytes: number;
  rawResponseSha256: string;
  resultCount: number;
  meteredApprovalId: string;
  meteredReservationKey: string;
  meteredReceiptId: string;
  success: true;
  budgetViolation: false;
  terminalDisposition: "BALANCE_CONFIRMED";
  safety: {
    canonicalWrites: 0;
    marketplaceWrites: 0;
    priceOrInventoryWrites: 0;
    delisting: 0;
    consumerActivation: 0;
    procurementActions: 0;
  };
}

export interface ProductTruthStandingAuthorizationArtifact {
  schemaVersion: typeof PRODUCT_TRUTH_STANDING_AUTHORIZATION_VERSION;
  policyId: string;
  standingPolicySha256: string;
  planSha256: string;
  balanceEvidenceSha256: string;
  approvalSha256: string;
  approvalId: string;
  executionConfirmation: string;
  issuedAt: string;
  expiresAt: string;
  approval: ProductTruthOperationalApproval;
}

export interface ProductTruthStandingBalanceProbePermit {
  permit: MeteredRunPermit;
  encodedPermit: string;
  confirmation: string;
}

export class ProductTruthStandingProviderAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthStandingProviderAuthorityError";
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthStandingProviderAuthorityError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      "STANDING_AUTHORITY_ARTIFACT_INVALID",
      `${label} keys must be exactly: ${wanted.join(", ")}`,
    );
  }
}

function exactText(
  value: unknown,
  label: string,
  maximum = 500,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
  ) {
    fail("STANDING_AUTHORITY_ARTIFACT_INVALID", `${label} must be exact text`);
  }
  return value;
}

function exactJsonBytes(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.trim().length < 1
    || value.length > maximum
    || value.includes("\0")
  ) {
    fail(
      "STANDING_AUTHORITY_ARTIFACT_INVALID",
      `${label} must be bounded exact JSON bytes`,
    );
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const text = exactText(value, label, 160);
  if (!SAFE_ID_PATTERN.test(text)) {
    fail("STANDING_AUTHORITY_ARTIFACT_INVALID", `${label} contains unsafe characters`);
  }
  return text;
}

function exactSha(value: unknown, label: string): string {
  const text = exactText(value, label, 64).toLowerCase();
  if (!SHA256_PATTERN.test(text)) {
    fail("STANDING_AUTHORITY_ARTIFACT_INVALID", `${label} must be a SHA-256`);
  }
  return text;
}

function exactInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 80);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail(
      "STANDING_AUTHORITY_ARTIFACT_INVALID",
      `${label} must be canonical ISO-8601 UTC`,
    );
  }
  return text;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(
      "STANDING_AUTHORITY_ARTIFACT_INVALID",
      `${label} must be finite and non-negative`,
    );
  }
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    fail(
      "STANDING_AUTHORITY_ARTIFACT_INVALID",
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
  return Number(value);
}

function exactBoolean(value: unknown, expected: boolean, label: string): void {
  if (value !== expected) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      `${label} must remain ${String(expected)}`,
    );
  }
}

function sha256Text(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCanonicalJson(
  value: unknown,
  json: string,
  label: string,
): void {
  if (json !== renderProductTruthOperationalJson(value)) {
    fail(
      "STANDING_AUTHORITY_ARTIFACT_NOT_CANONICAL",
      `${label} must use canonical Product Truth JSON bytes`,
    );
  }
}

function parseProviderRule(
  value: unknown,
  label: string,
): ProductTruthStandingProviderRule {
  if (!isRecord(value)) {
    fail("STANDING_AUTHORITY_POLICY_INVALID", `${label} must be an object`);
  }
  exactKeys(value, [
    "provider",
    "operations",
    "maximumUnitsPerCall",
  ], label);
  if (value.provider !== "oxylabs" && value.provider !== "unwrangle") {
    fail("STANDING_AUTHORITY_POLICY_INVALID", `${label}.provider is unsupported`);
  }
  if (
    !Array.isArray(value.operations)
    || value.operations.length < 1
    || !value.operations.every((operation) => (
      typeof operation === "string"
      && operation.length > 0
      && operation === operation.trim()
    ))
  ) {
    fail("STANDING_AUTHORITY_POLICY_INVALID", `${label}.operations are invalid`);
  }
  const operations = [...new Set(value.operations)].sort();
  if (
    JSON.stringify(operations) !== JSON.stringify(value.operations)
    || (value.provider === "oxylabs" && JSON.stringify(operations) !== '["query"]')
    || (value.provider === "unwrangle" && JSON.stringify(operations) !== '["detail"]')
  ) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      `${label}.operations differ from the approved provider lane`,
    );
  }
  const maximumUnitsPerCall = finiteNonNegative(
    value.maximumUnitsPerCall,
    `${label}.maximumUnitsPerCall`,
  );
  if (
    (value.provider === "oxylabs" && maximumUnitsPerCall !== 1)
    || (value.provider === "unwrangle" && maximumUnitsPerCall !== 2.5)
  ) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      `${label}.maximumUnitsPerCall differs from the pinned tariff`,
    );
  }
  return {
    provider: value.provider,
    operations,
    maximumUnitsPerCall,
  };
}

export function parseProductTruthStandingProviderPolicy(
  value: unknown,
): ProductTruthStandingProviderPolicy {
  if (!isRecord(value)) {
    fail("STANDING_AUTHORITY_POLICY_INVALID", "standing policy must be an object");
  }
  exactKeys(value, [
    "schemaVersion",
    "policyId",
    "approvedBy",
    "ownerStatement",
    "issuedAt",
    "expiresAt",
    "databaseTargetFingerprint",
    "manifestSha256",
    "allowedPlanSchemaVersions",
    "maximumApprovalLifetimeMs",
    "maximumBalanceEvidenceAgeMs",
    "maximumListingsPerPlan",
    "maximumProviderUnitsPerPlan",
    "unwrangleReserveFloorMinimum",
    "balanceProbe",
    "providerRules",
    "allowAutomaticProviderEnrichment",
    "allowCanonicalProductTruthWrites",
    "allowMarketplaceListingWrites",
    "allowPriceChanges",
    "allowInventoryChanges",
    "allowDelisting",
    "allowConsumerActivation",
    "allowProcurement",
    "allowHarvestCronActivation",
    "allowClubs",
    "allowBjs",
    "requiresAuthoritativePhase1Scope",
    "requiresExactFirstPartyEvidence",
    "requiresFreshBalanceEvidence",
    "requiresNoAutomaticReplay",
    "requiresNoRetry",
    "requiresSingleConcurrency",
    "revocationRequiresOwnerDecision",
  ], "standing policy");
  if (
    value.schemaVersion !== PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_VERSION
    || value.approvedBy !== "owner"
    || value.expiresAt !== null
  ) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      `standing policy must use ${PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_VERSION}`,
    );
  }

  const policyId = safeId(value.policyId, "standing policy.policyId");
  const ownerStatement = exactText(
    value.ownerStatement,
    "standing policy.ownerStatement",
    1_000,
  );
  const issuedAt = exactInstant(value.issuedAt, "standing policy.issuedAt");
  const databaseTargetFingerprint = exactSha(
    value.databaseTargetFingerprint,
    "standing policy.databaseTargetFingerprint",
  );
  const manifestSha256 = exactSha(
    value.manifestSha256,
    "standing policy.manifestSha256",
  );
  const expectedSchemas = [
    PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
    PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
  ];
  if (
    !Array.isArray(value.allowedPlanSchemaVersions)
    || JSON.stringify(value.allowedPlanSchemaVersions) !== JSON.stringify(expectedSchemas)
  ) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      "standing policy allowed plan schemas are not pinned",
    );
  }
  const maximumApprovalLifetimeMs = positiveInteger(
    value.maximumApprovalLifetimeMs,
    "standing policy.maximumApprovalLifetimeMs",
    10 * 60 * 1_000,
  );
  const maximumBalanceEvidenceAgeMs = positiveInteger(
    value.maximumBalanceEvidenceAgeMs,
    "standing policy.maximumBalanceEvidenceAgeMs",
    10 * 60 * 1_000,
  );
  const maximumListingsPerPlan = positiveInteger(
    value.maximumListingsPerPlan,
    "standing policy.maximumListingsPerPlan",
    100,
  );
  const maximumProviderUnitsPerPlan = finiteNonNegative(
    value.maximumProviderUnitsPerPlan,
    "standing policy.maximumProviderUnitsPerPlan",
  );
  if (maximumProviderUnitsPerPlan < 1 || maximumProviderUnitsPerPlan > 100) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      "standing policy provider ceiling must remain between 1 and 100",
    );
  }
  const unwrangleReserveFloorMinimum = finiteNonNegative(
    value.unwrangleReserveFloorMinimum,
    "standing policy.unwrangleReserveFloorMinimum",
  );
  if (unwrangleReserveFloorMinimum !== 15_000) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      "standing policy Unwrangle floor must remain 15000",
    );
  }
  if (!isRecord(value.balanceProbe)) {
    fail("STANDING_AUTHORITY_POLICY_INVALID", "standing policy balanceProbe is invalid");
  }
  exactKeys(value.balanceProbe, [
    "provider",
    "operation",
    "query",
    "maxCallsPerPlan",
    "maxUnitsPerCall",
  ], "standing policy.balanceProbe");
  if (
    value.balanceProbe.provider !== "unwrangle"
    || value.balanceProbe.operation !== "target_search"
    || value.balanceProbe.query !== "water"
    || value.balanceProbe.maxCallsPerPlan !== 1
    || value.balanceProbe.maxUnitsPerCall !== 2.5
  ) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      "standing policy balance probe differs from the one-call pinned lane",
    );
  }
  if (!Array.isArray(value.providerRules) || value.providerRules.length !== 2) {
    fail("STANDING_AUTHORITY_POLICY_INVALID", "standing policy requires two provider rules");
  }
  const providerRules = value.providerRules.map((rule, index) =>
    parseProviderRule(rule, `standing policy.providerRules[${index}]`));
  if (
    providerRules[0]?.provider !== "oxylabs"
    || providerRules[1]?.provider !== "unwrangle"
  ) {
    fail(
      "STANDING_AUTHORITY_POLICY_INVALID",
      "standing policy provider rules must remain oxylabs then unwrangle",
    );
  }

  const expectedBooleans = {
    allowAutomaticProviderEnrichment: true,
    allowCanonicalProductTruthWrites: true,
    allowMarketplaceListingWrites: false,
    allowPriceChanges: false,
    allowInventoryChanges: false,
    allowDelisting: false,
    allowConsumerActivation: false,
    allowProcurement: false,
    allowHarvestCronActivation: false,
    allowClubs: false,
    allowBjs: false,
    requiresAuthoritativePhase1Scope: true,
    requiresExactFirstPartyEvidence: true,
    requiresFreshBalanceEvidence: true,
    requiresNoAutomaticReplay: true,
    requiresNoRetry: true,
    requiresSingleConcurrency: true,
    revocationRequiresOwnerDecision: true,
  } as const;
  for (const [key, expected] of Object.entries(expectedBooleans)) {
    exactBoolean(value[key], expected, `standing policy.${key}`);
  }

  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_VERSION,
    policyId,
    approvedBy: "owner",
    ownerStatement,
    issuedAt,
    expiresAt: null,
    databaseTargetFingerprint,
    manifestSha256,
    allowedPlanSchemaVersions: [
      PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
      PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
    ],
    maximumApprovalLifetimeMs,
    maximumBalanceEvidenceAgeMs,
    maximumListingsPerPlan,
    maximumProviderUnitsPerPlan,
    unwrangleReserveFloorMinimum,
    balanceProbe: {
      provider: "unwrangle",
      operation: "target_search",
      query: "water",
      maxCallsPerPlan: 1,
      maxUnitsPerCall: 2.5,
    },
    providerRules,
    ...expectedBooleans,
  };
}

export function validateProductTruthStandingProviderPolicy(input: {
  policy: unknown;
  policyJson: string;
  policySha256: string;
}): ProductTruthStandingProviderPolicy {
  const expectedSha256 = exactSha(
    input.policySha256,
    "standing policy expected SHA-256",
  );
  if (expectedSha256 !== PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256) {
    fail(
      "STANDING_AUTHORITY_POLICY_SHA_MISMATCH",
      "standing policy SHA differs from the pinned owner policy",
    );
  }
  if (sha256Text(input.policyJson) !== expectedSha256) {
    fail(
      "STANDING_AUTHORITY_POLICY_SHA_MISMATCH",
      "standing policy bytes differ from the supplied SHA-256",
    );
  }
  const policy = parseProductTruthStandingProviderPolicy(input.policy);
  assertCanonicalJson(policy, input.policyJson, "standing policy");
  return policy;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("STANDING_AUTHORITY_PLAN_INELIGIBLE", `${label} must be an object`);
  }
  return value;
}

function planManifestSha256(
  plan: SupportedPlan,
): string {
  if (plan.schemaVersion === PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION) {
    return exactSha(plan.manifest.sha256, "plan.manifest.sha256");
  }
  const manifestShas = new Set<string>();
  for (const [index, target] of plan.targets.entries()) {
    const targetRecord = asRecord(target, `plan.targets[${index}]`);
    const binding = asRecord(
      targetRecord.listingBinding,
      `plan.targets[${index}].listingBinding`,
    );
    const rowJson = exactJsonBytes(
      binding.listingScopeRowJson,
      `plan.targets[${index}].listingBinding.listingScopeRowJson`,
      100_000,
    );
    let row: unknown;
    try {
      row = JSON.parse(rowJson) as unknown;
    } catch {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `plan.targets[${index}] listing scope row is invalid JSON`,
      );
    }
    const rowRecord = asRecord(row, `plan.targets[${index}] listing scope row`);
    manifestShas.add(exactSha(
      rowRecord.manifestSha256,
      `plan.targets[${index}] listing scope manifest SHA`,
    ));
  }
  if (manifestShas.size !== 1) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "targeted plan does not bind one authoritative Phase 1 manifest",
    );
  }
  return [...manifestShas][0]!;
}

function planProviderUnits(plan: SupportedPlan): number {
  return plan.providerCeilings.reduce((sum, ceiling) => {
    if (ceiling.maxUnits === null) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `${ceiling.provider} must have a finite unit ceiling`,
      );
    }
    return sum + ceiling.maxUnits;
  }, 0);
}

function assertPlanClaims(plan: SupportedPlan): void {
  const claims = asRecord(plan.claims, "plan.claims");
  for (const key of [
    "automaticPublish",
    "automaticDelist",
    "automaticReprice",
    "automaticPurchase",
  ]) {
    if (claims[key] !== false) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `plan claim ${key} must remain false`,
      );
    }
  }
  if (
    "automaticReplay" in claims
    && claims.automaticReplay !== false
  ) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan automatic replay must remain false",
    );
  }
  for (const key of ["clubCalls", "bjsCalls", "openFoodFactsCalls"]) {
    if (key in claims && claims[key] !== false) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `plan claim ${key} must remain false`,
      );
    }
  }
  for (const key of ["unrelatedOfferWrites", "unrelatedProductWrites"]) {
    if (key in claims && claims[key] !== false) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `plan claim ${key} must remain false`,
      );
    }
  }
}

export function assertProductTruthPlanEligibleForStandingAuthority(input: {
  plan: SupportedPlan;
  planSha256: string;
  policy: ProductTruthStandingProviderPolicy;
  now: string;
}): void {
  const planSha256 = exactSha(input.planSha256, "plan SHA-256");
  if (productTruthOperationalSha256(input.plan) !== planSha256) {
    fail(
      "STANDING_AUTHORITY_PLAN_HASH_MISMATCH",
      "plan SHA differs from canonical plan contents",
    );
  }
  const now = exactInstant(input.now, "authorization clock");
  if (
    Date.parse(now) < Date.parse(input.plan.createdAt)
    || Date.parse(now) >= Date.parse(input.plan.expiresAt)
  ) {
    fail("STANDING_AUTHORITY_PLAN_NOT_CURRENT", "sealed plan is not current");
  }
  if (
    !input.policy.allowedPlanSchemaVersions.includes(input.plan.schemaVersion)
  ) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan schema is not allowed by standing policy",
    );
  }
  if (input.plan.targetFingerprint !== input.policy.databaseTargetFingerprint) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan database target differs from standing policy",
    );
  }
  if (planManifestSha256(input.plan) !== input.policy.manifestSha256) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan Phase 1 manifest differs from standing policy",
    );
  }
  if (
    input.plan.targets.length < 1
    || input.plan.targets.length > input.policy.maximumListingsPerPlan
  ) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan target count exceeds standing policy",
    );
  }
  const sourcePolicy = input.plan.sourcePolicy;
  if (
    sourcePolicy.procurementZip !== "33765"
    || sourcePolicy.allowClubs !== false
    || sourcePolicy.allowBjs !== false
    || sourcePolicy.listingConcurrency !== 1
    || sourcePolicy.componentConcurrency !== 1
    || sourcePolicy.maxAttemptsPerListing !== 1
    || sourcePolicy.retailers.some((retailer) => (
      retailer === "samsclub" || retailer === "costco"
    ))
  ) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan source policy violates standing authority",
    );
  }
  const rules = new Map(
    input.policy.providerRules.map((rule) => [rule.provider, rule]),
  );
  for (const ceiling of input.plan.providerCeilings) {
    const rule = rules.get(ceiling.provider as "oxylabs" | "unwrangle");
    if (!rule || ceiling.maxUnits === null) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `${ceiling.provider} is not allowed by standing authority`,
      );
    }
    if (
      ceiling.operations.length < 1
      || ceiling.operations.some((operation) => !rule.operations.includes(operation))
      || ceiling.maxCalls < 1
      || ceiling.maxUnits > ceiling.maxCalls * rule.maximumUnitsPerCall
    ) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `${ceiling.provider} ceiling exceeds the standing provider rule`,
      );
    }
    if (
      ceiling.provider === "unwrangle"
      && (ceiling.reserveFloor ?? -1) < input.policy.unwrangleReserveFloorMinimum
    ) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        "Unwrangle reserve floor is below standing policy",
      );
    }
    if (ceiling.provider !== "unwrangle" && ceiling.reserveFloor !== null) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `${ceiling.provider} must not claim an unsupported reserve floor`,
      );
    }
  }
  if (
    new Set(input.plan.providerCeilings.map((ceiling) => ceiling.provider)).size
      !== input.plan.providerCeilings.length
    || input.plan.providerCeilings.length !== input.policy.providerRules.length
    || planProviderUnits(input.plan) > input.policy.maximumProviderUnitsPerPlan
  ) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan provider set or total units exceeds standing policy",
    );
  }
  assertPlanClaims(input.plan);
  if (input.plan.schemaVersion === PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION) {
    const claims = asRecord(input.plan.claims, "targeted plan.claims");
    if (
      claims.exactOneExistingDonor !== true
      || claims.exactOneExistingDirectFirstPartyWalmartOffer !== true
      || claims.initialDetailHarvestStateAbsent !== true
    ) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        "targeted plan lacks exact first-party evidence claims",
      );
    }
  }
}

export function buildProductTruthStandingBalanceProbePermit(input: {
  plan: SupportedPlan;
  planSha256: string;
  policy: ProductTruthStandingProviderPolicy;
  policySha256: string;
  now: string;
}): ProductTruthStandingBalanceProbePermit {
  const now = exactInstant(input.now, "balance permit clock");
  assertProductTruthPlanEligibleForStandingAuthority({
    plan: input.plan,
    planSha256: input.planSha256,
    policy: input.policy,
    now,
  });
  const planSha256 = exactSha(input.planSha256, "plan SHA-256");
  const policySha256 = exactSha(input.policySha256, "standing policy SHA-256");
  if (policySha256 !== PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256) {
    fail(
      "STANDING_AUTHORITY_POLICY_SHA_MISMATCH",
      "balance permit policy differs from the pinned standing policy",
    );
  }
  const runId = `${input.plan.runId}:balance`;
  const approvalId = `pt-standing-balance:${planSha256.slice(0, 24)}`;
  const expiresAt = new Date(Math.min(
    Date.parse(input.plan.expiresAt),
    Date.parse(now) + input.policy.maximumApprovalLifetimeMs,
  )).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(now)) {
    fail("STANDING_AUTHORITY_PLAN_NOT_CURRENT", "plan expires before balance permit");
  }
  const permit: MeteredRunPermit = {
    version: 1,
    runId,
    approvalId,
    approvedBy: "owner",
    issuedAt: now,
    expiresAt,
    providers: {
      unwrangle: {
        operations: [input.policy.balanceProbe.operation],
        maxCalls: input.policy.balanceProbe.maxCallsPerPlan,
        maxUnits: input.policy.balanceProbe.maxUnitsPerCall,
      },
    },
  };
  return {
    permit,
    encodedPermit: encodeMeteredRunPermit(permit),
    confirmation: expectedMeteredRunConfirmation(permit),
  };
}

function parseUnwrangleRemainingCredits(rawResponse: unknown): number {
  const response = asRecord(rawResponse, "Unwrangle response");
  const direct = response.remaining_credits;
  const nested = isRecord(response.request_info)
    ? response.request_info.credits_remaining
    : undefined;
  const value = direct ?? nested;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(
      "STANDING_AUTHORITY_BALANCE_RESPONSE_INVALID",
      "Unwrangle response has no finite remaining credit balance",
    );
  }
  if (response.success === false) {
    fail(
      "STANDING_AUTHORITY_BALANCE_RESPONSE_INVALID",
      "Unwrangle balance probe reported failure",
    );
  }
  return parsed;
}

function unwrangleResultCount(rawResponse: unknown): number {
  const response = asRecord(rawResponse, "Unwrangle response");
  const candidates = Array.isArray(response.results)
    ? response.results
    : Array.isArray(response.products)
      ? response.products
      : [];
  return candidates.length;
}

export function buildProductTruthStandingBalanceProbeArtifact(input: {
  plan: SupportedPlan;
  planSha256: string;
  policy: ProductTruthStandingProviderPolicy;
  policySha256: string;
  probeId: string;
  requestedAt: string;
  observedAt: string;
  httpStatus: number;
  rawResponseText: string;
  meteredAuthorization: {
    approvalId: string;
    reservationKey: string;
    receiptId: string;
  };
}): ProductTruthStandingBalanceProbeArtifact {
  const planSha256 = exactSha(input.planSha256, "plan SHA-256");
  const policySha256 = exactSha(input.policySha256, "standing policy SHA-256");
  if (policySha256 !== PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256) {
    fail(
      "STANDING_AUTHORITY_POLICY_SHA_MISMATCH",
      "balance probe policy differs from the pinned standing policy",
    );
  }
  const requestedAt = exactInstant(input.requestedAt, "balance probe requestedAt");
  const observedAt = exactInstant(input.observedAt, "balance probe observedAt");
  if (Date.parse(observedAt) < Date.parse(requestedAt)) {
    fail(
      "STANDING_AUTHORITY_BALANCE_RESPONSE_INVALID",
      "balance probe observation predates request",
    );
  }
  if (input.httpStatus !== 200) {
    fail(
      "STANDING_AUTHORITY_BALANCE_RESPONSE_INVALID",
      `balance probe returned HTTP ${input.httpStatus}`,
    );
  }
  const rawResponseBytes = Buffer.byteLength(input.rawResponseText, "utf8");
  if (rawResponseBytes < 2 || rawResponseBytes > 5 * 1024 * 1024) {
    fail(
      "STANDING_AUTHORITY_BALANCE_RESPONSE_INVALID",
      "balance response size is outside the 2-5242880 byte boundary",
    );
  }
  let rawResponse: unknown;
  try {
    rawResponse = JSON.parse(input.rawResponseText) as unknown;
  } catch {
    fail(
      "STANDING_AUTHORITY_BALANCE_RESPONSE_INVALID",
      "Unwrangle balance response is not valid JSON",
    );
  }
  const balanceUnits = parseUnwrangleRemainingCredits(rawResponse);
  const unwrangle = input.plan.providerCeilings.find(
    (ceiling) => ceiling.provider === "unwrangle",
  );
  if (!unwrangle || unwrangle.maxUnits === null || unwrangle.reserveFloor === null) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan has no bounded Unwrangle allowance",
    );
  }
  if (balanceUnits - unwrangle.maxUnits < unwrangle.reserveFloor) {
    fail(
      "STANDING_AUTHORITY_RESERVE_FLOOR_EXCEEDED",
      "working plan would cross the Unwrangle reserve floor",
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_UNWRANGLE_BALANCE_EVIDENCE_VERSION,
    probeId: safeId(input.probeId, "balance probe ID"),
    provider: "unwrangle",
    planSha256,
    standingPolicySha256: policySha256,
    requestedAt,
    observedAt,
    httpStatus: 200,
    providerCalls: 1,
    retryCount: 0,
    actualCreditsUsed: 2.5,
    balanceUnits,
    reserveFloor: unwrangle.reserveFloor,
    rawResponseBytes,
    rawResponseSha256: sha256Text(input.rawResponseText),
    resultCount: unwrangleResultCount(rawResponse),
    meteredApprovalId: safeId(
      input.meteredAuthorization.approvalId,
      "balance probe metered approval ID",
    ),
    meteredReservationKey: safeId(
      input.meteredAuthorization.reservationKey,
      "balance probe metered reservation key",
    ),
    meteredReceiptId: safeId(
      input.meteredAuthorization.receiptId,
      "balance probe metered receipt ID",
    ),
    success: true,
    budgetViolation: false,
    terminalDisposition: "BALANCE_CONFIRMED",
    safety: {
      canonicalWrites: 0,
      marketplaceWrites: 0,
      priceOrInventoryWrites: 0,
      delisting: 0,
      consumerActivation: 0,
      procurementActions: 0,
    },
  };
}

export function parseProductTruthStandingBalanceProbeArtifact(input: {
  value: unknown;
  json: string;
  expectedSha256: string;
  rawResponseText: string;
  plan: SupportedPlan;
  planSha256: string;
  policy: ProductTruthStandingProviderPolicy;
  policySha256: string;
  now: string;
}): ProductTruthStandingBalanceProbeArtifact {
  const expectedSha256 = exactSha(
    input.expectedSha256,
    "balance evidence expected SHA-256",
  );
  if (sha256Text(input.json) !== expectedSha256) {
    fail(
      "STANDING_AUTHORITY_BALANCE_EVIDENCE_SHA_MISMATCH",
      "balance evidence bytes differ from supplied SHA-256",
    );
  }
  if (!isRecord(input.value)) {
    fail(
      "STANDING_AUTHORITY_BALANCE_EVIDENCE_INVALID",
      "balance evidence must be an object",
    );
  }
  exactKeys(input.value, [
    "schemaVersion",
    "probeId",
    "provider",
    "planSha256",
    "standingPolicySha256",
    "requestedAt",
    "observedAt",
    "httpStatus",
    "providerCalls",
    "retryCount",
    "actualCreditsUsed",
    "balanceUnits",
    "reserveFloor",
    "rawResponseBytes",
    "rawResponseSha256",
    "resultCount",
    "meteredApprovalId",
    "meteredReservationKey",
    "meteredReceiptId",
    "success",
    "budgetViolation",
    "terminalDisposition",
    "safety",
  ], "balance evidence");
  if (!isRecord(input.value.safety)) {
    fail(
      "STANDING_AUTHORITY_BALANCE_EVIDENCE_INVALID",
      "balance evidence safety must be an object",
    );
  }
  exactKeys(input.value.safety, [
    "canonicalWrites",
    "marketplaceWrites",
    "priceOrInventoryWrites",
    "delisting",
    "consumerActivation",
    "procurementActions",
  ], "balance evidence.safety");
  const rebuilt = buildProductTruthStandingBalanceProbeArtifact({
    plan: input.plan,
    planSha256: input.planSha256,
    policy: input.policy,
    policySha256: input.policySha256,
    probeId: safeId(input.value.probeId, "balance evidence.probeId"),
    requestedAt: exactInstant(
      input.value.requestedAt,
      "balance evidence.requestedAt",
    ),
    observedAt: exactInstant(
      input.value.observedAt,
      "balance evidence.observedAt",
    ),
    httpStatus: input.value.httpStatus as number,
    rawResponseText: input.rawResponseText,
    meteredAuthorization: {
      approvalId: safeId(
        input.value.meteredApprovalId,
        "balance evidence.meteredApprovalId",
      ),
      reservationKey: safeId(
        input.value.meteredReservationKey,
        "balance evidence.meteredReservationKey",
      ),
      receiptId: safeId(
        input.value.meteredReceiptId,
        "balance evidence.meteredReceiptId",
      ),
    },
  });
  if (
    input.value.schemaVersion !== PRODUCT_TRUTH_UNWRANGLE_BALANCE_EVIDENCE_VERSION
    || input.value.provider !== "unwrangle"
    || input.value.planSha256 !== rebuilt.planSha256
    || input.value.standingPolicySha256 !== rebuilt.standingPolicySha256
    || input.value.providerCalls !== 1
    || input.value.retryCount !== 0
    || input.value.actualCreditsUsed !== 2.5
    || input.value.success !== true
    || input.value.budgetViolation !== false
    || input.value.terminalDisposition !== "BALANCE_CONFIRMED"
    || Object.values(input.value.safety).some((value) => value !== 0)
    || renderProductTruthOperationalJson(rebuilt)
      !== renderProductTruthOperationalJson(input.value)
  ) {
    fail(
      "STANDING_AUTHORITY_BALANCE_EVIDENCE_INVALID",
      "balance evidence differs from raw response or standing policy",
    );
  }
  assertCanonicalJson(rebuilt, input.json, "balance evidence");
  const now = exactInstant(input.now, "authorization clock");
  if (
    Date.parse(rebuilt.observedAt) > Date.parse(now)
    || Date.parse(now) - Date.parse(rebuilt.observedAt)
      > input.policy.maximumBalanceEvidenceAgeMs
  ) {
    fail(
      "STANDING_AUTHORITY_BALANCE_EVIDENCE_STALE",
      "balance evidence is outside the standing-policy freshness window",
    );
  }
  return rebuilt;
}

function permitProviders(plan: SupportedPlan): MeteredRunPermit["providers"] {
  const providers: Partial<Record<MeteredProvider, {
    operations: string[];
    maxCalls: number;
    maxUnits?: number;
  }>> = {};
  for (const ceiling of plan.providerCeilings) {
    if (ceiling.maxUnits === null) {
      fail(
        "STANDING_AUTHORITY_PLAN_INELIGIBLE",
        `${ceiling.provider} has no finite unit ceiling`,
      );
    }
    providers[ceiling.provider] = {
      operations: [...ceiling.operations],
      maxCalls: ceiling.maxCalls,
      maxUnits: ceiling.maxUnits,
    };
  }
  return providers;
}

export function buildProductTruthStandingAuthorization(input: {
  plan: SupportedPlan;
  planSha256: string;
  policy: ProductTruthStandingProviderPolicy;
  policySha256: string;
  balanceEvidence: ProductTruthStandingBalanceProbeArtifact;
  balanceEvidenceSha256: string;
  now: string;
}): ProductTruthStandingAuthorizationArtifact {
  const now = exactInstant(input.now, "authorization clock");
  assertProductTruthPlanEligibleForStandingAuthority({
    plan: input.plan,
    planSha256: input.planSha256,
    policy: input.policy,
    now,
  });
  const planSha256 = exactSha(input.planSha256, "plan SHA-256");
  const policySha256 = exactSha(input.policySha256, "standing policy SHA-256");
  if (policySha256 !== PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256) {
    fail(
      "STANDING_AUTHORITY_POLICY_SHA_MISMATCH",
      "authorization policy differs from pinned standing policy",
    );
  }
  const balanceEvidenceSha256 = exactSha(
    input.balanceEvidenceSha256,
    "balance evidence SHA-256",
  );
  if (
    input.balanceEvidence.planSha256 !== planSha256
    || input.balanceEvidence.standingPolicySha256 !== policySha256
    || Date.parse(input.balanceEvidence.observedAt) > Date.parse(now)
    || Date.parse(now) - Date.parse(input.balanceEvidence.observedAt)
      > input.policy.maximumBalanceEvidenceAgeMs
  ) {
    fail(
      "STANDING_AUTHORITY_BALANCE_EVIDENCE_INVALID",
      "balance evidence is stale or belongs to another plan/policy",
    );
  }
  const approvalId =
    `pt-standing:${planSha256.slice(0, 20)}:${balanceEvidenceSha256.slice(0, 16)}`;
  const expiresAt = new Date(Math.min(
    Date.parse(input.plan.expiresAt),
    Date.parse(now) + input.policy.maximumApprovalLifetimeMs,
  )).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(now)) {
    fail("STANDING_AUTHORITY_PLAN_NOT_CURRENT", "plan expires before authorization");
  }
  const meteredPermit: MeteredRunPermit = {
    version: 1,
    runId: input.plan.runId,
    approvalId,
    approvedBy: "owner",
    issuedAt: now,
    expiresAt,
    providers: permitProviders(input.plan),
  };
  const unwrangle = input.plan.providerCeilings.find(
    (ceiling) => ceiling.provider === "unwrangle",
  );
  if (!unwrangle || unwrangle.reserveFloor === null) {
    fail(
      "STANDING_AUTHORITY_PLAN_INELIGIBLE",
      "plan lacks an Unwrangle reserve floor",
    );
  }
  const approval: ProductTruthOperationalApproval = {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
    approvedBy: "owner",
    runId: input.plan.runId,
    approvalId,
    action: input.plan.mode === "CANARY" ? "EXECUTE_CANARY" : "EXECUTE_WAVE",
    planSha256,
    targetFingerprint: input.plan.targetFingerprint,
    issuedAt: now,
    expiresAt,
    meteredPermit,
    balanceEvidence: [{
      provider: "unwrangle",
      observedAt: input.balanceEvidence.observedAt,
      balanceUnits: input.balanceEvidence.balanceUnits,
      reserveFloor: unwrangle.reserveFloor,
      evidenceSha256: balanceEvidenceSha256,
    }],
  };
  const executionConfirmation = expectedProductTruthExecutionConfirmation(
    planSha256,
    approvalId,
  );
  if (
    input.plan.schemaVersion
      === PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION
  ) {
    validateProductTruthTargetedWalmartEvidenceApproval({
      plan: input.plan,
      planSha256,
      approval,
      executionConfirmation,
      now,
    });
  } else {
    validateProductTruthOperationalApproval({
      plan: input.plan,
      planSha256,
      approval,
      executionConfirmation,
      now,
    });
  }
  const approvalSha256 = productTruthOperationalSha256(approval);
  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_AUTHORIZATION_VERSION,
    policyId: input.policy.policyId,
    standingPolicySha256: policySha256,
    planSha256,
    balanceEvidenceSha256,
    approvalSha256,
    approvalId,
    executionConfirmation,
    issuedAt: now,
    expiresAt,
    approval,
  };
}
