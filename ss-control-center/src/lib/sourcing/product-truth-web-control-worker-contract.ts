import { createHash, timingSafeEqual } from "node:crypto";

import {
  PRODUCT_TRUTH_CONTROL_MAX_ARTIFACT_BYTES,
} from "./product-truth-control-plane";
import {
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  parseProductTruthTargetedWalmartEvidencePlan,
  parseProductTruthTargetedWalmartEvidenceRequest,
} from "./product-truth-targeted-walmart-evidence-contract";

export const PRODUCT_TRUTH_WORKER_RESULT_VERSION =
  "product-truth-worker-result/1.0.0" as const;

export interface ProductTruthWorkerResultFile {
  name: string;
  byteSize: number;
  sha256: string;
  contentBase64: string;
}

export interface ProductTruthWorkerResult {
  schemaVersion: typeof PRODUCT_TRUTH_WORKER_RESULT_VERSION;
  commandId: string;
  commandKind: "DOCTOR" | "RUN_PLAN";
  exitCode: number;
  files: readonly ProductTruthWorkerResultFile[];
  claims: {
    shell: false;
    providerCalls: 0;
    marketplaceMutations: 0;
  };
}

export class ProductTruthWorkerContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthWorkerContractError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthWorkerContractError(code, message);
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
    fail("WORKER_RESULT_INVALID", `${label} has non-canonical keys`);
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
    fail("WORKER_RESULT_INVALID", `${label} must be a safe token`);
  }
  return value;
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

export function parseProductTruthWorkerResult(
  value: unknown,
): ProductTruthWorkerResult {
  if (!isRecord(value)) fail("WORKER_RESULT_INVALID", "result must be an object");
  exactKeys(
    value,
    ["schemaVersion", "commandId", "commandKind", "exitCode", "files", "claims"],
    "result",
  );
  if (
    value.schemaVersion !== PRODUCT_TRUTH_WORKER_RESULT_VERSION
    || (value.commandKind !== "DOCTOR" && value.commandKind !== "RUN_PLAN")
    || !Number.isSafeInteger(value.exitCode)
    || Number(value.exitCode) < 0
    || Number(value.exitCode) > 255
    || !Array.isArray(value.files)
    || value.files.length < 1
    || value.files.length > 16
  ) {
    fail("WORKER_RESULT_INVALID", "result identity, exit code, or files are invalid");
  }
  if (!isRecord(value.claims)) {
    fail("WORKER_RESULT_INVALID", "result claims must be an object");
  }
  exactKeys(
    value.claims,
    ["shell", "providerCalls", "marketplaceMutations"],
    "result.claims",
  );
  if (
    value.claims.shell !== false
    || value.claims.providerCalls !== 0
    || value.claims.marketplaceMutations !== 0
  ) {
    fail("WORKER_RESULT_INVALID", "no-spend worker claims drifted");
  }
  let totalBytes = 0;
  const files = value.files.map((entry, index) => {
    if (!isRecord(entry)) {
      fail("WORKER_RESULT_INVALID", `files[${index}] must be an object`);
    }
    exactKeys(
      entry,
      ["name", "byteSize", "sha256", "contentBase64"],
      `files[${index}]`,
    );
    if (
      typeof entry.name !== "string"
      || !/^[a-z0-9][a-z0-9.-]{0,100}$/u.test(entry.name)
      || !Number.isSafeInteger(entry.byteSize)
      || Number(entry.byteSize) < 1
      || Number(entry.byteSize) > PRODUCT_TRUTH_CONTROL_MAX_ARTIFACT_BYTES
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || !canonicalBase64(entry.contentBase64)
    ) {
      fail("WORKER_RESULT_INVALID", `files[${index}] metadata is invalid`);
    }
    const bytes = Buffer.from(entry.contentBase64, "base64");
    if (
      bytes.byteLength !== Number(entry.byteSize)
      || sha256(bytes) !== entry.sha256
    ) {
      fail("WORKER_RESULT_INVALID", `files[${index}] bytes do not match their seal`);
    }
    totalBytes += bytes.byteLength;
    return {
      name: entry.name,
      byteSize: bytes.byteLength,
      sha256: entry.sha256,
      contentBase64: entry.contentBase64,
    };
  });
  const sortedNames = files.map((file) => file.name).sort();
  if (
    new Set(sortedNames).size !== sortedNames.length
    || files.some((file, index) => file.name !== sortedNames[index])
    || totalBytes > 3 * 1024 * 1024
  ) {
    fail("WORKER_RESULT_INVALID", "files must be unique, sorted, and bounded");
  }
  const required =
    value.commandKind === "DOCTOR"
      ? ["request.json", "request.sha256"]
      : ["approval-instructions.json", "plan.json", "plan.sha256"];
  if (
    Number(value.exitCode) === 0
    && (
      required.length !== files.length
      || required.some((name, index) => files[index]?.name !== name)
    )
  ) {
    fail("WORKER_RESULT_INVALID", "successful result has the wrong exact files");
  }
  return {
    schemaVersion: PRODUCT_TRUTH_WORKER_RESULT_VERSION,
    commandId: safeToken(value.commandId, "commandId"),
    commandKind: value.commandKind,
    exitCode: Number(value.exitCode),
    files,
    claims: {
      shell: false,
      providerCalls: 0,
      marketplaceMutations: 0,
    },
  };
}

export function renderProductTruthWorkerResult(value: unknown): string {
  return `${JSON.stringify(parseProductTruthWorkerResult(value))}\n`;
}

export function productTruthWorkerResultFile(
  result: ProductTruthWorkerResult,
  name: string,
): Buffer {
  const file = result.files.find((entry) => entry.name === name);
  if (!file) fail("WORKER_RESULT_FILE_MISSING", `result does not contain ${name}`);
  return Buffer.from(file.contentBase64, "base64");
}

function exactDigestFile(bytes: Uint8Array, expectedSha: string): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text !== `${expectedSha}\n`) {
    fail("WORKER_RESULT_DIGEST_MISMATCH", "sidecar SHA bytes are not canonical");
  }
}

export function verifiedProductTruthDoctorRequest(
  resultValue: unknown,
): ReturnType<typeof parseProductTruthTargetedWalmartEvidenceRequest> {
  const result = parseProductTruthWorkerResult(resultValue);
  if (result.commandKind !== "DOCTOR" || result.exitCode !== 0) {
    fail("WORKER_RESULT_INVALID", "successful DOCTOR result is required");
  }
  const requestBytes = productTruthWorkerResultFile(result, "request.json");
  const requestSha = sha256(requestBytes);
  exactDigestFile(
    productTruthWorkerResultFile(result, "request.sha256"),
    requestSha,
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes);
  if (!text.endsWith("\n") || text.includes("\r")) {
    fail("WORKER_RESULT_INVALID", "request.json bytes are not canonical");
  }
  const request = parseProductTruthTargetedWalmartEvidenceRequest(
    JSON.parse(text),
  );
  if (text !== renderProductTruthOperationalJson(request)) {
    fail("WORKER_RESULT_INVALID", "request.json differs from canonical bytes");
  }
  return request;
}

export function verifiedProductTruthRunPlan(
  resultValue: unknown,
): ReturnType<typeof parseProductTruthTargetedWalmartEvidencePlan> {
  const result = parseProductTruthWorkerResult(resultValue);
  if (result.commandKind !== "RUN_PLAN" || result.exitCode !== 0) {
    fail("WORKER_RESULT_INVALID", "successful RUN_PLAN result is required");
  }
  const planBytes = productTruthWorkerResultFile(result, "plan.json");
  const planSha = sha256(planBytes);
  exactDigestFile(productTruthWorkerResultFile(result, "plan.sha256"), planSha);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(planBytes);
  if (!text.endsWith("\n") || text.includes("\r")) {
    fail("WORKER_RESULT_INVALID", "plan.json bytes are not canonical");
  }
  const plan = parseProductTruthTargetedWalmartEvidencePlan(JSON.parse(text));
  if (text !== renderProductTruthOperationalJson(plan)) {
    fail("WORKER_RESULT_INVALID", "plan.json differs from canonical bytes");
  }
  return plan;
}

export function verifyProductTruthWorkerBearer(input: {
  bearer: string | null;
  expectedSha256: string | null;
}): boolean {
  if (
    input.expectedSha256 === null
    || !/^[a-f0-9]{64}$/u.test(input.expectedSha256)
    || input.bearer === null
    || input.bearer.length < 32
    || input.bearer.length > 500
  ) {
    return false;
  }
  const actual = Buffer.from(sha256(input.bearer), "hex");
  const expected = Buffer.from(input.expectedSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
