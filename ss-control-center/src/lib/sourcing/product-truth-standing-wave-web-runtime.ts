import {
  expectedProductTruthWebControlConfirmation,
  loadProductTruthWebControlRuntime,
  type ProductTruthWebControlRuntimeActive,
} from "./product-truth-web-control-runtime";
import {
  PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS,
  PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
} from "./product-truth-standing-wave";
import {
  PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS,
} from "./product-truth-standing-wave-web-contract";

export const PRODUCT_TRUTH_STANDING_WAVE_WEB_RUNTIME_VERSION =
  "product-truth-standing-wave-web-runtime/1.0.0" as const;

export const PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV = Object.freeze({
  enabled: "PRODUCT_TRUTH_STANDING_WAVE_WEB_ENABLED",
  confirmation: "PRODUCT_TRUTH_STANDING_WAVE_WEB_CONFIRMATION",
  standingProviderPolicySha256:
    "PRODUCT_TRUTH_STANDING_WAVE_PROVIDER_POLICY_SHA256",
  standingNoPaidPolicySha256:
    "PRODUCT_TRUTH_STANDING_WAVE_NO_PAID_POLICY_SHA256",
} as const);

type RuntimeEnvironment = Record<string, string | undefined>;

export interface ProductTruthStandingWaveWebRuntimeOff {
  schemaVersion: typeof PRODUCT_TRUTH_STANDING_WAVE_WEB_RUNTIME_VERSION;
  status: "OFF";
  reason: "NO_STANDING_WAVE_ACTIVATION_CONFIGURED";
}

export interface ProductTruthStandingWaveWebRuntimeActive {
  schemaVersion: typeof PRODUCT_TRUTH_STANDING_WAVE_WEB_RUNTIME_VERSION;
  status: "ACTIVE";
  base: ProductTruthWebControlRuntimeActive;
  standingProviderPolicySha256: string;
  standingNoPaidPolicySha256: string;
  limits: {
    maxTargets: typeof PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS;
    maxLinkedListings: typeof PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS;
    maxProviderUnits: typeof PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS;
    concurrency: 1;
    retries: 0;
  };
  claims: {
    standingPolicyAuthority: true;
    ownerPromptRequired: false;
    durableAdmission: true;
    workerClaims: true;
    processSpawnInWebRuntime: false;
    providerCallsInWebRuntime: false;
    marketplaceMutations: false;
  };
}

export type ProductTruthStandingWaveWebRuntime =
  | ProductTruthStandingWaveWebRuntimeOff
  | ProductTruthStandingWaveWebRuntimeActive;

export class ProductTruthStandingWaveWebRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthStandingWaveWebRuntimeError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthStandingWaveWebRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactSha(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("STANDING_WAVE_WEB_CONFIG_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

export function expectedProductTruthStandingWaveWebConfirmation(input: {
  base: ProductTruthWebControlRuntimeActive;
  standingProviderPolicySha256: string;
  standingNoPaidPolicySha256: string;
}): string {
  return [
    "ENABLE_PRODUCT_TRUTH_STANDING_WAVES",
    input.base.engine.releaseId,
    input.base.engine.commitSha,
    input.base.engine.treeSha,
    input.base.engine.executableTreeSha256,
    input.base.target.databaseTargetFingerprint,
    input.base.target.manifestSha256,
    exactSha(
      input.standingProviderPolicySha256,
      "standingProviderPolicySha256",
    ),
    exactSha(
      input.standingNoPaidPolicySha256,
      "standingNoPaidPolicySha256",
    ),
    `${PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS}_TARGETS`,
    `${PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS}_MAX_UNITS`,
    "CONCURRENCY_1",
    "RETRY_0",
  ].join(":");
}

export function loadProductTruthStandingWaveWebRuntime(input: {
  env?: RuntimeEnvironment;
} = {}): ProductTruthStandingWaveWebRuntime {
  const env = input.env ?? process.env;
  const configured = Object.values(PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV)
    .filter((name) => env[name] !== undefined);
  if (configured.length === 0) {
    return {
      schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_RUNTIME_VERSION,
      status: "OFF",
      reason: "NO_STANDING_WAVE_ACTIVATION_CONFIGURED",
    };
  }
  if (configured.length !== Object.keys(PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV).length) {
    fail(
      "STANDING_WAVE_WEB_CONFIG_INCOMPLETE",
      "standing-wave activation is partial",
    );
  }
  if (env[PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.enabled] !== "1") {
    fail("STANDING_WAVE_WEB_CONFIG_INVALID", "standing-wave enabled flag must be 1");
  }
  let base;
  try {
    base = loadProductTruthWebControlRuntime({ env });
  } catch (error) {
    fail(
      "STANDING_WAVE_WEB_BASE_RUNTIME_INVALID",
      "base Product Truth web control is not valid",
      error,
    );
  }
  if (
    base.status !== "ACTIVE"
    || base.stage !== "PRODUCTION_READ_ONLY"
    || !base.claims.workerClaims
    || base.workerTokenSha256 === null
    || base.target.environment !== "PRODUCTION"
  ) {
    fail(
      "STANDING_WAVE_WEB_BASE_RUNTIME_INVALID",
      "standing waves require the pinned production worker base runtime",
    );
  }
  const standingProviderPolicySha256 = exactSha(
    env[PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.standingProviderPolicySha256],
    PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.standingProviderPolicySha256,
  );
  const standingNoPaidPolicySha256 = exactSha(
    env[PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.standingNoPaidPolicySha256],
    PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.standingNoPaidPolicySha256,
  );
  const expectedConfirmation = expectedProductTruthStandingWaveWebConfirmation({
    base,
    standingProviderPolicySha256,
    standingNoPaidPolicySha256,
  });
  if (
    env[PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.confirmation]
    !== expectedConfirmation
  ) {
    fail(
      "STANDING_WAVE_WEB_CONFIRMATION_INVALID",
      "activation confirmation differs from exact release/target/policies/ceilings",
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_RUNTIME_VERSION,
    status: "ACTIVE",
    base,
    standingProviderPolicySha256,
    standingNoPaidPolicySha256,
    limits: {
      maxTargets: PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
      maxLinkedListings: PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS,
      maxProviderUnits: PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS,
      concurrency: 1,
      retries: 0,
    },
    claims: {
      standingPolicyAuthority: true,
      ownerPromptRequired: false,
      durableAdmission: true,
      workerClaims: true,
      processSpawnInWebRuntime: false,
      providerCallsInWebRuntime: false,
      marketplaceMutations: false,
    },
  };
}

export function productTruthStandingWaveWebPublicStatus(
  runtime: ProductTruthStandingWaveWebRuntime,
) {
  return runtime.status === "OFF"
    ? {
        status: "OFF" as const,
        reason: runtime.reason,
        standing_authority: false,
        worker_claims: false,
        metered_execution: false,
        provider_calls_from_web: false,
        marketplace_mutations: false,
      }
    : {
        status: "ACTIVE" as const,
        standing_authority: true,
        worker_claims: true,
        metered_execution: true,
        provider_calls_from_web: false,
        marketplace_mutations: false,
        limits: runtime.limits,
      };
}

export function productTruthStandingWaveBaseConfirmationForEnv(
  env: RuntimeEnvironment,
): string | null {
  const releaseId = env.PRODUCT_TRUTH_WEB_CONTROL_RELEASE_ID;
  const commitSha = env.PRODUCT_TRUTH_WEB_CONTROL_COMMIT_SHA;
  const treeSha = env.PRODUCT_TRUTH_WEB_CONTROL_TREE_SHA;
  const executableTreeSha256 =
    env.PRODUCT_TRUTH_WEB_CONTROL_EXECUTABLE_TREE_SHA256;
  const databaseTargetFingerprint =
    env.PRODUCT_TRUTH_WEB_CONTROL_DATABASE_TARGET_FINGERPRINT;
  const manifestSha256 = env.PRODUCT_TRUTH_WEB_CONTROL_MANIFEST_SHA256;
  if (
    !releaseId
    || !commitSha
    || !treeSha
    || !executableTreeSha256
    || !databaseTargetFingerprint
    || !manifestSha256
  ) return null;
  return expectedProductTruthWebControlConfirmation({
    stage: "PRODUCTION_READ_ONLY",
    releaseId,
    commitSha,
    treeSha,
    executableTreeSha256,
    databaseTargetFingerprint,
    manifestSha256,
  });
}
