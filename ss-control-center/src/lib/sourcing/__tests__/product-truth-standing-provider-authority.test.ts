import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
  assertProductTruthPlanEligibleForStandingAuthority,
  buildProductTruthStandingAuthorization,
  buildProductTruthStandingBalanceProbeArtifact,
  buildProductTruthStandingBalanceProbePermit,
  parseProductTruthStandingBalanceProbeArtifact,
  parseProductTruthStandingProviderPolicy,
  validateProductTruthStandingProviderPolicy,
} from "../product-truth-standing-provider-authority";
import {
  buildProductTruthOperationalPlan,
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
  buildProductTruthTargetedWalmartCanonicalRecipeBinding,
  buildProductTruthTargetedWalmartEvidencePlan,
  parseProductTruthTargetedWalmartDonorSnapshot,
  parseProductTruthTargetedWalmartEvidencePlan,
  targetedWalmartDonorSnapshotSha256,
  validateProductTruthTargetedWalmartEvidenceApproval,
} from "../product-truth-targeted-walmart-evidence-contract";
import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "../canonical-product-match-provenance";
import { parseProductTruthRunnerArguments } from "../../../../scripts/product-truth-runner";

const POLICY_PATH = join(
  process.cwd(),
  "data/audits/product-truth-standing-authority/standing-provider-policy-20260730-v3.json",
);
const MANIFEST_PATH = join(
  process.cwd(),
  "data/audits/product-truth-phase1-scope/20260726T180513Z-g4-manifest-inputs-v1/manifest-authoritative-v3/phase1-scope-manifest.json",
);
const PLAN_PATH = join(
  process.cwd(),
  "data/audits/product-truth-field-snapshot-canary/20260728T235835Z/preflight/plan/plan.json",
);
const NOW = "2026-07-29T00:05:00.000Z";
const RAW_RESPONSE = `${JSON.stringify({
  success: true,
  remaining_credits: 99_650,
  results: [],
})}\n`;
const METERED_AUTHORIZATION = {
  approvalId: "pt-standing-balance:test",
  reservationKey: `mpr_v1_${"a".repeat(64)}`,
  receiptId: "mrr_test_balance_1",
};

async function fixture() {
  const [policyJson, planJson] = await Promise.all([
    readFile(POLICY_PATH, "utf8"),
    readFile(PLAN_PATH, "utf8"),
  ]);
  const policyValue = JSON.parse(policyJson) as unknown;
  const policy = validateProductTruthStandingProviderPolicy({
    policy: policyValue,
    policyJson,
    policySha256: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
  });
  const plan = parseProductTruthTargetedWalmartEvidencePlan(
    JSON.parse(planJson) as unknown,
  );
  const planSha256 = productTruthOperationalSha256(plan);
  return { policyJson, policyValue, policy, plan, planSha256 };
}

test("pinned standing policy replaces chat approval without weakening exact plan gates", async () => {
  const { policy, plan, planSha256 } = await fixture();
  assert.doesNotThrow(() => assertProductTruthPlanEligibleForStandingAuthority({
    plan,
    planSha256,
    policy,
    now: NOW,
  }));
  const balancePermit = buildProductTruthStandingBalanceProbePermit({
    plan,
    planSha256,
    policy,
    policySha256: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
    now: NOW,
  });
  assert.equal(balancePermit.permit.providers.unwrangle?.maxCalls, 1);
  assert.equal(balancePermit.permit.providers.unwrangle?.maxUnits, 2.5);
  assert.match(balancePermit.confirmation, /^APPROVE_METERED_RUN:/u);
  const evidence = buildProductTruthStandingBalanceProbeArtifact({
    plan,
    planSha256,
    policy,
    policySha256: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
    probeId: "ptbal-standing-test",
    requestedAt: "2026-07-29T00:04:00.000Z",
    observedAt: "2026-07-29T00:04:05.000Z",
    httpStatus: 200,
    rawResponseText: RAW_RESPONSE,
    meteredAuthorization: METERED_AUTHORIZATION,
  });
  const evidenceJson = renderProductTruthOperationalJson(evidence);
  const evidenceSha256 = productTruthOperationalSha256(evidence);
  const parsedEvidence = parseProductTruthStandingBalanceProbeArtifact({
    value: JSON.parse(evidenceJson) as unknown,
    json: evidenceJson,
    expectedSha256: evidenceSha256,
    rawResponseText: RAW_RESPONSE,
    plan,
    planSha256,
    policy,
    policySha256: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
    now: NOW,
  });
  const authorization = buildProductTruthStandingAuthorization({
    plan,
    planSha256,
    policy,
    policySha256: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
    balanceEvidence: parsedEvidence,
    balanceEvidenceSha256: evidenceSha256,
    now: NOW,
  });
  assert.equal(authorization.approval.approvedBy, "owner");
  assert.match(authorization.approvalId, /^pt-standing:/);
  assert.equal(
    authorization.approval.meteredPermit.providers.oxylabs?.maxUnits,
    1,
  );
  assert.equal(
    authorization.approval.meteredPermit.providers.unwrangle?.maxUnits,
    2.5,
  );
  assert.equal(authorization.approval.balanceEvidence[0]?.balanceUnits, 99_650);
  assert.doesNotThrow(() => validateProductTruthTargetedWalmartEvidenceApproval({
    plan,
    planSha256,
    approval: authorization.approval,
    executionConfirmation: authorization.executionConfirmation,
    now: NOW,
  }));
});

test("standing policy admits ordinary Target search plus exact detail in one bounded attempt", async () => {
  const { policy } = await fixture();
  const manifestJson = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(manifestJson) as unknown;
  const plan = buildProductTruthOperationalPlan({
    runId: "pt-standing-target-search-test",
    mode: "WAVE",
    createdAt: NOW,
    expiresAt: "2026-07-29T00:10:00.000Z",
    targetFingerprint: policy.databaseTargetFingerprint,
    manifest,
    manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
    listingKeys: ["walmart:1:FaisalX-380"],
    sourcePolicy: {
      procurementZip: "33765",
      retailers: ["walmart", "target"],
      allowClubs: false,
      allowBjs: false,
      listingConcurrency: 1,
      componentConcurrency: 1,
      maxAttemptsPerListing: 1,
    },
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
        operations: ["detail", "search"],
        maxCalls: 2,
        maxUnits: 5,
        reserveFloor: 15_000,
      },
    ],
    verificationPolicy: {
      maxPriceAgeMs: 172_800_000,
      minGalleryImages: 5,
    },
    maxWallClockMs: 360_000,
  });
  assert.doesNotThrow(() =>
    assertProductTruthPlanEligibleForStandingAuthority({
      plan,
      planSha256: productTruthOperationalSha256(plan),
      policy,
      now: NOW,
    }),
  );
});

test("standing authority accepts an exact donor only when it carries a sealed Phase 1 listing binding", async () => {
  const { policy, plan } = await fixture();
  const source = plan.targets[0];
  assert.ok(source.listingBinding);
  const sourceScope = JSON.parse(
    source.listingBinding.listingScopeRowJson,
  ) as Record<string, unknown>;
  const canonicalRecipeBinding =
    buildProductTruthTargetedWalmartCanonicalRecipeBinding({
      listingScopeRow: sourceScope,
      listingRecipeRow: {
        id: "recipe-standing-exact",
        listingKey: source.listingBinding.listingKey,
        manifestSha256: sourceScope.manifestSha256,
      },
      recipeComponentRow: {
        id: "recipe-component-standing-exact",
        listingRecipeId: "recipe-standing-exact",
        componentIndex: source.listingBinding.componentIndex,
        donorProductId: source.donorProductId,
        targetCanonicalVariantId: source.canonicalVariantId,
        variantDecisionId: "decision-standing-exact",
      },
    });
  const evidenceJson = renderProductTruthOperationalJson({
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    schemaVersion: "donor-source-identity-evidence/1.2.0",
  });
  const exact = parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: "EXISTING_EXACT",
    identityDerivationVersion: null,
    donorProductId: source.donorProductId,
    donorOfferId: source.donorOfferId,
    donorIdentityStatus: "exact_confirmed",
    variantDecisionId: "decision-standing-exact",
    canonicalVariantId: source.canonicalVariantId,
    decisionStatus: "exact_confirmed",
    matcherVersion: source.matcherVersion,
    matcherImplementationSha256: source.matcherImplementationSha256,
    matcherReleaseSha256: source.matcherReleaseSha256,
    decisionEvidenceHash: createHash("sha256").update(evidenceJson).digest("hex"),
    decisionEvidenceJson: evidenceJson,
    canonicalVariantKeyVersion: source.canonicalVariantKeyVersion,
    canonicalIdentityHash: source.canonicalIdentityHash,
    canonicalIdentityJson: source.canonicalIdentityJson,
    retailer: source.retailer,
    retailerProductId: source.retailerProductId,
    normalizedProductUrl: source.normalizedProductUrl,
    via: source.via,
    isFirstParty: source.isFirstParty,
    legacySnapshot: null,
    listingBinding: canonicalRecipeBinding,
  });
  const build = (listingBinding: typeof exact.listingBinding) => {
    const snapshot = parseProductTruthTargetedWalmartDonorSnapshot({
      ...exact,
      listingBinding,
    });
    return buildProductTruthTargetedWalmartEvidencePlan({
      request: {
        schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
        runId: "pt-standing-existing-exact",
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
        expectedTargetFingerprint: plan.targetFingerprint,
        engineReleaseSha256: plan.engineReleaseSha256,
        schemaFingerprintSha256: plan.schemaFingerprintSha256,
        migrationSetSha256: plan.migrationSetSha256,
        matcherVersion: plan.matcherVersion,
        matcherImplementationSha256: plan.matcherImplementationSha256,
        matcherReleaseSha256: plan.matcherReleaseSha256,
        query: source.query,
        donorSnapshot: snapshot,
        donorSnapshotSha256: targetedWalmartDonorSnapshotSha256(snapshot),
        providerCeilings: plan.providerCeilings,
        verificationPolicy: plan.verificationPolicy,
        maxWallClockMs: plan.maxWallClockMs,
      },
      actualTargetFingerprint: plan.targetFingerprint,
      actualEngineReleaseSha256: plan.engineReleaseSha256,
      actualSchemaFingerprintSha256: plan.schemaFingerprintSha256,
      actualMigrationSetSha256: plan.migrationSetSha256,
      actualDonorSnapshot: snapshot,
      actualDetailHarvestStateAbsent: true,
    });
  };
  const boundPlan = build(exact.listingBinding);
  const boundPlanSha256 = productTruthOperationalSha256(boundPlan);
  assert.doesNotThrow(() => assertProductTruthPlanEligibleForStandingAuthority({
    plan: boundPlan,
    planSha256: boundPlanSha256,
    policy,
    now: NOW,
  }));

  const legacyBoundPlan = build(source.listingBinding);
  assert.throws(
    () => assertProductTruthPlanEligibleForStandingAuthority({
      plan: legacyBoundPlan,
      planSha256: productTruthOperationalSha256(legacyBoundPlan),
      policy,
      now: NOW,
    }),
    /STANDING_AUTHORITY_PLAN_INELIGIBLE/u,
  );

  const unboundPlan = build(null);
  assert.throws(
    () => assertProductTruthPlanEligibleForStandingAuthority({
      plan: unboundPlan,
      planSha256: productTruthOperationalSha256(unboundPlan),
      policy,
      now: NOW,
    }),
    /STANDING_AUTHORITY_PLAN_INELIGIBLE/u,
  );
});

test("standing policy and authorization fail closed on expansion, tariff drift, stale evidence, and raw mismatch", async () => {
  const { policyValue, policy, plan, planSha256 } = await fixture();
  const expandedPolicy = {
    ...(policyValue as Record<string, unknown>),
    allowClubs: true,
  };
  assert.throws(
    () => parseProductTruthStandingProviderPolicy(expandedPolicy),
    /STANDING_AUTHORITY_POLICY_INVALID/u,
  );

  const expandedPlan = structuredClone(plan);
  const unwrangle = expandedPlan.providerCeilings.find(
    (ceiling) => ceiling.provider === "unwrangle",
  );
  assert.ok(unwrangle);
  unwrangle.maxUnits = 5;
  assert.throws(
    () => assertProductTruthPlanEligibleForStandingAuthority({
      plan: expandedPlan,
      planSha256: productTruthOperationalSha256(expandedPlan),
      policy,
      now: NOW,
    }),
    /STANDING_AUTHORITY_PLAN_INELIGIBLE/u,
  );

  const evidence = buildProductTruthStandingBalanceProbeArtifact({
    plan,
    planSha256,
    policy,
    policySha256: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
    probeId: "ptbal-standing-stale-test",
    requestedAt: "2026-07-29T00:00:00.000Z",
    observedAt: "2026-07-29T00:00:05.000Z",
    httpStatus: 200,
    rawResponseText: RAW_RESPONSE,
    meteredAuthorization: METERED_AUTHORIZATION,
  });
  const evidenceJson = renderProductTruthOperationalJson(evidence);
  const evidenceSha256 = productTruthOperationalSha256(evidence);
  assert.throws(
    () => parseProductTruthStandingBalanceProbeArtifact({
      value: JSON.parse(evidenceJson) as unknown,
      json: evidenceJson,
      expectedSha256: evidenceSha256,
      rawResponseText: RAW_RESPONSE,
      plan,
      planSha256,
      policy,
      policySha256: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
      now: "2026-07-29T00:11:00.000Z",
    }),
    /STANDING_AUTHORITY_BALANCE_EVIDENCE_STALE/u,
  );
  assert.throws(
    () => parseProductTruthStandingBalanceProbeArtifact({
      value: JSON.parse(evidenceJson) as unknown,
      json: evidenceJson,
      expectedSha256: evidenceSha256,
      rawResponseText: RAW_RESPONSE.replace("99650", "99649"),
      plan,
      planSha256,
      policy,
      policySha256: PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
      now: NOW,
    }),
    /STANDING_AUTHORITY_BALANCE_EVIDENCE_INVALID/u,
  );
});

test("CLI exposes automatic balance-probe and authorize commands without manual approval flags", () => {
  const balance = parseProductTruthRunnerArguments([
    "balance-probe",
    "--plan", "/tmp/plan.json",
    "--plan-sha", "/tmp/plan.sha256",
    "--standing-policy", "/tmp/policy.json",
    "--url", "libsql://example.turso.io",
    "--allow-remote",
    "--auth-token-env", "TURSO_AUTH_TOKEN",
    "--out", "/tmp/balance-new",
  ]);
  assert.equal(balance.command, "balance-probe");
  assert.equal("approvalPath" in balance, false);
  assert.equal("executionConfirmation" in balance, false);

  const authorize = parseProductTruthRunnerArguments([
    "authorize",
    "--plan", "/tmp/plan.json",
    "--plan-sha", "/tmp/plan.sha256",
    "--standing-policy", "/tmp/policy.json",
    "--balance-evidence", "/tmp/balance.json",
    "--balance-evidence-sha", "/tmp/balance.sha256",
    "--balance-raw-response", "/tmp/raw.json",
    "--url", "libsql://example.turso.io",
    "--allow-remote",
    "--auth-token-env", "TURSO_AUTH_TOKEN",
    "--out", "/tmp/authorization-new",
    "--execute-out", "/tmp/execution-new",
  ]);
  assert.equal(authorize.command, "authorize");
  assert.equal("approvalPath" in authorize, false);
  assert.equal("executionConfirmation" in authorize, false);
});
