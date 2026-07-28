/** Canonical data-only execution package for the Walmart repair operator. */

import { createHash } from "node:crypto";

import { createWalmartListingRepairProductionDependencies } from
  "./listing-integrity-remediation-production-dependencies.ts";
import type { WalmartListingRepairProductionExecutionInput } from
  "./listing-integrity-remediation-writer.ts";

export const WALMART_LISTING_REPAIR_EXECUTION_PACKAGE_SCHEMA =
  "walmart-listing-repair-execution-package/v1" as const;
export const WALMART_LISTING_REPAIR_EXECUTION_PACKAGE_MAX_BYTES = 512 * 1024 * 1024;

type JsonPrimitive = null | boolean | number | string;
type WireValue = JsonPrimitive | WireValue[] | { [key: string]: WireValue };
type JsonRecord = Record<string, unknown>;

export interface SealedWalmartListingRepairExecutionPackage extends JsonRecord {
  schema_version: typeof WALMART_LISTING_REPAIR_EXECUTION_PACKAGE_SCHEMA;
  created_at: string;
  execution: WireValue;
  claims: {
    data_only: true;
    executable_dependencies_embedded: false;
    exact_listing_count: 1;
    marketplace_write_calls_maximum: 1;
    automatic_retry_allowed: false;
    automatic_reapply_allowed: false;
    mass_apply_allowed: false;
  };
  body_sha256: string;
}

export class WalmartListingRepairExecutionPackageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingRepairExecutionPackageError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairExecutionPackageError(code, message);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("NON_CANONICAL_PACKAGE", "execution package rejects undefined");
  return encoded;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value) {
    fail("INVALID_EXECUTION_PACKAGE", `${label} must be canonical UTC milliseconds`);
  }
  return value;
}

function safeWireKey(value: string): void {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)
    || value === "__proto__" || value === "prototype" || value === "constructor"
    || value.startsWith("$")) {
    fail("INVALID_WIRE_VALUE", "execution package contains an unsafe or reserved object key");
  }
}

function encodeWire(value: unknown, seen: Set<object>): WireValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      fail("INVALID_WIRE_VALUE", "execution package accepts only finite safe integers");
    }
    return value;
  }
  if (value instanceof Uint8Array) {
    return { $bytes_base64: Buffer.from(value).toString("base64") };
  }
  if (!value || typeof value !== "object") {
    fail("INVALID_WIRE_VALUE", "execution package contains a function or unsupported value");
  }
  if (seen.has(value)) fail("INVALID_WIRE_VALUE", "execution package contains a cycle");
  seen.add(value);
  try {
    if (value instanceof Map) {
      const entries: WireValue[] = [];
      for (const [key, entry] of value.entries()) {
        if (typeof key !== "string") {
          fail("INVALID_WIRE_VALUE", "execution package map keys must be strings");
        }
        entries.push([key, encodeWire(entry, seen)]);
      }
      entries.sort((left, right) => String((left as WireValue[])[0])
        .localeCompare(String((right as WireValue[])[0])));
      return { $map: entries };
    }
    if (Array.isArray(value)) return value.map((entry) => encodeWire(entry, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("INVALID_WIRE_VALUE", "execution package accepts only plain data objects");
    }
    const result: Record<string, WireValue> = {};
    for (const key of Object.keys(value as JsonRecord).sort()) {
      safeWireKey(key);
      result[key] = encodeWire((value as JsonRecord)[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function exactBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > WALMART_LISTING_REPAIR_EXECUTION_PACKAGE_MAX_BYTES * 2
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("INVALID_WIRE_VALUE", "execution package byte wrapper is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    fail("INVALID_WIRE_VALUE", "execution package byte wrapper is not exact base64");
  }
  return Uint8Array.from(decoded);
}

function decodeWire(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("INVALID_WIRE_VALUE", "wire number is not a safe integer");
    return value;
  }
  if (Array.isArray(value)) return value.map(decodeWire);
  if (!value || typeof value !== "object") fail("INVALID_WIRE_VALUE", "wire value is invalid");
  const raw = value as JsonRecord;
  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === "$bytes_base64") {
    return exactBase64(raw.$bytes_base64);
  }
  if (keys.length === 1 && keys[0] === "$map") {
    if (!Array.isArray(raw.$map)) fail("INVALID_WIRE_VALUE", "wire map entries are invalid");
    const result = new Map<string, unknown>();
    let previous: string | null = null;
    for (const candidate of raw.$map) {
      if (!Array.isArray(candidate) || candidate.length !== 2 || typeof candidate[0] !== "string") {
        fail("INVALID_WIRE_VALUE", "wire map entry is invalid");
      }
      const key = candidate[0];
      if (previous !== null && key.localeCompare(previous) <= 0) {
        fail("INVALID_WIRE_VALUE", "wire map keys must be unique and sorted");
      }
      previous = key;
      result.set(key, decodeWire(candidate[1]));
    }
    return result;
  }
  const result: JsonRecord = {};
  for (const key of keys) {
    safeWireKey(key);
    result[key] = decodeWire(raw[key]);
  }
  return result;
}

function packageBody(input: {
  created_at: string;
  execution: WalmartListingRepairProductionExecutionInput;
}) {
  return {
    schema_version: WALMART_LISTING_REPAIR_EXECUTION_PACKAGE_SCHEMA,
    created_at: canonicalInstant(input.created_at, "created_at"),
    execution: encodeWire(input.execution, new Set()),
    claims: {
      data_only: true as const,
      executable_dependencies_embedded: false as const,
      exact_listing_count: 1 as const,
      marketplace_write_calls_maximum: 1 as const,
      automatic_retry_allowed: false as const,
      automatic_reapply_allowed: false as const,
      mass_apply_allowed: false as const,
    },
  };
}

export function sealWalmartListingRepairExecutionPackage(input: {
  created_at: string;
  execution: WalmartListingRepairProductionExecutionInput;
}): SealedWalmartListingRepairExecutionPackage {
  // Constructor-only validation: fixed dependencies perform no network, custody
  // bootstrap, permit consumption or marketplace write here.
  createWalmartListingRepairProductionDependencies(input.execution);
  const body = packageBody(input);
  return Object.freeze({ ...body, body_sha256: sha256(canonicalJson(body)) });
}

export function renderWalmartListingRepairExecutionPackage(
  value: SealedWalmartListingRepairExecutionPackage,
): string {
  return `${canonicalJson(value)}\n`;
}

export function parseWalmartListingRepairExecutionPackageBytes(input: {
  artifact_bytes: Uint8Array;
  expected_artifact_sha256: string;
}): {
  artifact: SealedWalmartListingRepairExecutionPackage;
  execution: WalmartListingRepairProductionExecutionInput;
  artifact_sha256: string;
} {
  if (!(input.artifact_bytes instanceof Uint8Array) || input.artifact_bytes.byteLength < 2
    || input.artifact_bytes.byteLength > WALMART_LISTING_REPAIR_EXECUTION_PACKAGE_MAX_BYTES) {
    fail("INVALID_EXECUTION_PACKAGE", "execution package bytes are empty or oversized");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.expected_artifact_sha256)
    || sha256(input.artifact_bytes) !== input.expected_artifact_sha256) {
    fail("EXECUTION_PACKAGE_SHA_MISMATCH", "execution package artifact SHA differs");
  }
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.artifact_bytes);
    parsed = JSON.parse(decoded);
  } catch {
    return fail("INVALID_EXECUTION_PACKAGE", "execution package must be exact UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("INVALID_EXECUTION_PACKAGE", "execution package must be an object");
  }
  const raw = parsed as JsonRecord;
  const keys = Object.keys(raw).sort();
  const expectedKeys = ["body_sha256", "claims", "created_at", "execution", "schema_version"];
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    fail("INVALID_EXECUTION_PACKAGE", "execution package has missing or extra fields");
  }
  if (raw.schema_version !== WALMART_LISTING_REPAIR_EXECUTION_PACKAGE_SCHEMA) {
    fail("INVALID_EXECUTION_PACKAGE", "execution package schema is unsupported");
  }
  canonicalInstant(raw.created_at, "created_at");
  if (decoded !== `${canonicalJson(raw)}\n`) {
    fail("NON_CANONICAL_PACKAGE", "execution package bytes are not canonical JSON plus LF");
  }
  if (typeof raw.body_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.body_sha256)) {
    fail("INVALID_EXECUTION_PACKAGE", "execution package body SHA is invalid");
  }
  const body = { ...raw };
  delete body.body_sha256;
  if (sha256(canonicalJson(body)) !== raw.body_sha256) {
    fail("EXECUTION_PACKAGE_BODY_SHA_MISMATCH", "execution package body SHA differs");
  }
  const claims = raw.claims as JsonRecord;
  if (!claims || claims.data_only !== true || claims.executable_dependencies_embedded !== false
    || claims.exact_listing_count !== 1 || claims.marketplace_write_calls_maximum !== 1
    || claims.automatic_retry_allowed !== false || claims.automatic_reapply_allowed !== false
    || claims.mass_apply_allowed !== false || Object.keys(claims).length !== 7) {
    fail("INVALID_EXECUTION_PACKAGE", "execution package safety claims differ");
  }
  const execution = decodeWire(raw.execution) as WalmartListingRepairProductionExecutionInput;
  createWalmartListingRepairProductionDependencies(execution);
  return {
    artifact: Object.freeze(raw) as SealedWalmartListingRepairExecutionPackage,
    execution,
    artifact_sha256: input.expected_artifact_sha256,
  };
}
