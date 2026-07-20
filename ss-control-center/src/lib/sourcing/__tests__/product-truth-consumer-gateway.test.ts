import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProductTruthConsumerActivation,
  expectedProductTruthConsumerActivationConfirmation,
  productTruthConsumerActivationSha256,
  validateProductTruthConsumerActivation,
  type ProductTruthConsumerActivationMode,
} from "../product-truth-consumer-activation";
import {
  ProductTruthConsumerGatewayError,
  buildProductTruthConsumerGatewayReport,
  productTruthConsumerGatewayReportSha256,
} from "../product-truth-consumer-gateway";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "../product-truth-read-contract-version";
import type {
  ProductTruthCostStatus,
  ProductTruthSnapshot,
} from "../product-truth-read-contract";

const MANIFEST = "a".repeat(64);
const TARGET = "b".repeat(64);
const ISSUED_AT = "2026-07-19T12:00:00.000Z";
const EXPIRES_AT = "2026-07-20T12:00:00.000Z";
const READ_AT = "2026-07-19T12:30:00.000Z";
const MAX_AGE = 24 * 60 * 60 * 1_000;

function activation(mode: ProductTruthConsumerActivationMode) {
  const value = buildProductTruthConsumerActivation({
    approvalId: `owner-${mode.toLowerCase()}-1`,
    mode,
    authoritativeManifestSha256: MANIFEST,
    databaseTargetFingerprint: TARGET,
    consumers: ["BUNDLE_FACTORY", "UNIT_ECONOMICS"],
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    maxPriceAgeMs: MAX_AGE,
    maxListingsPerBatch: 2,
  });
  const digest = productTruthConsumerActivationSha256(value);
  return validateProductTruthConsumerActivation({
    activation: value,
    activationSha256: digest,
    confirmation: expectedProductTruthConsumerActivationConfirmation(
      digest,
      value.ownerApproval.approvalId,
      mode,
    ),
    runtimeBinding: {
      mode,
      readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
      authoritativeManifestSha256: MANIFEST,
      databaseTargetFingerprint: TARGET,
      consumers: value.consumers,
      maxPriceAgeMs: MAX_AGE,
      maxListingsPerBatch: 2,
    },
    now: READ_AT,
  });
}

function snapshot(input: {
  sku: string;
  status?: ProductTruthCostStatus;
  contentReady?: boolean;
}): ProductTruthSnapshot {
  const status = input.status ?? "FACT";
  const contentReady = input.contentReady ?? true;
  const cost = status === "FACT" || status === "ESTIMATE" || status === "UNSOURCEABLE"
    ? {
        id: `cost-${input.sku}`,
        observationKey: "c".repeat(64),
        recipeHash: "d".repeat(64),
        sku: input.sku,
        effectiveDate: READ_AT,
        createdAt: READ_AT,
        source: "retail:batch",
        productCost: status === "UNSOURCEABLE" ? null : 2,
        packagingCost: null,
        iceCost: null,
        totalCost: status === "UNSOURCEABLE" ? null : 2,
        costPerUnit: status === "UNSOURCEABLE" ? null : 2,
        packSize: status === "UNSOURCEABLE" ? null : 1,
        currency: "USD",
        needsReview: status !== "FACT",
        matcherVersion: "canonical-product-match/1.2.0",
        pricePolicyVersion: "price-evidence-eligibility/1.0.0",
        evidenceOutcome: status,
        evidence: {},
        runId: "run-1",
        approvalId: "approval-1",
        componentProvenance: [],
      } as ProductTruthSnapshot["views"]["unitEconomics"]["current"]
    : null;
  return {
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    snapshot: {
      sku: input.sku,
      channel: "amazon",
      storeIndex: 1,
      listingKey: `amazon:1:${input.sku}`,
      asOf: READ_AT,
      maxPriceAgeMs: MAX_AGE,
      skuCostId: cost?.id ?? null,
    },
    recipe: { components: [], blockers: contentReady ? [] : ["CONTENT_BLOCKED"] },
    views: {
      bundleFactory: {
        consumer: "BUNDLE_FACTORY",
        ready: contentReady,
        components: [],
        blockers: contentReady ? [] : ["CONTENT_BLOCKED"],
      },
      listingImprovement: {
        consumer: "LISTING_IMPROVEMENT",
        ready: contentReady,
        components: [],
        blockers: contentReady ? [] : ["CONTENT_BLOCKED"],
      },
      unitEconomics: {
        consumer: "UNIT_ECONOMICS",
        status,
        current: cost,
        factualCost: status === "FACT" ? cost : null,
        estimatedCost: status === "ESTIMATE" ? cost : null,
        blockers: status === "MISSING" ? ["CURRENT_SCOPED_SKU_COST_MISSING"]
          : status === "INVALID" ? ["COST_EVIDENCE_INVALID"] : [],
      },
      procurement: {
        consumer: "PROCUREMENT",
        ready: false,
        components: [],
        blockers: ["NO_CURRENT_ELIGIBLE_LOCAL_PRICE"],
      },
    },
  };
}

function scope(sku: string) {
  return { sku, channel: "amazon", storeIndex: 1 };
}

function code(error: unknown): string | undefined {
  return error instanceof ProductTruthConsumerGatewayError ? error.code : undefined;
}

test("SHADOW output is compare-only and preserves explicit ready/blocker truth", () => {
  const report = buildProductTruthConsumerGatewayReport({
    validatedActivation: activation("SHADOW"),
    consumer: "BUNDLE_FACTORY",
    scopes: [scope("READY"), scope("BLOCKED")],
    snapshots: [snapshot({ sku: "READY" }), snapshot({ sku: "BLOCKED", contentReady: false })],
    readAt: READ_AT,
    asOf: READ_AT,
  });
  assert.equal(report.mode, "SHADOW");
  assert.equal(report.outputUse, "COMPARE_ONLY");
  assert.deepEqual(report.counts, {
    total: 2, ready: 1, unsourceable: 0, blocked: 1,
    fact: 2, estimate: 0, missing: 0, invalid: 0,
  });
  assert.equal(report.claims.legacyFallback, false);
  assert.deepEqual(report.entries.map((entry) => entry.disposition), ["READY", "BLOCKED"]);
  assert.match(productTruthConsumerGatewayReportSha256(report), /^[a-f0-9]{64}$/);
});

test("ENFORCED Unit Economics keeps estimate typed and UNSOURCEABLE blocked without fallback", () => {
  const report = buildProductTruthConsumerGatewayReport({
    validatedActivation: activation("ENFORCED"),
    consumer: "UNIT_ECONOMICS",
    scopes: [scope("EST"), scope("NONE")],
    snapshots: [
      snapshot({ sku: "EST", status: "ESTIMATE" }),
      snapshot({ sku: "NONE", status: "UNSOURCEABLE" }),
    ],
    readAt: READ_AT,
    asOf: READ_AT,
  });
  assert.equal(report.outputUse, "AUTHORITATIVE_NO_FALLBACK");
  assert.deepEqual(report.entries.map((entry) => entry.disposition), ["READY", "UNSOURCEABLE"]);
  assert.equal(report.entries[0].view.consumer, "UNIT_ECONOMICS");
  assert.ok(report.entries[1].blockers.includes("UNIT_ECONOMICS_UNSOURCEABLE"));
  assert.equal(report.counts.estimate, 1);
  assert.equal(report.counts.unsourceable, 1);
});

test("a consumer outside the owner-approved subset remains OFF", () => {
  assert.throws(
    () => buildProductTruthConsumerGatewayReport({
      validatedActivation: activation("SHADOW"),
      consumer: "PROCUREMENT",
      scopes: [scope("SKU")],
      snapshots: [snapshot({ sku: "SKU" })],
      readAt: READ_AT,
      asOf: READ_AT,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_OFF",
  );
});

test("batch, time, and snapshot bindings fail closed", () => {
  const validated = activation("SHADOW");
  assert.throws(
    () => buildProductTruthConsumerGatewayReport({
      validatedActivation: validated,
      consumer: "BUNDLE_FACTORY",
      scopes: [scope("A"), scope("B"), scope("C")],
      snapshots: [snapshot({ sku: "A" }), snapshot({ sku: "B" }), snapshot({ sku: "C" })],
      readAt: READ_AT,
      asOf: READ_AT,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_BATCH_INVALID",
  );
  assert.throws(
    () => buildProductTruthConsumerGatewayReport({
      validatedActivation: validated,
      consumer: "BUNDLE_FACTORY",
      scopes: [scope("A")],
      snapshots: [snapshot({ sku: "A" })],
      readAt: EXPIRES_AT,
      asOf: READ_AT,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_ACTIVATION_EXPIRED",
  );
  assert.throws(
    () => buildProductTruthConsumerGatewayReport({
      validatedActivation: validated,
      consumer: "BUNDLE_FACTORY",
      scopes: [scope("A")],
      snapshots: [snapshot({ sku: "WRONG" })],
      readAt: READ_AT,
      asOf: READ_AT,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_RESULT_INVALID",
  );
});
