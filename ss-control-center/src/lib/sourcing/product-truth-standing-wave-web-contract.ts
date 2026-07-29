import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  PRODUCT_TRUTH_CONTROL_MAX_ARTIFACT_BYTES,
} from "./product-truth-control-plane";
import {
  PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS,
  PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS,
  PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
} from "./product-truth-standing-wave";

export const PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION =
  "product-truth-standing-wave-web-request/1.0.0" as const;
export const PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION =
  "product-truth-standing-wave-web-result/1.0.0" as const;
export const PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND =
  "STANDING_WAVE" as const;
export const PRODUCT_TRUTH_STANDING_WAVE_WEB_GATE_CLASS =
  "STANDING_METERED_EXECUTE" as const;
export const PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS = 30 as const;
export const PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_RESULT_BYTES =
  2 * 1024 * 1024;

export type ProductTruthStandingWaveWebOperation = "START" | "RESUME";

export interface ProductTruthStandingWaveWebRequest {
  schemaVersion: typeof PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION;
  requestId: string;
  operation: ProductTruthStandingWaveWebOperation;
  requestedAt: string;
  expiresAt: string;
  sourceCommandId: string | null;
  bindings: {
    manifestSha256: string;
    standingProviderPolicySha256: string;
    standingNoPaidPolicySha256: string;
  };
  limits: {
    maxTargets: typeof PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS;
    maxLinkedListings: typeof PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS;
    maxProviderUnits: typeof PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS;
    maxLifetimeMs: typeof PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS;
    targetConcurrency: 1;
    maxAttemptsPerTarget: 1;
    automaticRetry: false;
  };
  claims: {
    authority: "PINNED_STANDING_POLICY";
    authoritativePhase1Only: true;
    noImplicitScope: true;
    noParallelCatalog: true;
    ambiguousNeverReplay: true;
    noMarketplaceMutation: true;
    noPriceOrInventoryChange: true;
    noDelisting: true;
    noConsumerActivation: true;
    noProcurement: true;
    noClubs: true;
    noBjs: true;
  };
}

export interface ProductTruthStandingWaveWebResultFile {
  name: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  contentBase64: string;
}

export interface ProductTruthStandingWaveWebResult {
  schemaVersion: typeof PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION;
  commandId: string;
  operation: ProductTruthStandingWaveWebOperation;
  exitCode: number;
  outcome: "COMPLETED" | "FAILED" | "AMBIGUOUS";
  waveId: string | null;
  targetCount: number | null;
  completedTargetCount: number;
  ambiguousTargetCount: number;
  actualProviderUnits: number | null;
  planSha256: string | null;
  reportSha256: string | null;
  readinessReportSha256: string | null;
  files: readonly ProductTruthStandingWaveWebResultFile[];
  claims: {
    shell: false;
    automaticRetry: false;
    retries: 0;
    marketplaceMutations: 0;
    priceOrInventoryChanges: 0;
    delistings: 0;
    consumerActivations: 0;
    procurementActions: 0;
  };
}

export class ProductTruthStandingWaveWebContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthStandingWaveWebContractError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthStandingWaveWebContractError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail("STANDING_WAVE_WEB_SHAPE_INVALID", `${label} has non-canonical keys`);
  }
}

function safeToken(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 8
    || value.length > 200
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  ) {
    fail("STANDING_WAVE_WEB_VALUE_INVALID", `${label} must be a safe token`);
  }
  return value;
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("STANDING_WAVE_WEB_VALUE_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("STANDING_WAVE_WEB_VALUE_INVALID", `${label} must be canonical UTC`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("STANDING_WAVE_WEB_VALUE_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) {
    fail(
      "STANDING_WAVE_WEB_VALUE_INVALID",
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return Number(value);
}

function boundedNumber(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > maximum
  ) {
    fail(
      "STANDING_WAVE_WEB_VALUE_INVALID",
      `${label} must be a finite number from 0 to ${maximum}`,
    );
  }
  return value;
}

function exactBoolean(value: unknown, expected: boolean, label: string): void {
  if (value !== expected) {
    fail("STANDING_WAVE_WEB_VALUE_INVALID", `${label} must be ${String(expected)}`);
  }
}

function parseBindings(
  value: unknown,
): ProductTruthStandingWaveWebRequest["bindings"] {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_WEB_SHAPE_INVALID", "bindings must be an object");
  }
  exactKeys(
    value,
    [
      "manifestSha256",
      "standingProviderPolicySha256",
      "standingNoPaidPolicySha256",
    ],
    "bindings",
  );
  return {
    manifestSha256: sha256Value(value.manifestSha256, "manifestSha256"),
    standingProviderPolicySha256: sha256Value(
      value.standingProviderPolicySha256,
      "standingProviderPolicySha256",
    ),
    standingNoPaidPolicySha256: sha256Value(
      value.standingNoPaidPolicySha256,
      "standingNoPaidPolicySha256",
    ),
  };
}

function parseLimits(
  value: unknown,
): ProductTruthStandingWaveWebRequest["limits"] {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_WEB_SHAPE_INVALID", "limits must be an object");
  }
  exactKeys(
    value,
    [
      "maxTargets",
      "maxLinkedListings",
      "maxProviderUnits",
      "maxLifetimeMs",
      "targetConcurrency",
      "maxAttemptsPerTarget",
      "automaticRetry",
    ],
    "limits",
  );
  if (
    value.maxTargets !== PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS
    || value.maxLinkedListings !== PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS
    || value.maxProviderUnits !== PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS
    || value.maxLifetimeMs !== PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS
    || value.targetConcurrency !== 1
    || value.maxAttemptsPerTarget !== 1
  ) {
    fail("STANDING_WAVE_WEB_LIMIT_DRIFT", "standing-wave ceilings changed");
  }
  exactBoolean(value.automaticRetry, false, "automaticRetry");
  return {
    maxTargets: PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
    maxLinkedListings: PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS,
    maxProviderUnits: PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS,
    maxLifetimeMs: PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS,
    targetConcurrency: 1,
    maxAttemptsPerTarget: 1,
    automaticRetry: false,
  };
}

function parseClaims(
  value: unknown,
): ProductTruthStandingWaveWebRequest["claims"] {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_WEB_SHAPE_INVALID", "claims must be an object");
  }
  exactKeys(
    value,
    [
      "authority",
      "authoritativePhase1Only",
      "noImplicitScope",
      "noParallelCatalog",
      "ambiguousNeverReplay",
      "noMarketplaceMutation",
      "noPriceOrInventoryChange",
      "noDelisting",
      "noConsumerActivation",
      "noProcurement",
      "noClubs",
      "noBjs",
    ],
    "claims",
  );
  if (value.authority !== "PINNED_STANDING_POLICY") {
    fail("STANDING_WAVE_WEB_AUTHORITY_INVALID", "standing authority is absent");
  }
  for (const key of [
    "authoritativePhase1Only",
    "noImplicitScope",
    "noParallelCatalog",
    "ambiguousNeverReplay",
    "noMarketplaceMutation",
    "noPriceOrInventoryChange",
    "noDelisting",
    "noConsumerActivation",
    "noProcurement",
    "noClubs",
    "noBjs",
  ] as const) {
    exactBoolean(value[key], true, key);
  }
  return {
    authority: "PINNED_STANDING_POLICY",
    authoritativePhase1Only: true,
    noImplicitScope: true,
    noParallelCatalog: true,
    ambiguousNeverReplay: true,
    noMarketplaceMutation: true,
    noPriceOrInventoryChange: true,
    noDelisting: true,
    noConsumerActivation: true,
    noProcurement: true,
    noClubs: true,
    noBjs: true,
  };
}

export function parseProductTruthStandingWaveWebRequest(
  value: unknown,
): ProductTruthStandingWaveWebRequest {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_WEB_SHAPE_INVALID", "request must be an object");
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "requestId",
      "operation",
      "requestedAt",
      "expiresAt",
      "sourceCommandId",
      "bindings",
      "limits",
      "claims",
    ],
    "request",
  );
  if (
    value.schemaVersion !== PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION
    || (value.operation !== "START" && value.operation !== "RESUME")
  ) {
    fail("STANDING_WAVE_WEB_IDENTITY_INVALID", "request identity is invalid");
  }
  const requestedAt = canonicalInstant(value.requestedAt, "requestedAt");
  const expiresAt = canonicalInstant(value.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(requestedAt);
  if (
    lifetime <= 0
    || lifetime > PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS
  ) {
    fail("STANDING_WAVE_WEB_EXPIRY_INVALID", "request lifetime is invalid");
  }
  const sourceCommandId =
    value.sourceCommandId === null
      ? null
      : safeToken(value.sourceCommandId, "sourceCommandId");
  if (
    (value.operation === "START" && sourceCommandId !== null)
    || (value.operation === "RESUME" && sourceCommandId === null)
  ) {
    fail(
      "STANDING_WAVE_WEB_SOURCE_INVALID",
      "source command binding does not match operation",
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION,
    requestId: safeToken(value.requestId, "requestId"),
    operation: value.operation,
    requestedAt,
    expiresAt,
    sourceCommandId,
    bindings: parseBindings(value.bindings),
    limits: parseLimits(value.limits),
    claims: parseClaims(value.claims),
  };
}

export function renderProductTruthStandingWaveWebRequest(
  value: unknown,
): string {
  return `${JSON.stringify(parseProductTruthStandingWaveWebRequest(value))}\n`;
}

export function parseProductTruthStandingWaveWebRequestBytes(
  bytes: Uint8Array,
): ProductTruthStandingWaveWebRequest {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("STANDING_WAVE_WEB_BYTES_INVALID", "request is not UTF-8");
  }
  if (!text.endsWith("\n") || text.includes("\r")) {
    fail("STANDING_WAVE_WEB_BYTES_INVALID", "request bytes are not canonical");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("STANDING_WAVE_WEB_BYTES_INVALID", "request is not JSON");
  }
  const request = parseProductTruthStandingWaveWebRequest(parsed);
  if (text !== `${JSON.stringify(request)}\n`) {
    fail("STANDING_WAVE_WEB_BYTES_INVALID", "request bytes changed after parsing");
  }
  return request;
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || !value || /\s/u.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.toString("base64") === value;
  } catch {
    return false;
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseResultFile(
  value: unknown,
  index: number,
): ProductTruthStandingWaveWebResultFile {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", `files[${index}] must be an object`);
  }
  exactKeys(
    value,
    ["name", "mediaType", "byteSize", "sha256", "contentBase64"],
    `files[${index}]`,
  );
  if (
    typeof value.name !== "string"
    || !/^[a-z0-9][a-z0-9.-]{0,120}$/u.test(value.name)
    || typeof value.mediaType !== "string"
    || value.mediaType.length < 3
    || value.mediaType.length > 100
    || !Number.isSafeInteger(value.byteSize)
    || Number(value.byteSize) < 1
    || Number(value.byteSize) > PRODUCT_TRUTH_CONTROL_MAX_ARTIFACT_BYTES
    || !canonicalBase64(value.contentBase64)
  ) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", `files[${index}] is invalid`);
  }
  const bytes = Buffer.from(value.contentBase64, "base64");
  const digest = sha256Value(value.sha256, `files[${index}].sha256`);
  if (bytes.byteLength !== Number(value.byteSize) || sha256(bytes) !== digest) {
    fail(
      "STANDING_WAVE_WEB_RESULT_INVALID",
      `files[${index}] bytes differ from their seal`,
    );
  }
  return {
    name: value.name,
    mediaType: value.mediaType,
    byteSize: bytes.byteLength,
    sha256: digest,
    contentBase64: value.contentBase64,
  };
}

export function parseProductTruthStandingWaveWebResult(
  value: unknown,
): ProductTruthStandingWaveWebResult {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", "result must be an object");
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "commandId",
      "operation",
      "exitCode",
      "outcome",
      "waveId",
      "targetCount",
      "completedTargetCount",
      "ambiguousTargetCount",
      "actualProviderUnits",
      "planSha256",
      "reportSha256",
      "readinessReportSha256",
      "files",
      "claims",
    ],
    "result",
  );
  if (
    value.schemaVersion !== PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION
    || (value.operation !== "START" && value.operation !== "RESUME")
    || !Number.isSafeInteger(value.exitCode)
    || Number(value.exitCode) < 0
    || Number(value.exitCode) > 255
    || !["COMPLETED", "FAILED", "AMBIGUOUS"].includes(String(value.outcome))
    || !Array.isArray(value.files)
    || value.files.length < 1
    || value.files.length > 16
  ) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", "result identity is invalid");
  }
  const targetCount =
    value.targetCount === null
      ? null
      : integer(
          value.targetCount,
          "targetCount",
          0,
          PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
        );
  const completedTargetCount = integer(
    value.completedTargetCount,
    "completedTargetCount",
    0,
    PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
  );
  const ambiguousTargetCount = integer(
    value.ambiguousTargetCount,
    "ambiguousTargetCount",
    0,
    PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
  );
  if (
    targetCount !== null
    && completedTargetCount + ambiguousTargetCount > targetCount
  ) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", "target result counts overflow");
  }
  const planSha256 =
    value.planSha256 === null
      ? null
      : sha256Value(value.planSha256, "planSha256");
  const reportSha256 =
    value.reportSha256 === null
      ? null
      : sha256Value(value.reportSha256, "reportSha256");
  const readinessReportSha256 =
    value.readinessReportSha256 === null
      ? null
      : sha256Value(value.readinessReportSha256, "readinessReportSha256");
  const waveId =
    value.waveId === null ? null : safeToken(value.waveId, "waveId");
  const outcome = value.outcome as ProductTruthStandingWaveWebResult["outcome"];
  if (
    outcome === "COMPLETED"
    && (
      Number(value.exitCode) !== 0
      || waveId === null
      || targetCount === null
      || value.actualProviderUnits === null
      || planSha256 === null
      || reportSha256 === null
      || readinessReportSha256 === null
      || completedTargetCount + ambiguousTargetCount !== targetCount
    )
  ) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", "completed result is incomplete");
  }
  if (outcome !== "COMPLETED" && Number(value.exitCode) === 0) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", "non-completed result cannot exit zero");
  }
  const files = value.files.map(parseResultFile);
  const names = files.map((file) => file.name);
  const sortedNames = [...names].sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
  const totalBytes = files.reduce((total, file) => total + file.byteSize, 0);
  if (
    new Set(names).size !== names.length
    || names.some((name, index) => name !== sortedNames[index])
    || totalBytes > PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_RESULT_BYTES
  ) {
    fail(
      "STANDING_WAVE_WEB_RESULT_INVALID",
      "result files must be sorted, unique, and bounded",
    );
  }
  const requiredCompletedFiles = [
    "artifact-index.json",
    "artifact-index.sha256",
    "readiness-report.json.gz",
    "readiness-report.sha256",
    "wave-plan.json",
    "wave-plan.sha256",
    "wave-report.json",
    "wave-report.sha256",
  ];
  if (
    outcome === "COMPLETED"
    && requiredCompletedFiles.some((name) => !names.includes(name))
  ) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", "completed custody set is incomplete");
  }
  if (outcome === "COMPLETED") {
    const exactSidecar = (name: string, digest: string) => {
      const sidecar = files.find((file) => file.name === name);
      if (
        !sidecar
        || Buffer.from(sidecar.contentBase64, "base64").toString("utf8")
          !== `${digest}\n`
      ) {
        fail(
          "STANDING_WAVE_WEB_RESULT_INVALID",
          `${name} does not contain its exact digest`,
        );
      }
    };
    const plan = files.find((file) => file.name === "wave-plan.json");
    const report = files.find((file) => file.name === "wave-report.json");
    const index = files.find((file) => file.name === "artifact-index.json");
    const readiness = files.find(
      (file) => file.name === "readiness-report.json.gz",
    );
    if (!plan || !report || !index || !readiness) {
      fail("STANDING_WAVE_WEB_RESULT_INVALID", "completed custody files vanished");
    }
    if (
      sha256(Buffer.from(plan.contentBase64, "base64")) !== planSha256
      || sha256(Buffer.from(report.contentBase64, "base64")) !== reportSha256
    ) {
      fail(
        "STANDING_WAVE_WEB_RESULT_INVALID",
        "plan/report result bindings differ from custody bytes",
      );
    }
    let readinessBytes: Buffer;
    try {
      readinessBytes = gunzipSync(
        Buffer.from(readiness.contentBase64, "base64"),
      );
    } catch {
      fail(
        "STANDING_WAVE_WEB_RESULT_INVALID",
        "readiness custody is not valid gzip",
      );
    }
    if (sha256(readinessBytes) !== readinessReportSha256) {
      fail(
        "STANDING_WAVE_WEB_RESULT_INVALID",
        "readiness result binding differs from compressed custody bytes",
      );
    }
    exactSidecar("wave-plan.sha256", planSha256 as string);
    exactSidecar("wave-report.sha256", reportSha256 as string);
    exactSidecar(
      "artifact-index.sha256",
      sha256(Buffer.from(index.contentBase64, "base64")),
    );
    exactSidecar(
      "readiness-report.sha256",
      readinessReportSha256 as string,
    );
  }
  if (!isRecord(value.claims)) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", "claims must be an object");
  }
  exactKeys(
    value.claims,
    [
      "shell",
      "automaticRetry",
      "retries",
      "marketplaceMutations",
      "priceOrInventoryChanges",
      "delistings",
      "consumerActivations",
      "procurementActions",
    ],
    "result.claims",
  );
  if (
    value.claims.shell !== false
    || value.claims.automaticRetry !== false
    || value.claims.retries !== 0
    || value.claims.marketplaceMutations !== 0
    || value.claims.priceOrInventoryChanges !== 0
    || value.claims.delistings !== 0
    || value.claims.consumerActivations !== 0
    || value.claims.procurementActions !== 0
  ) {
    fail("STANDING_WAVE_WEB_RESULT_INVALID", "result safety claims drifted");
  }
  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION,
    commandId: safeToken(value.commandId, "commandId"),
    operation: value.operation,
    exitCode: Number(value.exitCode),
    outcome,
    waveId,
    targetCount,
    completedTargetCount,
    ambiguousTargetCount,
    actualProviderUnits:
      value.actualProviderUnits === null
        ? null
        : boundedNumber(
            value.actualProviderUnits,
            "actualProviderUnits",
            PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS,
          ),
    planSha256,
    reportSha256,
    readinessReportSha256,
    files,
    claims: {
      shell: false,
      automaticRetry: false,
      retries: 0,
      marketplaceMutations: 0,
      priceOrInventoryChanges: 0,
      delistings: 0,
      consumerActivations: 0,
      procurementActions: 0,
    },
  };
}

export function renderProductTruthStandingWaveWebResult(
  value: unknown,
): string {
  return `${JSON.stringify(parseProductTruthStandingWaveWebResult(value))}\n`;
}
