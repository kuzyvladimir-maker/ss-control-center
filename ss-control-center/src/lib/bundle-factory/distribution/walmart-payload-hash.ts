import { createHash } from "node:crypto";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalizeWalmartPayload(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("payload contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeWalmartPayload);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(input).sort()) {
      const item = input[key];
      if (item !== undefined) output[key] = canonicalizeWalmartPayload(item);
    }
    return output;
  }
  throw new Error(`payload contains unsupported ${typeof value}`);
}

/** Canonical bytes used by certification, approval and the durable POST fence. */
export function canonicalWalmartPayloadJson(payload: unknown): string {
  return JSON.stringify(canonicalizeWalmartPayload(payload));
}

export function hashWalmartPayload(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalWalmartPayloadJson(payload))
    .digest("hex");
}
