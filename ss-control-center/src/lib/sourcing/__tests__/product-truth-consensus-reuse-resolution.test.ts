import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_CONSENSUS_REUSE_RESOLUTION_VERSION,
  ProductTruthConsensusReuseResolutionError,
  reconcileProductTruthConsensusReuseScope,
  renderProductTruthConsensusReuseResolution,
  type ProductTruthConsensusReuseResolution,
} from "../product-truth-consensus-reuse-resolution";
import {
  buildProductTruthConsensusReuseWaves,
  type ProductTruthConsensusReuseDonorPreflightState,
} from "../product-truth-consensus-reuse-preflight";
import type {
  ProductTruthConsensusReuseCandidate,
} from "../product-truth-consensus-reuse-scope";
import {
  renderProductTruthOperationalJson,
} from "../product-truth-operational-run-contract";
import {
  makeConsensusReuseScopeFixture,
} from "./product-truth-consensus-reuse-fixture";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inputs() {
  const base = makeConsensusReuseScopeFixture();
  const canonicalBindingSnapshot = { canonicalDonorBindings: [] };
  const canonicalBindingSnapshotJson =
    renderProductTruthOperationalJson(canonicalBindingSnapshot);
  const canonicalBindingSnapshotSha256 =
    sha256(canonicalBindingSnapshotJson);
  const resolution: ProductTruthConsensusReuseResolution = {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_RESOLUTION_VERSION,
    reviewedAt: "2026-07-30T00:30:00.000Z",
    reviewedBy: "codex",
    baseScopeSha256: base.scopeSha256,
    canonicalBindingSnapshotSha256,
    fieldPartitionResolutions: [],
    canonicalBindingResolutions: [],
    claims: {
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
    },
  };
  const resolutionJson =
    renderProductTruthConsensusReuseResolution(resolution);
  return {
    generatedAt: "2026-07-30T00:31:00.000Z",
    baseScope: base.scope,
    baseScopeJson: base.scopeJson,
    baseScopeSha256: base.scopeSha256,
    resolution,
    resolutionJson,
    resolutionSha256: sha256(resolutionJson),
    canonicalBindingSnapshot,
    canonicalBindingSnapshotJson,
    canonicalBindingSnapshotSha256,
  };
}

test("seals a reproducible no-op resolution over a direct scope", () => {
  const result = reconcileProductTruthConsensusReuseScope(inputs());
  assert.equal(result.counts.selected, 1);
  assert.equal(result.counts.directSingleVariant, 1);
  assert.equal(result.counts.fieldPartitionReconciliationRequired, 0);
  assert.equal(result.counts.directDonors, 1);
  assert.equal(result.counts.reconciliationDonors, 0);
  assert.equal(result.reconciliationGroups.length, 0);
  assert.equal(result.resolvedReconciliationGroups?.length, 0);
  assert.ok(
    result.candidates.every(
      (candidate) => candidate.lane === "DIRECT_SINGLE_VARIANT",
    ),
  );
  for (
    const candidates of Map.groupBy(
      result.candidates,
      (candidate) => candidate.donorProductId,
    ).values()
  ) {
    assert.equal(
      new Set(
        candidates.map(
          (candidate) => candidate.proposedCanonicalVariant.id,
        ),
      ).size,
      1,
    );
  }
  assert.ok(result.source.consensusResolution);
});

test("fails closed when resolution bytes drift", () => {
  const input = inputs();
  input.resolutionJson = `${input.resolutionJson}\n`;
  assert.throws(
    () => reconcileProductTruthConsensusReuseScope(input),
    (error: unknown) => {
      assert.ok(error instanceof ProductTruthConsensusReuseResolutionError);
      assert.equal(
        error.code,
        "CONSENSUS_REUSE_RESOLUTION_SOURCE_HASH_MISMATCH",
      );
      return true;
    },
  );
});

test("fails closed on an unbound field-partition resolution", () => {
  const input = inputs();
  const candidate = input.baseScope.candidates[0]!;
  input.resolution.fieldPartitionResolutions.push({
    donorProductId: candidate.donorProductId,
    expectedGroupEvidenceSha256: "0".repeat(64),
    expectedListingKeys: [candidate.listingKey],
    expectedProposedCanonicalVariantIds: [
      candidate.proposedCanonicalVariant.id,
    ],
    chosenListingKey: candidate.listingKey,
    chosenCanonicalVariantId: candidate.proposedCanonicalVariant.id,
    rationale: "SAME_PHYSICAL_DONOR_NORMALIZE_FIELD_PARTITION",
  });
  input.resolutionJson =
    renderProductTruthConsensusReuseResolution(input.resolution);
  input.resolutionSha256 = sha256(input.resolutionJson);
  assert.throws(
    () => reconcileProductTruthConsensusReuseScope(input),
    (error: unknown) => {
      assert.ok(error instanceof ProductTruthConsensusReuseResolutionError);
      assert.equal(
        error.code,
        "CONSENSUS_REUSE_RESOLUTION_FIELD_PARTITION_INCOMPLETE",
      );
      return true;
    },
  );
});

test("row budget includes an exact existing canonical variant projection", () => {
  const donorProductId = "donor-existing";
  const listingKey = "walmart:1:existing-variant";
  const candidate = {
    donorProductId,
    listingKey,
  } as ProductTruthConsensusReuseCandidate;
  const donorState: ProductTruthConsensusReuseDonorPreflightState = {
    donorProductId,
    listingKeys: [listingKey],
    proposedCanonicalVariantId:
      "cpv1:0000000000000000000000000000000000000000000000000000000000000000",
    variantState: "REUSE",
    decisionState: "REUSE",
    existingDecision: {
      id: "decision-existing",
      decidedAt: "2026-07-29T12:09:50.985Z",
    },
    donorTransitionRequired: false,
    sourceIdentity: {
      identityKey: "existing",
      identityStatus: "exact_confirmed",
      brand: "brand",
      productLine: "line",
      flavor: null,
      containerType: null,
      size: "1 oz",
    },
    sourceIdentitySha256:
      "0000000000000000000000000000000000000000000000000000000000000000",
    blockers: [],
  };
  const waves = buildProductTruthConsensusReuseWaves({
    candidates: [candidate],
    donorStates: [donorState],
  });
  assert.equal(waves.length, 1);
  assert.equal(waves[0]!.canonicalVariantCreates, 0);
  assert.equal(waves[0]!.canonicalVariantReuses, 1);
  assert.equal(waves[0]!.decisionCreates, 0);
  assert.equal(waves[0]!.decisionReuses, 1);
  assert.equal(waves[0]!.maximumRows, 7);
});
