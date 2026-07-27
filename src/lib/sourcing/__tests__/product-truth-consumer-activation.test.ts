import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_CONSUMERS,
  PRODUCT_TRUTH_CONSUMER_ACTIVATION_VERSION,
  ProductTruthConsumerActivationError,
  buildProductTruthConsumerActivation,
  expectedProductTruthConsumerActivationConfirmation,
  parseProductTruthConsumerActivation,
  productTruthConsumerActivationSha256,
  productTruthConsumerEffectiveMode,
  renderProductTruthConsumerActivationJson,
  validateProductTruthConsumerActivation,
  type BuildProductTruthConsumerActivationInput,
  type ProductTruthConsumerActivation,
  type ProductTruthConsumerRuntimeBinding,
} from "../product-truth-consumer-activation";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "../product-truth-read-contract-version";

const ISSUED_AT = "2026-07-19T12:00:00.000Z";
const EXPIRES_AT = "2026-07-20T12:00:00.000Z";
const NOW = "2026-07-19T12:05:00.000Z";
const MANIFEST_SHA256 = "a".repeat(64);
const DATABASE_TARGET_FINGERPRINT = "b".repeat(64);

function buildInput(
  overrides: Partial<BuildProductTruthConsumerActivationInput> = {},
): BuildProductTruthConsumerActivationInput {
  return {
    approvalId: "owner-product-truth-cutover-20260719-a",
    mode: "SHADOW",
    authoritativeManifestSha256: MANIFEST_SHA256,
    databaseTargetFingerprint: DATABASE_TARGET_FINGERPRINT,
    consumers: ["BUNDLE_FACTORY", "UNIT_ECONOMICS"],
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    maxPriceAgeMs: 24 * 60 * 60 * 1_000,
    maxListingsPerBatch: 100,
    ...overrides,
  };
}

function runtimeBinding(
  activation: ProductTruthConsumerActivation,
  overrides: Partial<ProductTruthConsumerRuntimeBinding> = {},
): ProductTruthConsumerRuntimeBinding {
  return {
    mode: activation.mode,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    authoritativeManifestSha256: activation.authoritativeManifestSha256,
    databaseTargetFingerprint: activation.databaseTargetFingerprint,
    consumers: activation.consumers,
    maxPriceAgeMs: activation.readPolicy.maxPriceAgeMs,
    maxListingsPerBatch: activation.readPolicy.batch.maxListingsPerBatch,
    ...overrides,
  };
}

function validate(
  activation: ProductTruthConsumerActivation,
  overrides: {
    activationSha256?: string;
    confirmation?: string;
    runtimeBinding?: ProductTruthConsumerRuntimeBinding;
    now?: string;
  } = {},
) {
  const activationSha256 = overrides.activationSha256
    ?? productTruthConsumerActivationSha256(activation);
  return validateProductTruthConsumerActivation({
    activation,
    activationSha256,
    confirmation: overrides.confirmation
      ?? expectedProductTruthConsumerActivationConfirmation(
        activationSha256,
        activation.ownerApproval.approvalId,
        activation.mode,
      ),
    runtimeBinding: overrides.runtimeBinding ?? runtimeBinding(activation),
    now: overrides.now ?? NOW,
  });
}

function clone(value: ProductTruthConsumerActivation): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function code(error: unknown): string | undefined {
  return error instanceof ProductTruthConsumerActivationError
    ? error.code
    : undefined;
}

test("defines only the four canonical consumers and keeps OFF out of activation artifacts", () => {
  assert.deepEqual(PRODUCT_TRUTH_CONSUMERS, [
    "BUNDLE_FACTORY",
    "LISTING_IMPROVEMENT",
    "UNIT_ECONOMICS",
    "PROCUREMENT",
  ]);
  assert.equal(Object.isFrozen(PRODUCT_TRUTH_CONSUMERS), true);

  const activation = buildProductTruthConsumerActivation(buildInput());
  assert.equal(activation.schemaVersion, PRODUCT_TRUTH_CONSUMER_ACTIVATION_VERSION);
  assert.equal(activation.mode, "SHADOW");
  assert.deepEqual(activation.consumers, ["BUNDLE_FACTORY", "UNIT_ECONOMICS"]);
  assert.equal(productTruthConsumerEffectiveMode("BUNDLE_FACTORY", null), "OFF");
  assert.equal(productTruthConsumerEffectiveMode("PROCUREMENT", validate(activation)), "OFF");
  assert.equal(productTruthConsumerEffectiveMode("UNIT_ECONOMICS", validate(activation)), "SHADOW");
  assert.throws(
    () => productTruthConsumerEffectiveMode(
      "BUNDLE_FACTORY",
      { activation } as never,
    ),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );

  assert.throws(
    () => parseProductTruthConsumerActivation({ ...activation, mode: "OFF" }),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );
});

test("validates staged SHADOW and ENFORCED subsets with owner, data, and read-policy bindings", () => {
  const shadow = buildProductTruthConsumerActivation(buildInput());
  const enforced = buildProductTruthConsumerActivation(buildInput({
    approvalId: "owner-product-truth-cutover-20260719-b",
    mode: "ENFORCED",
    consumers: ["LISTING_IMPROVEMENT", "PROCUREMENT"],
  }));

  const validatedShadow = validate(shadow);
  const validatedEnforced = validate(enforced);
  assert.equal(validatedShadow.activation.ownerApproval.action, "ACTIVATE_SHADOW");
  assert.equal(validatedEnforced.activation.ownerApproval.action, "ACTIVATE_ENFORCED");
  assert.equal(productTruthConsumerEffectiveMode("PROCUREMENT", validatedEnforced), "ENFORCED");
  assert.equal(validatedEnforced.activation.readContractVersion, PRODUCT_TRUTH_READ_CONTRACT_VERSION);
  assert.deepEqual(validatedEnforced.activation.claims, {
    readOnly: true,
    databaseWrites: false,
    retailerNetworkCalls: false,
    enrichmentMutations: false,
    marketplaceMutations: false,
    procurementMutations: false,
  });
  assert.deepEqual(validatedEnforced.activation.readPolicy.batch, {
    strategy: "SET_BASED",
    maxListingsPerBatch: 100,
    maxConcurrentBatches: 1,
    allowPerListingFallback: false,
  });
  assert.equal(Object.isFrozen(validatedEnforced.activation), true);
  assert.equal(Object.isFrozen(validatedEnforced.activation.readPolicy.batch), true);
});

test("uses one deterministic canonical hash and a separate exact owner confirmation", () => {
  const activation = buildProductTruthConsumerActivation(buildInput());
  const digest = productTruthConsumerActivationSha256(activation);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(
    digest,
    productTruthConsumerActivationSha256(
      JSON.parse(renderProductTruthConsumerActivationJson(activation)),
    ),
  );
  const confirmation = expectedProductTruthConsumerActivationConfirmation(
    digest,
    activation.ownerApproval.approvalId,
    activation.mode,
  );
  assert.equal(
    confirmation,
    `ACTIVATE_PRODUCT_TRUTH_CONSUMERS_V1:SHADOW:${digest}:owner-product-truth-cutover-20260719-a`,
  );
  assert.throws(
    () => validate(activation, { confirmation: `${confirmation}:extra` }),
    (error) => code(error) === "CONSUMER_ACTIVATION_CONFIRMATION_MISMATCH",
  );
  assert.throws(
    () => validate(activation, { activationSha256: "c".repeat(64) }),
    (error) => code(error) === "CONSUMER_ACTIVATION_HASH_MISMATCH",
  );
});

test("exact-key parsing rejects extra or missing fields at every signed boundary", () => {
  const activation = buildProductTruthConsumerActivation(buildInput());
  const topExtra = { ...activation, surprise: true };
  assert.throws(
    () => parseProductTruthConsumerActivation(topExtra),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );

  const ownerExtra = clone(activation);
  (ownerExtra.ownerApproval as Record<string, unknown>).delegated = true;
  assert.throws(
    () => parseProductTruthConsumerActivation(ownerExtra),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );

  const missingClaim = clone(activation);
  delete (missingClaim.claims as Record<string, unknown>).procurementMutations;
  assert.throws(
    () => parseProductTruthConsumerActivation(missingClaim),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );

  const batchExtra = clone(activation);
  const readPolicy = batchExtra.readPolicy as Record<string, unknown>;
  (readPolicy.batch as Record<string, unknown>).implicitFallback = false;
  assert.throws(
    () => parseProductTruthConsumerActivation(batchExtra),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );
});

test("consumer subsets reject emptiness, unknown values, duplicates, and noncanonical order", () => {
  for (const consumers of [
    [],
    ["NOT_A_CONSUMER"],
    ["BUNDLE_FACTORY", "BUNDLE_FACTORY"],
    ["PROCUREMENT", "BUNDLE_FACTORY"],
  ]) {
    const activation = clone(buildProductTruthConsumerActivation(buildInput()));
    activation.consumers = consumers;
    assert.throws(
      () => parseProductTruthConsumerActivation(activation),
      (error) => code(error) === "CONSUMER_ACTIVATION_CONSUMERS_INVALID",
    );
  }
});

test("fails closed when owner identity/action or any no-mutation claim is unsafe", () => {
  const base = buildProductTruthConsumerActivation(buildInput());

  const delegated = clone(base);
  (delegated.ownerApproval as Record<string, unknown>).approvedBy = "agent";
  assert.throws(
    () => parseProductTruthConsumerActivation(delegated),
    (error) => code(error) === "CONSUMER_ACTIVATION_UNSAFE",
  );

  const wrongAction = clone(base);
  (wrongAction.ownerApproval as Record<string, unknown>).action = "ACTIVATE_ENFORCED";
  assert.throws(
    () => parseProductTruthConsumerActivation(wrongAction),
    (error) => code(error) === "CONSUMER_ACTIVATION_SCOPE_MISMATCH",
  );

  for (const [claim, unsafeValue] of [
    ["readOnly", false],
    ["databaseWrites", true],
    ["retailerNetworkCalls", true],
    ["enrichmentMutations", true],
    ["marketplaceMutations", true],
    ["procurementMutations", true],
  ] as const) {
    const unsafe = clone(base);
    (unsafe.claims as Record<string, unknown>)[claim] = unsafeValue;
    assert.throws(
      () => parseProductTruthConsumerActivation(unsafe),
      (error) => code(error) === "CONSUMER_ACTIVATION_UNSAFE",
    );
  }
});

test("fails closed on contract, manifest, database, consumer, mode, freshness, or batch mismatch", () => {
  const activation = buildProductTruthConsumerActivation(buildInput());
  const cases: ProductTruthConsumerRuntimeBinding[] = [
    runtimeBinding(activation, {
      readContractVersion: "product-truth-read-contract/0.0.0" as typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    }),
    runtimeBinding(activation, { authoritativeManifestSha256: "c".repeat(64) }),
    runtimeBinding(activation, { databaseTargetFingerprint: "d".repeat(64) }),
    runtimeBinding(activation, { consumers: ["BUNDLE_FACTORY"] }),
    runtimeBinding(activation, { mode: "ENFORCED" }),
    runtimeBinding(activation, { maxPriceAgeMs: activation.readPolicy.maxPriceAgeMs + 1 }),
    runtimeBinding(activation, { maxListingsPerBatch: 99 }),
  ];
  for (const binding of cases) {
    assert.throws(
      () => validate(activation, { runtimeBinding: binding }),
      (error) => code(error) === "CONSUMER_ACTIVATION_SCOPE_MISMATCH",
    );
  }

  const staleContract = clone(activation);
  staleContract.readContractVersion = "product-truth-read-contract/0.0.0";
  assert.throws(
    () => parseProductTruthConsumerActivation(staleContract),
    (error) => code(error) === "CONSUMER_ACTIVATION_SCOPE_MISMATCH",
  );
});

test("requires a bounded set-based policy and never permits an implicit per-listing fallback", () => {
  const base = buildProductTruthConsumerActivation(buildInput());
  for (const [field, unsafeValue] of [
    ["strategy", "PER_LISTING"],
    ["maxConcurrentBatches", 2],
    ["allowPerListingFallback", true],
  ] as const) {
    const unsafe = clone(base);
    const batch = (unsafe.readPolicy as Record<string, unknown>).batch as Record<string, unknown>;
    batch[field] = unsafeValue;
    assert.throws(
      () => parseProductTruthConsumerActivation(unsafe),
      (error) => code(error) === "CONSUMER_ACTIVATION_UNSAFE",
    );
  }
  assert.throws(
    () => buildProductTruthConsumerActivation(buildInput({ maxListingsPerBatch: 101 })),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );
  assert.throws(
    () => buildProductTruthConsumerActivation(buildInput({ maxPriceAgeMs: 0 })),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );
});

test("canonical timestamps are current only inside the owner-approved interval", () => {
  const activation = buildProductTruthConsumerActivation(buildInput());
  assert.doesNotThrow(() => validate(activation, { now: ISSUED_AT }));
  assert.throws(
    () => validate(activation, { now: EXPIRES_AT }),
    (error) => code(error) === "CONSUMER_ACTIVATION_NOT_CURRENT",
  );
  assert.throws(
    () => validate(activation, { now: "2026-07-19T11:59:59.999Z" }),
    (error) => code(error) === "CONSUMER_ACTIVATION_NOT_CURRENT",
  );
  assert.throws(
    () => buildProductTruthConsumerActivation(buildInput({ issuedAt: "2026-07-19T12:00:00Z" })),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );
  assert.throws(
    () => buildProductTruthConsumerActivation(buildInput({
      expiresAt: "2026-08-19T12:00:00.001Z",
    })),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );
});

test("digest fields are exact lowercase SHA-256 values, not normalized aliases", () => {
  assert.throws(
    () => buildProductTruthConsumerActivation(buildInput({
      authoritativeManifestSha256: MANIFEST_SHA256.toUpperCase(),
    })),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );
  assert.throws(
    () => buildProductTruthConsumerActivation(buildInput({
      databaseTargetFingerprint: "b".repeat(63),
    })),
    (error) => code(error) === "CONSUMER_ACTIVATION_INVALID",
  );
});
