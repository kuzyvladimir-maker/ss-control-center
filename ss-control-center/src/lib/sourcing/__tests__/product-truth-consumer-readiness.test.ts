import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  PHASE1_SCOPE_DISPOSITION_VERSION,
  buildPhase1ScopeManifest,
  parsePhase1DelimitedText,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  type Phase1Channel,
  type Phase1ScopeDispositionEntry,
} from "../phase1-scope-manifest";
import { makeTestConnectedStoreCensus } from "./phase1-connected-store-census-fixture";
import {
  ProductTruthConsumerReadinessError,
  compileProductTruthConsumerReadiness,
  renderProductTruthConsumerReadinessJson,
} from "../product-truth-consumer-readiness";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "../product-truth-read-contract-version";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";
import type {
  ProductTruthCostStatus,
  ProductTruthSnapshot,
} from "../product-truth-read-contract";

const AS_OF = "2026-07-19T12:00:00.000Z";
const CAPTURED_AT = "2026-07-19T12:05:00.000Z";
const MAX_PRICE_AGE_MS = 24 * 60 * 60 * 1_000;
const TARGET = "b".repeat(64);

const amazonReport = [
  "item-name\tseller-sku\tasin1\tstatus\tfulfillment-channel",
  "Acme One\tAMZ-1\tB000000001\tActive\tDEFAULT",
].join("\n");
const walmartReport = [
  "SKU,Item ID,Product Name,Published Status,Lifecycle Status",
  "WM-1,10001,Acme Two,Published,Active",
].join("\n");

function disposition(
  channel: Phase1Channel,
  content: string,
): Phase1ScopeDispositionEntry {
  return {
    channel,
    scopeKey: "store1",
    storeIndex: 1,
    accountId: `${channel}-account-1`,
    storeId: `${channel}-store-1`,
    marketplaceId: channel === "amazon" ? "ATVPDKIKX0DER" : null,
    disposition: "IN_SCOPE",
    decision: {
      authority: "OWNER",
      decisionId: `${channel}-decision-1`,
      decidedBy: "Vladimir",
      decidedAt: "2026-07-19T11:00:00.000Z",
      reason: "Consumer readiness fixture",
    },
    report: {
      reportType: channel === "amazon"
        ? "GET_MERCHANT_LISTINGS_ALL_DATA"
        : "ITEM_CATALOG",
      reportId: `${channel}-report-1`,
      capturedAt: "2026-07-19T11:30:00.000Z",
      expectedRowCount: parsePhase1DelimitedText(content).rows.length,
      expectedContentSha256: sha256Hex(content),
    },
  };
}

function manifest() {
  const result = buildPhase1ScopeManifest({
    asOf: AS_OF,
    connectedStoreCensus: makeTestConnectedStoreCensus({
      asOf: AS_OF,
      identityStyle: "index",
    }),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        disposition("amazon", amazonReport),
        disposition("walmart", walmartReport),
      ],
    },
    reports: [
      {
        channel: "amazon",
        scopeKey: "store1",
        sourceName: "amazon.tsv",
        content: amazonReport,
      },
      {
        channel: "walmart",
        scopeKey: "store1",
        sourceName: "walmart.csv",
        content: walmartReport,
      },
    ],
  });
  assert.equal(result.authoritative, true);
  return result;
}

function snapshot(input: {
  channel: "amazon" | "walmart";
  sku: string;
  contentReady: boolean;
  economicsStatus: ProductTruthCostStatus;
  procurementReady: boolean;
  blockerOrder?: string[];
}): ProductTruthSnapshot {
  const listingKey = `${input.channel}:1:${input.sku}`;
  const blockers = input.contentReady
    ? []
    : input.blockerOrder ?? ["CONTENT_MISSING", "IDENTITY_BLOCKED"];
  const current = input.economicsStatus === "FACT"
    || input.economicsStatus === "ESTIMATE"
    || input.economicsStatus === "UNSOURCEABLE"
    ? {
        id: `cost-${input.sku}`,
        observationKey: "c".repeat(64),
        recipeHash: "d".repeat(64),
        sku: input.sku,
        effectiveDate: AS_OF,
        createdAt: AS_OF,
        source: "retail:batch",
        productCost: input.economicsStatus === "UNSOURCEABLE" ? null : 2,
        packagingCost: null,
        iceCost: null,
        totalCost: input.economicsStatus === "UNSOURCEABLE" ? null : 2,
        costPerUnit: input.economicsStatus === "UNSOURCEABLE" ? null : 2,
        packSize: input.economicsStatus === "UNSOURCEABLE" ? null : 1,
        currency: "USD",
        needsReview: input.economicsStatus !== "FACT",
        matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        pricePolicyVersion: "price-evidence-eligibility/1.0.0",
        evidenceOutcome: input.economicsStatus,
        evidence: {},
        runId: "run-1",
        approvalId: "approval-1",
        componentProvenance: [],
      } as ProductTruthSnapshot["views"]["unitEconomics"]["current"]
    : null;
  const economicsBlockers = input.economicsStatus === "MISSING"
    ? ["CURRENT_SCOPED_SKU_COST_MISSING"]
    : input.economicsStatus === "INVALID"
      ? ["COST_EVIDENCE_INVALID"]
      : [];
  return {
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    snapshot: {
      channel: input.channel,
      storeIndex: 1,
      sku: input.sku,
      listingKey,
      asOf: AS_OF,
      maxPriceAgeMs: MAX_PRICE_AGE_MS,
      skuCostId: current?.id ?? null,
    },
    recipe: { components: [], blockers },
    views: {
      bundleFactory: {
        consumer: "BUNDLE_FACTORY",
        ready: input.contentReady,
        components: [],
        blockers,
      },
      listingImprovement: {
        consumer: "LISTING_IMPROVEMENT",
        ready: input.contentReady,
        components: [],
        blockers,
      },
      unitEconomics: {
        consumer: "UNIT_ECONOMICS",
        status: input.economicsStatus,
        current,
        factualCost: input.economicsStatus === "FACT" ? current : null,
        estimatedCost: input.economicsStatus === "ESTIMATE" ? current : null,
        blockers: economicsBlockers,
      },
      procurement: {
        consumer: "PROCUREMENT",
        ready: input.procurementReady,
        components: [],
        blockers: input.procurementReady ? [] : ["NO_CURRENT_ELIGIBLE_LOCAL_PRICE"],
      },
    },
  };
}

function compile(snapshots: ProductTruthSnapshot[]) {
  const scope = manifest();
  const manifestJson = renderPhase1ScopeManifestJson(scope);
  return compileProductTruthConsumerReadiness({
    manifest: scope,
    manifestJson,
    expectedManifestSha256: sha256Hex(manifestJson),
    databaseTargetFingerprint: TARGET,
    capturedAt: CAPTURED_AT,
    asOf: AS_OF,
    maxPriceAgeMs: MAX_PRICE_AGE_MS,
    snapshots,
  });
}

test("reconciles the exact manifest denominator across all four consumers", () => {
  const report = compile([
    snapshot({
      channel: "amazon",
      sku: "AMZ-1",
      contentReady: true,
      economicsStatus: "FACT",
      procurementReady: true,
    }),
    snapshot({
      channel: "walmart",
      sku: "WM-1",
      contentReady: false,
      economicsStatus: "UNSOURCEABLE",
      procurementReady: false,
    }),
  ]);
  assert.equal(report.counts.denominator, 2);
  assert.equal(report.counts.reconciled, 2);
  assert.deepEqual(report.counts.bundleFactory, { ready: 1, blocked: 1 });
  assert.deepEqual(report.counts.listingImprovement, { ready: 1, blocked: 1 });
  assert.deepEqual(report.counts.unitEconomics, {
    ready: 1,
    blocked: 1,
    fact: 1,
    estimate: 0,
    unsourceable: 1,
    missing: 0,
    invalid: 0,
  });
  assert.deepEqual(report.counts.procurement, { ready: 1, blocked: 1 });
  assert.deepEqual(report.dataReadyConsumers, []);
  assert.equal(report.claims.ownerActivationGranted, false);
  assert.equal(report.claims.consumerCutoverClaimed, false);
  assert.match(report.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(renderProductTruthConsumerReadinessJson(report)).payloadSha256,
    report.payloadSha256);
});

test("readiness binds exact view bytes and keeps ESTIMATE typed as economics-only", () => {
  const first = compile([
    snapshot({
      channel: "amazon",
      sku: "AMZ-1",
      contentReady: true,
      economicsStatus: "FACT",
      procurementReady: true,
    }),
    snapshot({
      channel: "walmart",
      sku: "WM-1",
      contentReady: false,
      economicsStatus: "ESTIMATE",
      procurementReady: false,
      blockerOrder: ["IDENTITY_BLOCKED", "CONTENT_MISSING"],
    }),
  ]);
  const second = compile([
    snapshot({
      channel: "amazon",
      sku: "AMZ-1",
      contentReady: true,
      economicsStatus: "FACT",
      procurementReady: true,
    }),
    snapshot({
      channel: "walmart",
      sku: "WM-1",
      contentReady: false,
      economicsStatus: "ESTIMATE",
      procurementReady: false,
      blockerOrder: ["IDENTITY_BLOCKED", "CONTENT_MISSING"],
    }),
  ]);
  assert.equal(first.payloadSha256, second.payloadSha256);
  const changedViewBytes = compile([
    snapshot({
      channel: "amazon",
      sku: "AMZ-1",
      contentReady: true,
      economicsStatus: "FACT",
      procurementReady: true,
    }),
    snapshot({
      channel: "walmart",
      sku: "WM-1",
      contentReady: false,
      economicsStatus: "ESTIMATE",
      procurementReady: false,
      blockerOrder: ["CONTENT_MISSING", "IDENTITY_BLOCKED"],
    }),
  ]);
  assert.notEqual(first.payloadSha256, changedViewBytes.payloadSha256);
  assert.deepEqual(
    first.entries[1].consumers.bundleFactory.blockers,
    ["CONTENT_MISSING", "IDENTITY_BLOCKED"],
  );
  assert.equal(first.counts.unitEconomics.ready, 2);
  assert.equal(first.counts.unitEconomics.estimate, 1);
  assert.equal(first.counts.procurement.blocked, 1);
  assert.deepEqual(first.dataReadyConsumers, ["UNIT_ECONOMICS"]);
});

test("tampered manifest and snapshot bindings fail closed", () => {
  const scope = manifest();
  const manifestJson = renderPhase1ScopeManifestJson(scope);
  const exactSnapshots = [
    snapshot({
      channel: "amazon",
      sku: "AMZ-1",
      contentReady: true,
      economicsStatus: "FACT",
      procurementReady: true,
    }),
    snapshot({
      channel: "walmart",
      sku: "WM-1",
      contentReady: true,
      economicsStatus: "FACT",
      procurementReady: true,
    }),
  ];
  const tampered = structuredClone(scope);
  tampered.policy.requiredScopesSha256 = "a".repeat(64);
  assert.throws(
    () => compileProductTruthConsumerReadiness({
      manifest: tampered,
      manifestJson: renderPhase1ScopeManifestJson(tampered),
      expectedManifestSha256: sha256Hex(renderPhase1ScopeManifestJson(tampered)),
      databaseTargetFingerprint: TARGET,
      capturedAt: CAPTURED_AT,
      asOf: AS_OF,
      maxPriceAgeMs: MAX_PRICE_AGE_MS,
      snapshots: exactSnapshots,
    }),
    (error) => error instanceof ProductTruthConsumerReadinessError
      && error.code === "READINESS_MANIFEST_INVALID",
  );

  const wrong = structuredClone(exactSnapshots);
  wrong[0].snapshot.listingKey = "amazon:1:OTHER";
  assert.throws(
    () => compileProductTruthConsumerReadiness({
      manifest: scope,
      manifestJson,
      expectedManifestSha256: sha256Hex(manifestJson),
      databaseTargetFingerprint: TARGET,
      capturedAt: CAPTURED_AT,
      asOf: AS_OF,
      maxPriceAgeMs: MAX_PRICE_AGE_MS,
      snapshots: wrong,
    }),
    (error) => error instanceof ProductTruthConsumerReadinessError
      && error.code === "READINESS_SNAPSHOT_INVALID",
  );
});

test("readiness source has no writer, provider, or consumer activation path", async () => {
  const source = await readFile(
    new URL("../product-truth-consumer-readiness.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
  assert.doesNotMatch(source, /\bfetch\s*\(|retail-fetch|oxylabs|unwrangle|bluecart/i);
  assert.doesNotMatch(source, /buildProductTruthConsumerActivation|validateProductTruthConsumerActivation/);
  assert.match(source, /ownerActivationGranted:\s*false/);
  assert.match(source, /consumerCutoverClaimed:\s*false/);
});
