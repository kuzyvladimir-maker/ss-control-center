import { createHash } from "node:crypto";

import {
  CANONICAL_PRODUCT_VARIANT_IDENTITY_VERSION,
  CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
  type CanonicalProductVariantKey,
  type NormalizedCanonicalProductVariantIdentity,
} from "./canonical-product-variant";
import {
  PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION,
  renderProductTruthConsensusReuseScope,
  type ProductTruthConsensusReuseCandidate,
  type ProductTruthConsensusReuseScope,
} from "./product-truth-consensus-reuse-scope";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_CONSENSUS_REUSE_RESOLUTION_VERSION =
  "product-truth-consensus-reuse-resolution/1.0.0" as const;

type JsonRecord = Record<string, unknown>;

export interface ProductTruthConsensusReuseResolution {
  schemaVersion: typeof PRODUCT_TRUTH_CONSENSUS_REUSE_RESOLUTION_VERSION;
  reviewedAt: string;
  reviewedBy: "codex";
  baseScopeSha256: string;
  canonicalBindingSnapshotSha256: string;
  fieldPartitionResolutions: Array<{
    donorProductId: string;
    expectedGroupEvidenceSha256: string;
    expectedListingKeys: string[];
    expectedProposedCanonicalVariantIds: string[];
    chosenListingKey: string;
    chosenCanonicalVariantId: string;
    rationale:
      "SAME_PHYSICAL_DONOR_NORMALIZE_FIELD_PARTITION";
  }>;
  canonicalBindingResolutions: Array<{
    donorProductId: string;
    expectedListingKeys: string[];
    expectedProposedCanonicalVariantId: string;
    expectedBindingRowSha256: string;
    existingDecisionId: string;
    existingCanonicalVariantId: string;
    rationale:
      "REUSE_EXISTING_EXACT_CANONICAL_BINDING";
  }>;
  claims: {
    humanReviewedFieldPartition: true;
    samePhysicalDonorRequired: true;
    exactExistingBindingRequired: true;
    createsAdditionalCatalog: false;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    databaseWrites: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
  };
}

export class ProductTruthConsensusReuseResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthConsensusReuseResolutionError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthConsensusReuseResolutionError(code, message);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("CONSENSUS_REUSE_RESOLUTION_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function exactInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_INPUT_INVALID",
      `${label} must be canonical UTC`,
    );
  }
  return value;
}

function recordValue(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("CONSENSUS_REUSE_RESOLUTION_INPUT_INVALID", `${label} must be object`);
  }
  return value as JsonRecord;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_INPUT_INVALID",
      `${label} must be exact non-empty text`,
    );
  }
  return value;
}

function exactStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_INPUT_INVALID",
      `${label} must be a string array`,
    );
  }
  const result = value.map((item) => String(item));
  if (new Set(result).size !== result.length) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_INPUT_INVALID",
      `${label} contains duplicates`,
    );
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort())
    === JSON.stringify([...right].sort());
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) {
      fail("CONSENSUS_REUSE_RESOLUTION_DUPLICATE", `${label} ${key}`);
    }
    result.set(key, value);
  }
  return result;
}

function assertSourceBytes(input: {
  json: string;
  sha256: string;
  label: string;
}): void {
  const expected = exactSha(input.sha256, `${input.label}Sha256`);
  const actual = sha256Text(input.json);
  if (actual !== expected) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_SOURCE_HASH_MISMATCH",
      `${input.label} ${actual} != ${expected}`,
    );
  }
}

function canonicalVariantFromIdentityJson(input: {
  canonicalVariantId: string;
  identityJson: string;
}): ProductTruthConsensusReuseCandidate["proposedCanonicalVariant"] {
  const canonicalVariantId = exactString(
    input.canonicalVariantId,
    "canonicalVariantId",
  );
  if (!/^cpv1:[a-f0-9]{64}$/.test(canonicalVariantId)) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_INVALID",
      canonicalVariantId,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.identityJson);
  } catch {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_INVALID",
      "canonicalIdentityJson is invalid JSON",
    );
  }
  const identity = recordValue(parsed, "canonicalIdentityJson");
  if (
    JSON.stringify(identity) !== input.identityJson
    || identity.schemaVersion !== CANONICAL_PRODUCT_VARIANT_IDENTITY_VERSION
    || typeof identity.brand !== "string"
    || !identity.brand
    || !(
      identity.productLine === null
      || typeof identity.productLine === "string"
    )
    || !(identity.flavor === null || typeof identity.flavor === "string")
    || !(identity.form === null || typeof identity.form === "string")
    || !Array.isArray(identity.modifiers)
    || identity.modifiers.some((value) => typeof value !== "string")
    || !Number.isInteger(identity.outerPackCount)
    || Number(identity.outerPackCount) < 1
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_INVALID",
      "canonical identity fields are invalid",
    );
  }
  const size = recordValue(identity.size, "canonicalIdentityJson.size");
  if (
    !["MASS", "VOLUME", "COUNT"].includes(String(size.dimension))
    || !Number.isFinite(size.baseAmount)
    || Number(size.baseAmount) <= 0
    || !["g", "ml", "count"].includes(String(size.baseUnit))
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_INVALID",
      "canonical size is invalid",
    );
  }
  const identityHash = sha256Text(input.identityJson);
  if (canonicalVariantId !== `cpv1:${identityHash}`) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_INVALID",
      "canonical variant ID does not bind canonical identity bytes",
    );
  }
  const normalized =
    identity as unknown as NormalizedCanonicalProductVariantIdentity;
  const db: CanonicalProductVariantKey["db"] = {
    id: canonicalVariantId,
    variantKey: canonicalVariantId,
    identityHash,
    keyVersion: CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
    normalizedBrand: normalized.brand,
    normalizedProductLine: normalized.productLine,
    normalizedFlavor: normalized.flavor,
    normalizedModifiersJson: JSON.stringify(normalized.modifiers),
    normalizedForm: normalized.form,
    sizeDimension: normalized.size.dimension,
    sizeBaseAmount: normalized.size.baseAmount,
    sizeBaseUnit: normalized.size.baseUnit,
    outerPackCount: normalized.outerPackCount,
    identityJson: input.identityJson,
  };
  return db;
}

function bindingRows(snapshot: unknown): JsonRecord[] {
  const root = recordValue(snapshot, "canonicalBindingSnapshot");
  if (!Array.isArray(root.canonicalDonorBindings)) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_SNAPSHOT_INVALID",
      "canonicalDonorBindings must be an array",
    );
  }
  return root.canonicalDonorBindings.map((value, index) =>
    recordValue(value, `canonicalDonorBindings[${index}]`));
}

export function reconcileProductTruthConsensusReuseScope(input: {
  generatedAt: string;
  baseScope: ProductTruthConsensusReuseScope;
  baseScopeJson: string;
  baseScopeSha256: string;
  resolution: ProductTruthConsensusReuseResolution;
  resolutionJson: string;
  resolutionSha256: string;
  canonicalBindingSnapshot: unknown;
  canonicalBindingSnapshotJson: string;
  canonicalBindingSnapshotSha256: string;
}): ProductTruthConsensusReuseScope {
  const generatedAt = exactInstant(input.generatedAt, "generatedAt");
  assertSourceBytes({
    json: input.baseScopeJson,
    sha256: input.baseScopeSha256,
    label: "baseScope",
  });
  assertSourceBytes({
    json: input.resolutionJson,
    sha256: input.resolutionSha256,
    label: "resolution",
  });
  assertSourceBytes({
    json: input.canonicalBindingSnapshotJson,
    sha256: input.canonicalBindingSnapshotSha256,
    label: "canonicalBindingSnapshot",
  });
  if (
    input.baseScope.schemaVersion !== PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION
    || renderProductTruthConsensusReuseScope(input.baseScope)
      !== input.baseScopeJson
    || input.baseScope.source.consensusResolution !== undefined
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_BASE_SCOPE_INVALID",
      "base scope must be canonical and unresolved",
    );
  }
  if (
    input.resolution.schemaVersion
      !== PRODUCT_TRUTH_CONSENSUS_REUSE_RESOLUTION_VERSION
    || renderProductTruthConsensusReuseResolution(input.resolution)
      !== input.resolutionJson
    || input.resolution.reviewedBy !== "codex"
    || exactInstant(input.resolution.reviewedAt, "reviewedAt")
      > generatedAt
    || input.resolution.baseScopeSha256 !== input.baseScopeSha256
    || input.resolution.canonicalBindingSnapshotSha256
      !== input.canonicalBindingSnapshotSha256
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_REVIEW_INVALID",
      "resolution bytes or immutable bindings are invalid",
    );
  }
  const expectedClaims: ProductTruthConsensusReuseResolution["claims"] = {
    humanReviewedFieldPartition: true,
    samePhysicalDonorRequired: true,
    exactExistingBindingRequired: true,
    createsAdditionalCatalog: false,
    providerCalls: 0,
    paidCalls: 0,
    retailerFetches: 0,
    databaseWrites: 0,
    marketplaceMutations: 0,
    authorizesExecution: false,
  };
  if (
    renderProductTruthOperationalJson(input.resolution.claims)
      !== renderProductTruthOperationalJson(expectedClaims)
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_REVIEW_INVALID",
      "resolution safety claims changed",
    );
  }

  const fieldByDonor = uniqueBy(
    input.resolution.fieldPartitionResolutions,
    (value) => exactString(value.donorProductId, "donorProductId"),
    "field partition resolution",
  );
  const groupByDonor = uniqueBy(
    input.baseScope.reconciliationGroups,
    (value) => value.donorProductId,
    "base reconciliation group",
  );
  if (
    fieldByDonor.size !== groupByDonor.size
    || [...groupByDonor.keys()].some((key) => !fieldByDonor.has(key))
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_FIELD_PARTITION_INCOMPLETE",
      "every base field-partition group must be resolved exactly once",
    );
  }

  const resolved = structuredClone(input.baseScope);
  const resolvedGroups:
    NonNullable<ProductTruthConsensusReuseScope["resolvedReconciliationGroups"]> =
    [];
  for (const [donorProductId, group] of groupByDonor) {
    const resolution = fieldByDonor.get(donorProductId)!;
    if (
      resolution.rationale
        !== "SAME_PHYSICAL_DONOR_NORMALIZE_FIELD_PARTITION"
      || resolution.expectedGroupEvidenceSha256 !== group.evidenceSha256
      || !sameStrings(
        exactStringArray(
          resolution.expectedListingKeys,
          `${donorProductId}.expectedListingKeys`,
        ),
        group.listingKeys,
      )
      || !sameStrings(
        exactStringArray(
          resolution.expectedProposedCanonicalVariantIds,
          `${donorProductId}.expectedProposedCanonicalVariantIds`,
        ),
        group.proposedCanonicalVariantIds,
      )
    ) {
      fail(
        "CONSENSUS_REUSE_RESOLUTION_FIELD_PARTITION_DRIFT",
        donorProductId,
      );
    }
    const candidates = resolved.candidates.filter(
      (candidate) => candidate.donorProductId === donorProductId,
    );
    const chosen = candidates.find(
      (candidate) => candidate.listingKey === resolution.chosenListingKey,
    );
    if (
      candidates.length !== group.listingKeys.length
      || !chosen
      || chosen.lane !== "FIELD_PARTITION_RECONCILIATION_REQUIRED"
      || chosen.proposedCanonicalVariant.id
        !== resolution.chosenCanonicalVariantId
      || !group.proposedCanonicalVariantIds.includes(
        resolution.chosenCanonicalVariantId,
      )
    ) {
      fail(
        "CONSENSUS_REUSE_RESOLUTION_FIELD_PARTITION_CHOICE_INVALID",
        donorProductId,
      );
    }
    for (const candidate of candidates) {
      candidate.lane = "DIRECT_SINGLE_VARIANT";
      candidate.proposedCanonicalVariant =
        structuredClone(chosen.proposedCanonicalVariant);
    }
    resolvedGroups.push({
      donorProductId,
      listingKeys: [...group.listingKeys],
      resolutionKind: "FIELD_PARTITION_CHOSEN_VARIANT",
      canonicalVariantId: resolution.chosenCanonicalVariantId,
      evidenceSha256: productTruthOperationalSha256({
        baseGroupEvidenceSha256: group.evidenceSha256,
        resolution,
      }),
    });
  }

  const bindings = bindingRows(input.canonicalBindingSnapshot);
  const bindingResolutionByDonor = uniqueBy(
    input.resolution.canonicalBindingResolutions,
    (value) => exactString(value.donorProductId, "donorProductId"),
    "canonical binding resolution",
  );
  for (const [donorProductId, resolution] of bindingResolutionByDonor) {
    if (
      resolution.rationale !== "REUSE_EXISTING_EXACT_CANONICAL_BINDING"
    ) {
      fail(
        "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_INVALID",
        donorProductId,
      );
    }
    const candidates = resolved.candidates.filter(
      (candidate) => candidate.donorProductId === donorProductId,
    );
    const listingKeys = candidates.map((candidate) => candidate.listingKey);
    if (
      !candidates.length
      || candidates.some(
        (candidate) =>
          candidate.lane !== "DIRECT_SINGLE_VARIANT"
          || candidate.proposedCanonicalVariant.id
            !== resolution.expectedProposedCanonicalVariantId,
      )
      || !sameStrings(
        exactStringArray(
          resolution.expectedListingKeys,
          `${donorProductId}.expectedListingKeys`,
        ),
        listingKeys,
      )
    ) {
      fail(
        "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_SCOPE_DRIFT",
        donorProductId,
      );
    }
    const matches = bindings.filter(
      (row) => row.donorProductId === donorProductId,
    );
    if (matches.length !== 1) {
      fail(
        "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_INVALID",
        `${donorProductId} expected one exact binding`,
      );
    }
    const binding = matches[0]!;
    if (
      productTruthOperationalSha256(binding)
        !== resolution.expectedBindingRowSha256
      || binding.decisionStatus !== "exact_confirmed"
      || binding.decisionId !== resolution.existingDecisionId
      || binding.canonicalVariantId
        !== resolution.existingCanonicalVariantId
    ) {
      fail(
        "CONSENSUS_REUSE_RESOLUTION_CANONICAL_BINDING_DRIFT",
        donorProductId,
      );
    }
    const variant = canonicalVariantFromIdentityJson({
      canonicalVariantId: resolution.existingCanonicalVariantId,
      identityJson: exactString(
        binding.canonicalIdentityJson,
        `${donorProductId}.canonicalIdentityJson`,
      ),
    });
    for (const candidate of candidates) {
      candidate.proposedCanonicalVariant = structuredClone(variant);
    }
    resolvedGroups.push({
      donorProductId,
      listingKeys: [...listingKeys].sort(),
      resolutionKind: "EXISTING_CANONICAL_BINDING_REUSE",
      canonicalVariantId: resolution.existingCanonicalVariantId,
      evidenceSha256: productTruthOperationalSha256({
        bindingRowSha256: resolution.expectedBindingRowSha256,
        resolution,
      }),
    });
  }

  const byDonor = Map.groupBy(
    resolved.candidates,
    (candidate) => candidate.donorProductId,
  );
  if (
    resolved.candidates.some(
      (candidate) => candidate.lane !== "DIRECT_SINGLE_VARIANT",
    )
    || [...byDonor.entries()].some(([, candidates]) =>
      new Set(
        candidates.map((candidate) => candidate.proposedCanonicalVariant.id),
      ).size !== 1)
  ) {
    fail(
      "CONSENSUS_REUSE_RESOLUTION_ONE_DONOR_INVARIANT_FAILED",
      "resolved scope still contains an unresolved donor partition",
    );
  }

  resolved.generatedAt = generatedAt;
  resolved.source.consensusResolution = {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_RESOLUTION_VERSION,
    sha256: input.resolutionSha256,
    baseScopeSha256: input.baseScopeSha256,
    canonicalBindingSnapshotSha256:
      input.canonicalBindingSnapshotSha256,
  };
  resolved.selectionPolicy.donorCollisionPolicy =
    "ONE_DONOR_ONE_VARIANT_RESOLVED_BY_BOUND_REVIEW";
  resolved.counts.directSingleVariant = resolved.candidates.length;
  resolved.counts.fieldPartitionReconciliationRequired = 0;
  resolved.counts.directDonors = byDonor.size;
  resolved.counts.reconciliationDonors = 0;
  resolved.reconciliationGroups = [];
  resolved.resolvedReconciliationGroups = resolvedGroups.sort((left, right) =>
    left.donorProductId.localeCompare(right.donorProductId, "en-US"));
  resolved.claims.consensusResolutionBound = true;
  resolved.claims.existingCanonicalBindingOnlyReusedWhenExact = true;
  return resolved;
}

export function renderProductTruthConsensusReuseResolution(
  value: ProductTruthConsensusReuseResolution,
): string {
  return renderProductTruthOperationalJson(value);
}
