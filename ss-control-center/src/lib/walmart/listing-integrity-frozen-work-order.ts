import {
  walmartListingIntegrityControlSha256,
} from "./listing-integrity-control-plane";
import type {
  WalmartListingIntegrityFrozenWorkerInvocation,
} from "./listing-integrity-frozen-operator-worker";

export const WALMART_LISTING_INTEGRITY_FROZEN_WORK_ORDER_SCHEMA =
  "walmart-listing-integrity-frozen-work-order/v1" as const;
export const WALMART_LISTING_INTEGRITY_FROZEN_WORK_ORDER_MAX_AGE_MS =
  15 * 60 * 1_000;

export interface WalmartListingIntegrityFrozenWorkOrder {
  schema_version: typeof WALMART_LISTING_INTEGRITY_FROZEN_WORK_ORDER_SCHEMA;
  work_order_id: string;
  created_at: string;
  expires_at: string;
  command: WalmartListingIntegrityFrozenWorkerInvocation["command"];
  listing_key: string;
  sku: string;
  current_state_body_sha256: string;
  execution_package_sha256: string;
  owner_permit_sha256: string;
  plan_body_sha256: string;
  frozen_release_id_sha256: string;
  manifest_sha256: string;
  global_admission_identity_sha256: string;
  operator_args: readonly string[];
  claims: {
    exact_listing_count: 1;
    maximum_operator_calls: 1;
    automatic_retry_allowed: false;
    automatic_replay_allowed: false;
    mass_apply_allowed: false;
    delist: false;
    reprice: false;
    inventory_write: false;
  };
  body_sha256: string;
}

export class WalmartListingIntegrityFrozenWorkOrderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WalmartListingIntegrityFrozenWorkOrderError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingIntegrityFrozenWorkOrderError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("FROZEN_WORK_ORDER_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail("FROZEN_WORK_ORDER_INVALID", `${label} has missing or extra fields`);
  }
}

function text(value: unknown, label: string, maximum = 768): string {
  if (typeof value !== "string" || value !== value.trim() || !value
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("FROZEN_WORK_ORDER_INVALID", `${label} must be bounded exact text`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    fail("FROZEN_WORK_ORDER_INVALID", `${label} must be lowercase SHA-256`);
  }
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    fail("FROZEN_WORK_ORDER_INVALID", `${label} must be canonical UTC`);
  }
  return parsed;
}

function args(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 32
    || value.some((entry) => typeof entry !== "string" || !entry
      || entry.length > 4096 || /[\u0000\r\n]/u.test(entry))) {
    fail("FROZEN_WORK_ORDER_INVALID", "operator_args must be bounded exact argv values");
  }
  return Object.freeze([...value]) as readonly string[];
}

const CLAIMS = Object.freeze({
  exact_listing_count: 1 as const,
  maximum_operator_calls: 1 as const,
  automatic_retry_allowed: false as const,
  automatic_replay_allowed: false as const,
  mass_apply_allowed: false as const,
  delist: false as const,
  reprice: false as const,
  inventory_write: false as const,
});

function withoutSeal(value: WalmartListingIntegrityFrozenWorkOrder) {
  const body = { ...value } as Partial<WalmartListingIntegrityFrozenWorkOrder>;
  delete body.body_sha256;
  return body;
}

export function verifyWalmartListingIntegrityFrozenWorkOrder(input: {
  work_order: unknown;
  invocation: WalmartListingIntegrityFrozenWorkerInvocation;
  now: Date;
}): WalmartListingIntegrityFrozenWorkOrder {
  const raw = record(input.work_order, "work order");
  exactKeys(raw, [
    "schema_version",
    "work_order_id",
    "created_at",
    "expires_at",
    "command",
    "listing_key",
    "sku",
    "current_state_body_sha256",
    "execution_package_sha256",
    "owner_permit_sha256",
    "plan_body_sha256",
    "frozen_release_id_sha256",
    "manifest_sha256",
    "global_admission_identity_sha256",
    "operator_args",
    "claims",
    "body_sha256",
  ], "work order");
  const claims = record(raw.claims, "work order claims");
  exactKeys(claims, Object.keys(CLAIMS), "work order claims");
  if (walmartListingIntegrityControlSha256(claims)
    !== walmartListingIntegrityControlSha256(CLAIMS)) {
    fail("FROZEN_WORK_ORDER_POLICY_DRIFT", "work order claims exceed one safe SKU call");
  }
  const command = raw.command;
  if (command !== "execute" && command !== "resume" && command !== "qualify") {
    fail("FROZEN_WORK_ORDER_INVALID", "work order command is not admitted");
  }
  const parsed: WalmartListingIntegrityFrozenWorkOrder = {
    schema_version: raw.schema_version as typeof WALMART_LISTING_INTEGRITY_FROZEN_WORK_ORDER_SCHEMA,
    work_order_id: text(raw.work_order_id, "work_order_id", 200),
    created_at: instant(raw.created_at, "created_at"),
    expires_at: instant(raw.expires_at, "expires_at"),
    command,
    listing_key: text(raw.listing_key, "listing_key"),
    sku: text(raw.sku, "sku", 500),
    current_state_body_sha256: sha(raw.current_state_body_sha256, "current state SHA"),
    execution_package_sha256: sha(raw.execution_package_sha256, "package SHA"),
    owner_permit_sha256: sha(raw.owner_permit_sha256, "permit SHA"),
    plan_body_sha256: sha(raw.plan_body_sha256, "plan body SHA"),
    frozen_release_id_sha256: sha(raw.frozen_release_id_sha256, "release SHA"),
    manifest_sha256: sha(raw.manifest_sha256, "manifest SHA"),
    global_admission_identity_sha256: sha(
      raw.global_admission_identity_sha256,
      "global admission identity SHA",
    ),
    operator_args: args(raw.operator_args),
    claims: CLAIMS,
    body_sha256: sha(raw.body_sha256, "body SHA"),
  };
  if (parsed.schema_version !== WALMART_LISTING_INTEGRITY_FROZEN_WORK_ORDER_SCHEMA
    || parsed.body_sha256 !== walmartListingIntegrityControlSha256(withoutSeal(parsed))) {
    fail("FROZEN_WORK_ORDER_SEAL_INVALID", "work order schema or body seal is invalid");
  }
  const created = Date.parse(parsed.created_at);
  const expires = Date.parse(parsed.expires_at);
  const now = input.now.getTime();
  if (!Number.isFinite(now) || expires <= created
    || expires - created > WALMART_LISTING_INTEGRITY_FROZEN_WORK_ORDER_MAX_AGE_MS
    || now < created - 5 * 60_000 || now >= expires) {
    fail("FROZEN_WORK_ORDER_EXPIRED", "work order is outside its bounded current window");
  }
  const invocation = input.invocation;
  if (parsed.command !== invocation.command
    || parsed.listing_key !== invocation.listing_key
    || parsed.sku !== invocation.sku
    || parsed.current_state_body_sha256 !== invocation.current_state_body_sha256
    || parsed.execution_package_sha256 !== invocation.execution_package_sha256
    || parsed.owner_permit_sha256 !== invocation.owner_permit_sha256
    || parsed.plan_body_sha256 !== invocation.plan_body_sha256
    || parsed.frozen_release_id_sha256 !== invocation.frozen_release_id_sha256
    || parsed.manifest_sha256 !== invocation.manifest_sha256
    || parsed.global_admission_identity_sha256
      !== invocation.global_admission_identity_sha256) {
    fail("FROZEN_WORK_ORDER_BINDING_DRIFT", "work order differs from the exact worker decision");
  }
  return Object.freeze({ ...parsed, operator_args: Object.freeze([...parsed.operator_args]) });
}

export function buildWalmartListingIntegrityFrozenWorkOrder(input: {
  work_order_id: string;
  invocation: WalmartListingIntegrityFrozenWorkerInvocation;
  operator_args: readonly string[];
  created_at: string;
  expires_at: string;
}): WalmartListingIntegrityFrozenWorkOrder {
  const invocation = input.invocation;
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_FROZEN_WORK_ORDER_SCHEMA,
    work_order_id: input.work_order_id,
    created_at: input.created_at,
    expires_at: input.expires_at,
    command: invocation.command,
    listing_key: invocation.listing_key,
    sku: invocation.sku,
    current_state_body_sha256: invocation.current_state_body_sha256,
    execution_package_sha256: invocation.execution_package_sha256,
    owner_permit_sha256: invocation.owner_permit_sha256,
    plan_body_sha256: invocation.plan_body_sha256,
    frozen_release_id_sha256: invocation.frozen_release_id_sha256,
    manifest_sha256: invocation.manifest_sha256,
    global_admission_identity_sha256: invocation.global_admission_identity_sha256,
    operator_args: Object.freeze([...input.operator_args]),
    claims: CLAIMS,
  };
  const workOrder = {
    ...body,
    body_sha256: walmartListingIntegrityControlSha256(body),
  };
  return verifyWalmartListingIntegrityFrozenWorkOrder({
    work_order: workOrder,
    invocation,
    now: new Date(input.created_at),
  });
}
