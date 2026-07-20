import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  ProductTruthExpansionCampaignError,
  buildProductTruthExpansionActiveCampaignSnapshot,
  deriveProductTruthExpansionCampaignKey,
  sealProductTruthExpansionCampaign,
  sealProductTruthExpansionCheckpoint,
  validateSealedProductTruthExpansionCampaign,
  validateSealedProductTruthExpansionCheckpoint,
  type ProductTruthExpansionCampaignInput,
  type ProductTruthExpansionCheckpointInput,
} from "../product-truth-expansion-campaign";

const CREATED_AT = "2026-07-19T12:00:00.000Z";
const EXPIRES_AT = "2026-07-19T13:00:00.000Z";
const SCOPE_SHA = "1".repeat(64);
const MANIFEST_SHA = "2".repeat(64);
const READINESS_SHA = "3".repeat(64);

function code(error: unknown): string | undefined {
  return error instanceof ProductTruthExpansionCampaignError ? error.code : undefined;
}

function validInput(): ProductTruthExpansionCampaignInput {
  return {
    campaignId: "phase2-acme-snacks-20260719-a",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    phase1Proof: {
      manifest: {
        schemaVersion: "phase1-authoritative-scope-manifest/v3",
        sha256: MANIFEST_SHA,
        authoritative: true,
        blockerCount: 0,
        liveListingCount: 5_428,
      },
      readiness: {
        schemaVersion: "product-truth-consumer-readiness/1.0.0",
        reportSha256: READINESS_SHA,
        manifestSha256: MANIFEST_SHA,
        capturedAt: "2026-07-19T11:50:00.000Z",
        denominator: 5_428,
        reconciled: 5_428,
        classified: 5_428,
        integrityBlockerCount: 0,
        phase1Completion: "PASS",
      },
      ownerCompletion: {
        approvedBy: "owner",
        decision: "PHASE1_COMPLETE",
        approvalId: "phase1-owner-completion-20260719",
        approvalArtifactSha256: "4".repeat(64),
        approvedAt: "2026-07-19T11:55:00.000Z",
        manifestSha256: MANIFEST_SHA,
        readinessReportSha256: READINESS_SHA,
      },
    },
    scope: {
      dimension: "brand",
      selectors: ["Acme Foods", "ACME   FOODS"],
      sourceArtifactSha256: SCOPE_SHA,
    },
    sourcePolicy: {
      procurementZip: "33765",
      firstPartyOnly: true,
      marketplaceSellersAllowed: false,
      retailers: ["walmart", "target", "publix"],
      allowClubs: false,
      allowBjs: false,
      clubApproval: null,
    },
    sourceRoutes: [
      { retailer: "walmart", provider: "unwrangle", operation: "search", firstPartyOnly: true },
      { retailer: "target", provider: "unwrangle", operation: "search", firstPartyOnly: true },
      { retailer: "publix", provider: "oxylabs", operation: "query", firstPartyOnly: true },
    ],
    providerCeilings: [
      { provider: "unwrangle", operation: "search", maxCalls: 20, maxCredits: 40, reserveFloorCredits: 16_000 },
      { provider: "oxylabs", operation: "query", maxCalls: 10, maxCredits: 10, reserveFloorCredits: 0 },
    ],
    limits: { maxDiscoveredItems: 20, maxAcceptedItems: 10 },
    matcherVersion: "canonical-product-matcher/1.2.0",
    activeCampaignSnapshot: buildProductTruthExpansionActiveCampaignSnapshot({
      capturedAt: "2026-07-19T11:59:00.000Z",
      activeCampaignKeys: [],
    }),
    activeCampaignSnapshotMaxAgeMs: 5 * 60 * 1_000,
    checkpointEveryDiscoveredItems: 10,
    completionCriteria: {
      minimumAcceptedItems: 1,
      minimumCatalogReadyBasisPoints: 10_000,
      maximumUnresolvedItems: 0,
      requireScopeExhausted: true,
      requireExactReconciliation: true,
      requireNoPendingItems: true,
      requireNoUnsettledPaidOutcomes: true,
      requireFinalQualityReport: true,
    },
  };
}

function completeCheckpoint(): ProductTruthExpansionCheckpointInput {
  return {
    capturedAt: "2026-07-19T12:10:00.000Z",
    scopeExhausted: true,
    discoveredItemKeys: ["retailer-item-b", "retailer-item-a", "retailer-item-a"],
    acceptedItems: [{
      itemKey: "retailer-item-a",
      canonicalVariantId: "canonical-variant-a",
      identityEvidenceSha256: "5".repeat(64),
      contentEvidenceSha256: "6".repeat(64),
      evidenceStatus: "CATALOG_READY",
    }],
    rejectedItems: [{ itemKey: "retailer-item-b", reasonCode: "DUPLICATE_EXISTING" }],
    pendingItemKeys: [],
    providerUsage: [
      { provider: "unwrangle", operation: "search", callsUsed: 2, creditsUsed: 4 },
      { provider: "oxylabs", operation: "query", callsUsed: 1, creditsUsed: 1 },
    ],
    unsettledPaidOutcomeKeys: [],
    finalQualityReportSha256: "7".repeat(64),
  };
}

test("seals every Phase 2 dimension deterministically with exact scope, budget, and no execution grant", () => {
  for (const dimension of ["brand", "group", "retailer", "demand"] as const) {
    const first = validInput();
    first.scope = {
      ...first.scope,
      dimension,
      selectors: dimension === "retailer" ? ["target", "walmart", "target"] : ["  Alpha  "] as string[],
    };
    if (dimension !== "retailer") first.scope.selectors = ["Alpha", "alpha"];
    const second = structuredClone(first);
    second.sourceRoutes = [...second.sourceRoutes].reverse();
    second.providerCeilings = [...second.providerCeilings].reverse();
    second.sourcePolicy.retailers = [...second.sourcePolicy.retailers].reverse();
    second.scope.selectors = [...second.scope.selectors].reverse();
    const sealed = sealProductTruthExpansionCampaign(first);
    const reordered = sealProductTruthExpansionCampaign(second);
    assert.equal(sealed.artifact.status, "READY");
    assert.equal(sealed.artifact.sourcePolicy.procurementZip, "33765");
    assert.equal(sealed.artifact.sourcePolicy.firstPartyOnly, true);
    assert.equal(sealed.artifact.budget.totalMaxCalls, 30);
    assert.equal(sealed.artifact.limits.maxDiscoveredItems, 20);
    assert.equal(sealed.artifact.limits.maxAcceptedItems, 10);
    assert.equal(sealed.artifact.claims.executionAuthorized, false);
    assert.equal(sealed.artifactSha256, reordered.artifactSha256);
    assert.deepEqual(sealed.artifact.scope.selectors, dimension === "retailer" ? ["target", "walmart"] : ["alpha"]);
  }
});

test("artifact and checkpoint tampering fail closed", () => {
  const campaign = sealProductTruthExpansionCampaign(validInput());
  const tamperedCampaign = structuredClone(campaign);
  tamperedCampaign.artifact.budget.providerCeilings[0].maxCalls += 1;
  assert.throws(
    () => validateSealedProductTruthExpansionCampaign(tamperedCampaign),
    (error) => code(error) === "EXPANSION_ARTIFACT_TAMPERED",
  );

  const checkpoint = sealProductTruthExpansionCheckpoint({ campaign, checkpoint: completeCheckpoint() });
  const tamperedCheckpoint = structuredClone(checkpoint);
  tamperedCheckpoint.artifact.reconciliation.accepted = 9;
  assert.throws(
    () => validateSealedProductTruthExpansionCheckpoint(tamperedCheckpoint, campaign),
    (error) => code(error) === "CHECKPOINT_TAMPERED",
  );
});

test("BJ's is always forbidden and clubs require an exact current owner gate", () => {
  const bjs = validInput();
  bjs.sourcePolicy.retailers = ["bjs" as "walmart"];
  assert.throws(
    () => sealProductTruthExpansionCampaign(bjs),
    (error) => code(error) === "BJS_FORBIDDEN",
  );

  const ungated = validInput();
  ungated.sourcePolicy.retailers = ["walmart", "samsclub"];
  ungated.sourcePolicy.allowClubs = true;
  ungated.sourceRoutes = [
    ...ungated.sourceRoutes.filter((route) => route.retailer === "walmart"),
    { retailer: "samsclub", provider: "unwrangle", operation: "search", firstPartyOnly: true },
  ];
  ungated.providerCeilings = ungated.providerCeilings.filter((row) => row.provider === "unwrangle");
  assert.throws(
    () => sealProductTruthExpansionCampaign(ungated),
    (error) => code(error) === "CLUBS_NOT_AUTHORIZED",
  );

  const gated = structuredClone(ungated);
  gated.sourcePolicy.clubApproval = {
    approvedBy: "owner",
    decision: "ALLOW_PHASE2_CLUB_SOURCES",
    approvalId: "owner-club-gate-a",
    approvalArtifactSha256: "8".repeat(64),
    campaignId: gated.campaignId,
    scopeArtifactSha256: gated.scope.sourceArtifactSha256,
    retailers: ["samsclub"],
    issuedAt: "2026-07-19T11:58:00.000Z",
    expiresAt: EXPIRES_AT,
  };
  assert.equal(sealProductTruthExpansionCampaign(gated).artifact.status, "READY");
});

test("incomplete or missing authoritative Phase 1 proof can never become READY", () => {
  const missing = validInput();
  missing.phase1Proof = null;
  const missingPlan = sealProductTruthExpansionCampaign(missing);
  assert.equal(missingPlan.artifact.status, "BLOCKED");
  assert.deepEqual(missingPlan.artifact.blockers, ["PHASE1_PROOF_MISSING"]);
  assert.throws(
    () => sealProductTruthExpansionCheckpoint({ campaign: missingPlan, checkpoint: completeCheckpoint() }),
    (error) => code(error) === "CAMPAIGN_NOT_READY",
  );

  const incomplete = validInput();
  assert(incomplete.phase1Proof);
  incomplete.phase1Proof.manifest.authoritative = false;
  incomplete.phase1Proof.readiness.classified -= 1;
  incomplete.phase1Proof.readiness.phase1Completion = "FAIL";
  incomplete.phase1Proof.ownerCompletion = null;
  const blocked = sealProductTruthExpansionCampaign(incomplete);
  assert.equal(blocked.artifact.status, "BLOCKED");
  assert.deepEqual(blocked.artifact.blockers, [
    "PHASE1_MANIFEST_NOT_AUTHORITATIVE",
    "PHASE1_OWNER_COMPLETION_MISSING",
    "PHASE1_READINESS_INCOMPLETE",
    "PHASE1_READINESS_NOT_RECONCILED",
  ]);
});

test("campaign key dedup blocks a second active logical scope", () => {
  const input = validInput();
  const key = deriveProductTruthExpansionCampaignKey({
    scope: input.scope,
    procurementZip: input.sourcePolicy.procurementZip,
  });
  input.activeCampaignSnapshot = buildProductTruthExpansionActiveCampaignSnapshot({
    capturedAt: "2026-07-19T11:59:00.000Z",
    activeCampaignKeys: [key, key],
  });
  const blocked = sealProductTruthExpansionCampaign(input);
  assert.equal(blocked.artifact.status, "BLOCKED");
  assert.deepEqual(blocked.artifact.blockers, ["CAMPAIGN_KEY_ALREADY_ACTIVE"]);
  assert.deepEqual(blocked.artifact.dedup.activeCampaignSnapshot?.activeCampaignKeys, [key]);
});

test("checkpoint dedup/reconciliation is deterministic and completion is criteria-bound", () => {
  const campaign = sealProductTruthExpansionCampaign(validInput());
  const first = completeCheckpoint();
  const second = structuredClone(first);
  second.discoveredItemKeys = [...second.discoveredItemKeys].reverse();
  second.acceptedItems = [second.acceptedItems[0], second.acceptedItems[0]];
  second.providerUsage = [...second.providerUsage].reverse();
  const sealed = sealProductTruthExpansionCheckpoint({ campaign, checkpoint: first });
  const reordered = sealProductTruthExpansionCheckpoint({ campaign, checkpoint: second });
  assert.equal(sealed.checkpointSha256, reordered.checkpointSha256);
  assert.equal(sealed.artifact.status, "COMPLETE");
  assert.deepEqual(sealed.artifact.reconciliation, {
    discovered: 2,
    accepted: 1,
    rejected: 1,
    pending: 0,
    catalogReadyAccepted: 1,
    unresolved: 0,
    catalogReadyBasisPoints: 10_000,
    partitionComplete: true,
    totalCallsUsed: 3,
    totalCreditsUsed: 5,
  });
});

test("checkpoint chain is cumulative, cadence-bound, and hash-linked", () => {
  const campaign = sealProductTruthExpansionCampaign(validInput());
  const first = sealProductTruthExpansionCheckpoint({
    campaign,
    checkpoint: {
      capturedAt: "2026-07-19T12:05:00.000Z",
      scopeExhausted: false,
      discoveredItemKeys: ["retailer-item-a"],
      acceptedItems: [],
      rejectedItems: [],
      pendingItemKeys: ["retailer-item-a"],
      providerUsage: [
        { provider: "unwrangle", operation: "search", callsUsed: 1, creditsUsed: 2 },
        { provider: "oxylabs", operation: "query", callsUsed: 0, creditsUsed: 0 },
      ],
      unsettledPaidOutcomeKeys: [],
      finalQualityReportSha256: null,
    },
  });
  assert.equal(first.artifact.status, "IN_PROGRESS");

  const second = sealProductTruthExpansionCheckpoint({
    campaign,
    previousCheckpoint: first,
    checkpoint: {
      capturedAt: "2026-07-19T12:10:00.000Z",
      scopeExhausted: true,
      discoveredItemKeys: ["retailer-item-a"],
      acceptedItems: [{
        itemKey: "retailer-item-a",
        canonicalVariantId: "canonical-variant-a",
        identityEvidenceSha256: "5".repeat(64),
        contentEvidenceSha256: "6".repeat(64),
        evidenceStatus: "CATALOG_READY",
      }],
      rejectedItems: [],
      pendingItemKeys: [],
      providerUsage: [
        { provider: "unwrangle", operation: "search", callsUsed: 1, creditsUsed: 2 },
        { provider: "oxylabs", operation: "query", callsUsed: 0, creditsUsed: 0 },
      ],
      unsettledPaidOutcomeKeys: [],
      finalQualityReportSha256: "7".repeat(64),
    },
  });
  assert.equal(second.artifact.sequence, 2);
  assert.equal(second.artifact.previousCheckpointSha256, first.checkpointSha256);
  assert.equal(second.artifact.status, "COMPLETE");
});

test("module is a pure local contract with no DB, network, model, or execution dependency", async () => {
  const source = await readFile(
    new URL("../product-truth-expansion-campaign.ts", import.meta.url),
    "utf8",
  );
  const imports = [...source.matchAll(/^import .* from "([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:crypto"]);
  assert.doesNotMatch(source, /@libsql|prisma|fetch\s*\(|axios|openai|anthropic|operational-runner|metered-call-guard/i);
});
