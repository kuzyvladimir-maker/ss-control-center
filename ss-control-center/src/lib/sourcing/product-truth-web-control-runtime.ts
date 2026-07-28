import {
  PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
  type ProductTruthControlEnvironment,
} from "./product-truth-control-plane";

export const PRODUCT_TRUTH_WEB_CONTROL_RUNTIME_VERSION =
  "product-truth-web-control-runtime/1.0.0" as const;

export const PRODUCT_TRUTH_WEB_CONTROL_ENV = Object.freeze({
  stage: "PRODUCT_TRUTH_WEB_CONTROL_STAGE",
  confirmation: "PRODUCT_TRUTH_WEB_CONTROL_CONFIRMATION",
  releaseId: "PRODUCT_TRUTH_WEB_CONTROL_RELEASE_ID",
  commitSha: "PRODUCT_TRUTH_WEB_CONTROL_COMMIT_SHA",
  treeSha: "PRODUCT_TRUTH_WEB_CONTROL_TREE_SHA",
  executableTreeSha256: "PRODUCT_TRUTH_WEB_CONTROL_EXECUTABLE_TREE_SHA256",
  environment: "PRODUCT_TRUTH_WEB_CONTROL_ENVIRONMENT",
  databaseTargetFingerprint:
    "PRODUCT_TRUTH_WEB_CONTROL_DATABASE_TARGET_FINGERPRINT",
  manifestSha256: "PRODUCT_TRUTH_WEB_CONTROL_MANIFEST_SHA256",
  unwrangleReserveFloor:
    "PRODUCT_TRUTH_WEB_CONTROL_UNWRANGLE_RESERVE_FLOOR",
  workerTokenSha256: "PRODUCT_TRUTH_WEB_CONTROL_WORKER_TOKEN_SHA256",
} as const);

export type ProductTruthWebControlActiveStage =
  | "ADMISSION_ONLY"
  | "LOCAL_NO_SPEND"
  | "PRODUCTION_READ_ONLY";

type RuntimeEnvironment = Record<string, string | undefined>;

export interface ProductTruthWebControlRuntimeOff {
  schemaVersion: typeof PRODUCT_TRUTH_WEB_CONTROL_RUNTIME_VERSION;
  status: "OFF";
  reason: "NO_ACTIVATION_CONFIGURED";
  claims: {
    databaseReads: false;
    databaseWrites: false;
    workerClaims: false;
    processSpawn: false;
    providerCalls: false;
    marketplaceMutations: false;
  };
}

export interface ProductTruthWebControlRuntimeActive {
  schemaVersion: typeof PRODUCT_TRUTH_WEB_CONTROL_RUNTIME_VERSION;
  status: "ACTIVE";
  stage: ProductTruthWebControlActiveStage;
  engine: {
    commandSchemaVersion: typeof PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA;
    releaseId: string;
    commitSha: string;
    treeSha: string;
    executableTreeSha256: string;
  };
  target: {
    environment: ProductTruthControlEnvironment;
    databaseTargetFingerprint: string;
    manifestSha256: string;
  };
  unwrangleReserveFloor: number;
  workerTokenSha256: string | null;
  claims: {
    commandAdmission: true;
    controlDatabaseWrites: true;
    workerClaims: boolean;
    processSpawnInWebRuntime: false;
    providerCallsInWebRuntime: false;
    marketplaceMutations: false;
    meteredExecutionAdmission: false;
  };
}

export type ProductTruthWebControlRuntime =
  | ProductTruthWebControlRuntimeOff
  | ProductTruthWebControlRuntimeActive;

export class ProductTruthWebControlRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthWebControlRuntimeError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthWebControlRuntimeError(code, message);
}

function exactEnv(env: RuntimeEnvironment, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail("WEB_CONTROL_CONFIG_INCOMPLETE", `${name} is required as exact text`);
  }
  return value;
}

function exactSha(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    fail("WEB_CONTROL_CONFIG_INVALID", `${name} must be lowercase SHA-256`);
  }
  return value;
}

function exactGitSha(value: string, name: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    fail("WEB_CONTROL_CONFIG_INVALID", `${name} must be a 40-character Git SHA`);
  }
  return value;
}

function exactToken(value: string, name: string): string {
  if (
    value.length < 8
    || value.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  ) {
    fail("WEB_CONTROL_CONFIG_INVALID", `${name} must be a safe token`);
  }
  return value;
}

function exactReserveFloor(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    fail(
      "WEB_CONTROL_CONFIG_INVALID",
      `${PRODUCT_TRUTH_WEB_CONTROL_ENV.unwrangleReserveFloor} must be a non-negative decimal`,
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(
      "WEB_CONTROL_CONFIG_INVALID",
      `${PRODUCT_TRUTH_WEB_CONTROL_ENV.unwrangleReserveFloor} is invalid`,
    );
  }
  return parsed;
}

function configuredKeys(env: RuntimeEnvironment): string[] {
  return Object.values(PRODUCT_TRUTH_WEB_CONTROL_ENV).filter(
    (name) => env[name] !== undefined,
  );
}

export function expectedProductTruthWebControlConfirmation(input: {
  stage: ProductTruthWebControlActiveStage;
  releaseId: string;
  databaseTargetFingerprint: string;
  manifestSha256: string;
}): string {
  return [
    "ENABLE_PRODUCT_TRUTH_WEB_CONTROL",
    input.stage,
    exactToken(input.releaseId, "releaseId"),
    exactSha(input.databaseTargetFingerprint, "databaseTargetFingerprint"),
    exactSha(input.manifestSha256, "manifestSha256"),
  ].join(":");
}

export function loadProductTruthWebControlRuntime(input: {
  env?: RuntimeEnvironment;
} = {}): ProductTruthWebControlRuntime {
  const env = input.env ?? process.env;
  if (configuredKeys(env).length === 0) {
    return {
      schemaVersion: PRODUCT_TRUTH_WEB_CONTROL_RUNTIME_VERSION,
      status: "OFF",
      reason: "NO_ACTIVATION_CONFIGURED",
      claims: {
        databaseReads: false,
        databaseWrites: false,
        workerClaims: false,
        processSpawn: false,
        providerCalls: false,
        marketplaceMutations: false,
      },
    };
  }

  const stage = exactEnv(env, PRODUCT_TRUTH_WEB_CONTROL_ENV.stage);
  if (
    stage !== "ADMISSION_ONLY"
    && stage !== "LOCAL_NO_SPEND"
    && stage !== "PRODUCTION_READ_ONLY"
  ) {
    fail(
      "WEB_CONTROL_STAGE_INVALID",
      "stage must be ADMISSION_ONLY, LOCAL_NO_SPEND, or PRODUCTION_READ_ONLY",
    );
  }
  const environment = exactEnv(
    env,
    PRODUCT_TRUTH_WEB_CONTROL_ENV.environment,
  );
  if (!["LOCAL", "STAGING", "PRODUCTION"].includes(environment)) {
    fail("WEB_CONTROL_CONFIG_INVALID", "environment is unsupported");
  }
  if (stage === "LOCAL_NO_SPEND" && environment !== "LOCAL") {
    fail(
      "WEB_CONTROL_STAGE_TARGET_MISMATCH",
      "LOCAL_NO_SPEND is restricted to a LOCAL target",
    );
  }
  if (stage === "PRODUCTION_READ_ONLY" && environment !== "PRODUCTION") {
    fail(
      "WEB_CONTROL_STAGE_TARGET_MISMATCH",
      "PRODUCTION_READ_ONLY requires a PRODUCTION target",
    );
  }

  const releaseId = exactToken(
    exactEnv(env, PRODUCT_TRUTH_WEB_CONTROL_ENV.releaseId),
    PRODUCT_TRUTH_WEB_CONTROL_ENV.releaseId,
  );
  const databaseTargetFingerprint = exactSha(
    exactEnv(
      env,
      PRODUCT_TRUTH_WEB_CONTROL_ENV.databaseTargetFingerprint,
    ),
    PRODUCT_TRUTH_WEB_CONTROL_ENV.databaseTargetFingerprint,
  );
  const manifestSha256 = exactSha(
    exactEnv(env, PRODUCT_TRUTH_WEB_CONTROL_ENV.manifestSha256),
    PRODUCT_TRUTH_WEB_CONTROL_ENV.manifestSha256,
  );
  const expectedConfirmation = expectedProductTruthWebControlConfirmation({
    stage,
    releaseId,
    databaseTargetFingerprint,
    manifestSha256,
  });
  if (
    exactEnv(env, PRODUCT_TRUTH_WEB_CONTROL_ENV.confirmation)
      !== expectedConfirmation
  ) {
    fail(
      "WEB_CONTROL_CONFIRMATION_INVALID",
      "activation confirmation is not bound to exact stage/release/target/manifest",
    );
  }

  const workerEnabled =
    stage === "LOCAL_NO_SPEND" || stage === "PRODUCTION_READ_ONLY";
  const workerTokenSha256 = env[
    PRODUCT_TRUTH_WEB_CONTROL_ENV.workerTokenSha256
  ];
  if (workerEnabled && workerTokenSha256 === undefined) {
    fail(
      "WEB_CONTROL_CONFIG_INCOMPLETE",
      `${PRODUCT_TRUTH_WEB_CONTROL_ENV.workerTokenSha256} is required for worker stages`,
    );
  }
  if (!workerEnabled && workerTokenSha256 !== undefined) {
    fail(
      "WEB_CONTROL_CONFIG_INVALID",
      "ADMISSION_ONLY must not configure a worker credential",
    );
  }

  return {
    schemaVersion: PRODUCT_TRUTH_WEB_CONTROL_RUNTIME_VERSION,
    status: "ACTIVE",
    stage,
    engine: {
      commandSchemaVersion: PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
      releaseId,
      commitSha: exactGitSha(
        exactEnv(env, PRODUCT_TRUTH_WEB_CONTROL_ENV.commitSha),
        PRODUCT_TRUTH_WEB_CONTROL_ENV.commitSha,
      ),
      treeSha: exactGitSha(
        exactEnv(env, PRODUCT_TRUTH_WEB_CONTROL_ENV.treeSha),
        PRODUCT_TRUTH_WEB_CONTROL_ENV.treeSha,
      ),
      executableTreeSha256: exactSha(
        exactEnv(env, PRODUCT_TRUTH_WEB_CONTROL_ENV.executableTreeSha256),
        PRODUCT_TRUTH_WEB_CONTROL_ENV.executableTreeSha256,
      ),
    },
    target: {
      environment: environment as ProductTruthControlEnvironment,
      databaseTargetFingerprint,
      manifestSha256,
    },
    unwrangleReserveFloor: exactReserveFloor(
      exactEnv(env, PRODUCT_TRUTH_WEB_CONTROL_ENV.unwrangleReserveFloor),
    ),
    workerTokenSha256:
      workerTokenSha256 === undefined
        ? null
        : exactSha(
            workerTokenSha256,
            PRODUCT_TRUTH_WEB_CONTROL_ENV.workerTokenSha256,
          ),
    claims: {
      commandAdmission: true,
      controlDatabaseWrites: true,
      workerClaims: workerEnabled,
      processSpawnInWebRuntime: false,
      providerCallsInWebRuntime: false,
      marketplaceMutations: false,
      meteredExecutionAdmission: false,
    },
  };
}

export function productTruthWebControlPublicStatus(
  runtime: ProductTruthWebControlRuntime,
): {
  status: "OFF" | "ACTIVE";
  stage: "OFF" | ProductTruthWebControlActiveStage;
  command_admission: boolean;
  worker_claims: boolean;
  metered_execution: false;
  provider_calls_from_web: false;
  marketplace_mutations: false;
} {
  return runtime.status === "OFF"
    ? {
        status: "OFF",
        stage: "OFF",
        command_admission: false,
        worker_claims: false,
        metered_execution: false,
        provider_calls_from_web: false,
        marketplace_mutations: false,
      }
    : {
        status: "ACTIVE",
        stage: runtime.stage,
        command_admission: true,
        worker_claims: runtime.claims.workerClaims,
        metered_execution: false,
        provider_calls_from_web: false,
        marketplace_mutations: false,
      };
}
