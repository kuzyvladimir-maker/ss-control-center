import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildCanonicalProductVariantKey } from "../canonical-product-variant";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";
import {
  buildProductTruthTargetedWalmartEvidencePlan,
  buildProductTruthTargetedWalmartEvidenceRequest,
  parseProductTruthTargetedWalmartDonorSnapshot,
} from "../product-truth-targeted-walmart-evidence-contract";
import {
  buildProductTruthWalmartCollectionBatch,
} from "../product-truth-walmart-collection-contract";
import {
  buildProductTruthWalmartEnrichmentQuote,
  parseProductTruthWalmartEnrichmentQuote,
  productTruthWalmartEnrichmentQuoteSha256,
} from "../product-truth-walmart-enrichment-quote";
import {
  PRODUCT_TRUTH_WALMART_ENRICHMENT_RESULT_VERSION,
  assertProductTruthWalmartEnrichmentResult,
  type ProductTruthWalmartEnrichmentResult,
} from "../product-truth-walmart-enrichment-worker-contract";

const CREATED_AT = "2026-07-28T12:00:00.000Z";
const EXPIRES_AT = "2026-07-28T13:00:00.000Z";
const HASH = "a".repeat(64);
const DECISION_EVIDENCE_JSON = JSON.stringify({
  matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
  schemaVersion: "donor-source-identity-evidence/1.2.0",
});
const DECISION_EVIDENCE_HASH = createHash("sha256")
  .update(DECISION_EVIDENCE_JSON)
  .digest("hex");

function fixture(count = 2) {
  const candidates = Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const canonical = buildCanonicalProductVariantKey({
      brand: "Campbell's",
      productLine: `Condensed Soup ${ordinal}`,
      flavor: ordinal === 1 ? "Tomato" : "Chicken Noodle",
      modifiers: [],
      form: "Can",
      size: "10.5 oz",
      outerPackCount: 1,
    });
    return {
      canonical,
      candidate: {
        donorProductId: `donor-${ordinal}`,
        canonicalVariantId: canonical.canonicalVariantId,
        title:
          `Campbell's ${ordinal === 1 ? "Tomato" : "Chicken Noodle"} Soup 10.5 oz`,
        query:
          `Campbell's ${ordinal === 1 ? "Tomato" : "Chicken Noodle"} Soup 10.5 oz`,
        missingFields: ["ALLERGENS", "IMAGES", "INGREDIENTS", "NUTRITION"],
      },
    };
  });
  const batch = buildProductTruthWalmartCollectionBatch({
    requestedByUserId: "owner-1",
    requestedAt: CREATED_AT,
    prompt: "Create Campbell's canned soup listings",
    listingCount: count,
    packCount: 2,
    unwrangleReserveFloor: 100,
    candidates: candidates.map(({ candidate }) => candidate),
  });
  const entries = batch.jobs.map((job, index) => {
    const { canonical } = candidates[index]!;
    const snapshot = parseProductTruthTargetedWalmartDonorSnapshot({
      identityMode: "EXISTING_EXACT",
      identityDerivationVersion: null,
      donorProductId: job.target.donorProductId,
      donorOfferId: `offer-${index + 1}`,
      donorIdentityStatus: "exact_confirmed",
      variantDecisionId: `decision-${index + 1}`,
      canonicalVariantId: canonical.canonicalVariantId,
      decisionStatus: "exact_confirmed",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      decisionEvidenceHash: DECISION_EVIDENCE_HASH,
      decisionEvidenceJson: DECISION_EVIDENCE_JSON,
      canonicalVariantKeyVersion: canonical.keyVersion,
      canonicalIdentityHash: canonical.identityHash,
      canonicalIdentityJson: canonical.identityJson,
      retailer: "walmart",
      retailerProductId: `12345678${index + 1}`,
      normalizedProductUrl:
        `https://www.walmart.com/ip/12345678${index + 1}`,
      via: "direct",
      isFirstParty: true,
      legacySnapshot: null,
    });
    const request = buildProductTruthTargetedWalmartEvidenceRequest({
      runId: job.runId,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      targetFingerprint: HASH,
      engineReleaseSha256: "b".repeat(64),
      schemaFingerprintSha256: "c".repeat(64),
      migrationSetSha256: "d".repeat(64),
      query: job.target.query,
      donorSnapshot: snapshot,
      unwrangleReserveFloor: 100,
    });
    const plan = buildProductTruthTargetedWalmartEvidencePlan({
      request,
      actualTargetFingerprint: HASH,
      actualEngineReleaseSha256: "b".repeat(64),
      actualSchemaFingerprintSha256: "c".repeat(64),
      actualMigrationSetSha256: "d".repeat(64),
      actualDonorSnapshot: snapshot,
      actualDetailHarvestStateAbsent: true,
    });
    return { job, plan };
  });
  const quote = buildProductTruthWalmartEnrichmentQuote({
    batchId: batch.batchId,
    requestedByUserId: batch.requestedByUserId,
    createdAt: CREATED_AT,
    entries,
  });
  return { batch, entries, quote };
}

function balanceEvidence(index: number) {
  return {
    provider: "unwrangle" as const,
    observedAt: `2026-07-28T12:0${index}:00.000Z`,
    balanceUnits: 500 - index * 2.5,
    reserveFloor: 100,
    evidenceSha256: String(index + 1).repeat(64),
  };
}

function completedResult(
  quote: ReturnType<typeof fixture>["quote"],
): ProductTruthWalmartEnrichmentResult {
  return {
    schemaVersion: PRODUCT_TRUTH_WALMART_ENRICHMENT_RESULT_VERSION,
    commandId: "command-1",
    batchId: quote.batchId,
    quoteSha256: productTruthWalmartEnrichmentQuoteSha256(quote),
    status: "COMPLETED",
    reason: "ALL_EXACT_TARGETS_ENRICHED",
    generatedAt: "2026-07-28T12:10:00.000Z",
    providerCalls: 1 + quote.actions.jobs.length * 2,
    providerUnits: 2.5 + quote.actions.jobs.length * 3.5,
    marketplaceMutations: 0,
    initialBalanceEvidence: balanceEvidence(0),
    jobs: quote.actions.jobs.map((job, index) => ({
      ordinal: job.ordinal,
      runId: job.runId,
      planSha256: job.planSha256,
      status: "COMPLETED",
      reason: "COMPLETED",
      providerCalls: 2,
      providerUnits: 3.5,
      reportSha256: String(index + 3).repeat(64),
      nextBalanceEvidence: balanceEvidence(index + 1),
    })),
    claims: {
      concurrency: 1,
      maxAttemptsPerJob: 1,
      automaticReplay: false,
      oneInitialBalanceProbeMaximum: true,
      marketplaceMutations: 0,
    },
  };
}

test("one owner click quotes each exact target and the exact maximum credits", () => {
  const { quote } = fixture(2);
  assert.equal(quote.actions.jobs.length, 2);
  assert.equal(quote.totals.balanceProbeMaximumUnits, 2.5);
  assert.equal(quote.totals.oxylabsMaximumUnits, 2);
  assert.equal(quote.totals.unwrangleDetailMaximumUnits, 5);
  assert.equal(quote.totals.maximumProviderUnits, 9.5);
  assert.deepEqual(
    quote.actions.jobs.map((job) => job.ordinal),
    [1, 2],
  );
  assert.equal(
    parseProductTruthWalmartEnrichmentQuote(quote).quoteId,
    quote.quoteId,
  );
});

test("quote parsing rejects a changed total or changed product after review", () => {
  const { quote } = fixture(2);
  const changedTotal = structuredClone(quote) as unknown as Record<string, unknown>;
  (changedTotal.totals as Record<string, unknown>).maximumProviderUnits = 99;
  assert.throws(
    () => parseProductTruthWalmartEnrichmentQuote(changedTotal),
    /quoted totals do not add up/u,
  );

  const changedTarget = structuredClone(quote) as unknown as Record<string, unknown>;
  const actions = changedTarget.actions as {
    jobs: Record<string, unknown>[];
  };
  actions.jobs[0]!.title = "A different product";
  assert.throws(
    () => parseProductTruthWalmartEnrichmentQuote(changedTarget),
    /quoteId does not bind the exact quote/u,
  );
});

test("result contract accepts the exact bounded batch and rejects replay-shaped drift", () => {
  const { quote } = fixture(2);
  const result = completedResult(quote);
  assert.equal(
    assertProductTruthWalmartEnrichmentResult({
      result,
      quote,
      commandId: "command-1",
    }).status,
    "COMPLETED",
  );

  const tooManyCalls = structuredClone(result);
  tooManyCalls.providerCalls += 1;
  assert.throws(
    () => assertProductTruthWalmartEnrichmentResult({
      result: tooManyCalls,
      quote,
      commandId: "command-1",
    }),
    /ENRICHMENT_RESULT_INVALID/u,
  );

  const ranAfterStop = structuredClone(result);
  ranAfterStop.status = "BLOCKED";
  ranAfterStop.reason = "FIRST_JOB_BLOCKED";
  ranAfterStop.providerCalls = 5;
  ranAfterStop.providerUnits = 9.5;
  ranAfterStop.jobs[0]!.status = "BLOCKED";
  ranAfterStop.jobs[0]!.nextBalanceEvidence = null;
  assert.throws(
    () => assertProductTruthWalmartEnrichmentResult({
      result: ranAfterStop,
      quote,
      commandId: "command-1",
    }),
    /jobs after the first non-completed outcome must remain not started/u,
  );
});
