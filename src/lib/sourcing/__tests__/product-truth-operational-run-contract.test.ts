import assert from "node:assert/strict";
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
  PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
  ProductTruthOperationalContractError,
  buildProductTruthOperationalPlan,
  expectedProductTruthExecutionConfirmation,
  parseProductTruthOperationalPlan,
  productTruthOperationalSha256,
  validateProductTruthOperationalApproval,
  type ProductTruthOperationalApproval,
  type ProductTruthOperationalPlan,
} from "../product-truth-operational-run-contract";

const CREATED_AT = "2026-07-19T12:00:00.000Z";
const EXPIRES_AT = "2026-07-19T13:00:00.000Z";
const NOW = "2026-07-19T12:05:00.000Z";
const TARGET_FINGERPRINT = "1".repeat(64);

const amazonReport = [
  "item-name\tseller-sku\tasin1\tstatus\tfulfillment-channel",
  "Acme One\tSHARED-SKU\tB000000001\tActive\tDEFAULT",
  "Acme Two\tAMZ-2\tB000000002\tActive\tDEFAULT",
  "Acme Three\tAMZ-3\tB000000003\tActive\tDEFAULT",
].join("\n");

const walmartReport = [
  "SKU,Item ID,Product Name,Published Status,Lifecycle Status",
  "SHARED-SKU,10001,Acme Four,Published,Active",
  "WM-2,10002,Acme Five,Published,Active",
].join("\n");

function disposition(
  channel: Phase1Channel,
  scopeKey: string,
  storeIndex: number,
  content: string,
): Phase1ScopeDispositionEntry {
  return {
    channel,
    scopeKey,
    storeIndex,
    accountId: `${channel}-account-${storeIndex}`,
    storeId: `${channel}-store-${storeIndex}`,
    marketplaceId: channel === "amazon" ? "ATVPDKIKX0DER" : null,
    disposition: "IN_SCOPE",
    decision: {
      authority: "OWNER",
      decisionId: `${channel}-decision-${storeIndex}`,
      decidedBy: "Vladimir",
      decidedAt: "2026-07-19T11:00:00.000Z",
      reason: "Operational runner contract fixture",
    },
    report: {
      reportType: channel === "amazon" ? "GET_MERCHANT_LISTINGS_ALL_DATA" : "ITEM_CATALOG",
      reportId: `${channel}-report-${storeIndex}`,
      capturedAt: "2026-07-19T11:30:00.000Z",
      expectedRowCount: parsePhase1DelimitedText(content).rows.length,
      expectedContentSha256: sha256Hex(content),
    },
  };
}

function manifest() {
  return buildPhase1ScopeManifest({
    asOf: CREATED_AT,
    connectedStoreCensus: makeTestConnectedStoreCensus({
      asOf: CREATED_AT,
      identityStyle: "index",
    }),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        disposition("amazon", "store1", 1, amazonReport),
        disposition("walmart", "store1", 1, walmartReport),
      ],
    },
    reports: [
      { channel: "amazon", scopeKey: "store1", sourceName: "amazon.tsv", content: amazonReport },
      { channel: "walmart", scopeKey: "store1", sourceName: "walmart.csv", content: walmartReport },
    ],
  });
}

function buildPlan(overrides: Partial<Parameters<typeof buildProductTruthOperationalPlan>[0]> = {}) {
  const scope = manifest();
  assert.equal(scope.authoritative, true);
  return buildProductTruthOperationalPlan({
    runId: "product-truth-canary-20260719-a",
    mode: "CANARY",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    targetFingerprint: TARGET_FINGERPRINT,
    manifest: scope,
    manifestSha256: sha256Hex(renderPhase1ScopeManifestJson(scope)),
    listingKeys: scope.listings.map((listing) => listing.listingKey),
    sourcePolicy: {
      procurementZip: "33765",
      retailers: ["walmart", "target", "publix"],
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
        maxCalls: 5,
        maxUnits: 5,
        reserveFloor: null,
      },
      {
        provider: "unwrangle",
        operations: ["detail", "search"],
        maxCalls: 10,
        maxUnits: 20,
        reserveFloor: 1_000,
      },
    ],
    verificationPolicy: {
      maxPriceAgeMs: 24 * 60 * 60 * 1_000,
      minGalleryImages: 5,
    },
    maxWallClockMs: 30 * 60 * 1_000,
    ...overrides,
  });
}

function approval(plan: ProductTruthOperationalPlan): ProductTruthOperationalApproval {
  const planSha256 = productTruthOperationalSha256(plan);
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
    approvedBy: "owner",
    runId: plan.runId,
    approvalId: "owner-approval-20260719-a",
    action: "EXECUTE_CANARY",
    planSha256,
    targetFingerprint: plan.targetFingerprint,
    issuedAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    meteredPermit: {
      version: 1,
      runId: plan.runId,
      approvalId: "owner-approval-20260719-a",
      approvedBy: "owner",
      issuedAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      providers: {
        oxylabs: { operations: ["query"], maxCalls: 5, maxUnits: 5 },
        unwrangle: { operations: ["detail", "search"], maxCalls: 10, maxUnits: 20 },
      },
    },
    balanceEvidence: [{
      provider: "unwrangle",
      observedAt: "2026-07-19T12:04:00.000Z",
      balanceUnits: 1_100,
      reserveFloor: 1_000,
      evidenceSha256: "2".repeat(64),
    }],
  };
}

function code(error: unknown): string | undefined {
  return error instanceof ProductTruthOperationalContractError ? error.code : undefined;
}

test("seals five exact listing scopes without merging a cross-channel raw SKU", () => {
  const plan = buildPlan();
  assert.equal(plan.targets.length, 5);
  assert.deepEqual(
    plan.targets.filter((target) => target.sku === "SHARED-SKU").map((target) => target.listingKey),
    ["amazon:1:SHARED-SKU", "walmart:1:SHARED-SKU"],
  );
  assert.equal(new Set(plan.targets.map((target) => target.listingKey)).size, 5);
  assert.equal(plan.sourcePolicy.allowClubs, false);
  assert.deepEqual(plan.targets[0].requestedFields, ["identity", "offers", "content", "cogs"]);
  assert.match(productTruthOperationalSha256(plan), /^[a-f0-9]{64}$/);
  assert.equal(productTruthOperationalSha256(plan), productTruthOperationalSha256(buildPlan()));
});

test("rejects an incomplete canary, a non-authoritative manifest, and manifest tampering", () => {
  const scope = manifest();
  assert.throws(
    () => buildPlan({ listingKeys: scope.listings.slice(0, 4).map((listing) => listing.listingKey) }),
    (error) => code(error) === "OPERATIONAL_SCOPE_INVALID",
  );
  assert.throws(
    () => buildPlan({ manifest: { ...scope, authoritative: false } }),
    (error) => code(error) === "MANIFEST_NOT_AUTHORITATIVE",
  );
  assert.throws(
    () => buildPlan({ manifestSha256: "0".repeat(64) }),
    (error) => code(error) === "MANIFEST_HASH_MISMATCH",
  );
});

test("clubs, BJ's, ambient concurrency, and unsafe attempt policies fail closed", () => {
  const sourcePolicy = buildPlan().sourcePolicy;
  assert.throws(
    () => buildPlan({ sourcePolicy: { ...sourcePolicy, retailers: ["walmart", "samsclub"], allowClubs: false } }),
    (error) => code(error) === "CLUBS_NOT_AUTHORIZED",
  );
  assert.throws(
    () => buildPlan({ sourcePolicy: { ...sourcePolicy, allowBjs: true as false } }),
    (error) => code(error) === "BJS_FORBIDDEN",
  );
  assert.throws(
    () => buildPlan({ sourcePolicy: { ...sourcePolicy, componentConcurrency: 2 as 1 } }),
    (error) => code(error) === "CONCURRENCY_UNSAFE",
  );
  assert.throws(
    () => buildPlan({ sourcePolicy: { ...sourcePolicy, maxAttemptsPerListing: 2 as 1 } }),
    (error) => code(error) === "ATTEMPT_POLICY_UNSAFE",
  );
});

test("owner approval is byte-bound to plan, target, exact permit ceilings, and confirmation", () => {
  const plan = buildPlan();
  const sealed = approval(plan);
  const planSha256 = productTruthOperationalSha256(plan);
  const confirmation = expectedProductTruthExecutionConfirmation(planSha256, sealed.approvalId);
  const validated = validateProductTruthOperationalApproval({
    plan,
    planSha256,
    approval: sealed,
    executionConfirmation: confirmation,
    now: NOW,
  });
  assert.equal(validated.permit.runId, plan.runId);
  assert.equal(validated.executionConfirmation, confirmation);
  assert.match(validated.encodedPermit, /^[A-Za-z0-9_-]+$/);

  assert.throws(
    () => validateProductTruthOperationalApproval({
      plan,
      planSha256,
      approval: sealed,
      executionConfirmation: `${confirmation}-wrong`,
      now: NOW,
    }),
    (error) => code(error) === "APPROVAL_CONFIRMATION_MISMATCH",
  );
  const broader = structuredClone(sealed);
  broader.meteredPermit.providers.unwrangle!.maxCalls += 1;
  assert.throws(
    () => validateProductTruthOperationalApproval({
      plan,
      planSha256,
      approval: broader,
      executionConfirmation: confirmation,
      now: NOW,
    }),
    (error) => code(error) === "APPROVAL_PERMIT_MISMATCH",
  );
});

test("serialized plans cannot bypass exact fields, provider routes, or target hashes", () => {
  const plan = buildPlan();
  assert.deepEqual(parseProductTruthOperationalPlan(structuredClone(plan)), plan);

  const missingField = structuredClone(plan) as ProductTruthOperationalPlan & {
    targets: Array<ProductTruthOperationalPlan["targets"][number]>;
  };
  missingField.targets[0] = {
    ...missingField.targets[0],
    requestedFields: ["identity", "offers", "cogs"],
  } as ProductTruthOperationalPlan["targets"][number];
  assert.throws(
    () => parseProductTruthOperationalPlan(missingField),
    (error) => code(error) === "OPERATIONAL_SCOPE_INVALID",
  );

  assert.throws(
    () => buildPlan({
      providerCeilings: [{
        provider: "bluecart",
        operations: ["search"],
        maxCalls: 1,
        maxUnits: 1,
        reserveFloor: null,
      }],
    }),
    (error) => code(error) === "PROVIDER_ROUTE_FORBIDDEN",
  );
});

test("unknown, stale, or floor-breaching Unwrangle balance stops before execution", () => {
  const plan = buildPlan();
  const planSha256 = productTruthOperationalSha256(plan);
  const base = approval(plan);
  const confirmation = expectedProductTruthExecutionConfirmation(planSha256, base.approvalId);

  for (const [mutate, expected] of [
    [(value: ProductTruthOperationalApproval) => { value.balanceEvidence = []; }, "BALANCE_EVIDENCE_REQUIRED"],
    [(value: ProductTruthOperationalApproval) => { value.balanceEvidence[0].observedAt = "2026-07-19T11:00:00.000Z"; }, "BALANCE_EVIDENCE_STALE"],
    [(value: ProductTruthOperationalApproval) => { value.balanceEvidence[0].balanceUnits = 1_019; }, "BALANCE_FLOOR_EXCEEDED"],
  ] as const) {
    const candidate = structuredClone(base);
    mutate(candidate);
    assert.throws(
      () => validateProductTruthOperationalApproval({
        plan,
        planSha256,
        approval: candidate,
        executionConfirmation: confirmation,
        now: NOW,
      }),
      (error) => code(error) === expected,
    );
  }
});
