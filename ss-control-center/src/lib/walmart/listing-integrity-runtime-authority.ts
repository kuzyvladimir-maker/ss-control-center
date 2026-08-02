import {
  verifyCurrentWalmartListingRepairOneSkuPermit,
  verifyWalmartListingRepairOneSkuPermitHistorical,
  type WalmartListingRepairOneSkuPermit,
} from "./listing-integrity-remediation-authority";
import {
  verifyWalmartListingIntegrityControlState,
  type WalmartListingIntegrityControlState,
} from "./listing-integrity-control-plane";

export const WALMART_LISTING_INTEGRITY_RUNTIME_AUTHORITY_SCHEMA =
  "walmart-listing-integrity-runtime-authority/v1" as const;

const CONTINUATION_STATES = new Set([
  "APPLIED",
  "PROPAGATING",
  "LIVE_REREAD",
]);
const admittedAuthorities = new WeakSet<object>();

declare const validatedRuntimeAuthorityBrand: unique symbol;

/**
 * Process-local capability. It cannot be serialized and trusted in another
 * process: the exact owner permit must be verified again after every restart.
 */
export interface ValidatedWalmartListingIntegrityRuntimeAuthority {
  readonly schema_version:
    typeof WALMART_LISTING_INTEGRITY_RUNTIME_AUTHORITY_SCHEMA;
  readonly stage: "ONE_SKU";
  readonly listing_key: string;
  readonly sku: string;
  readonly store_index: number;
  readonly current_state_body_sha256: string;
  readonly owner_permit_authorization_sha256: string;
  readonly plan_body_sha256: string;
  readonly apply_engine_release_sha256: string;
  readonly request_manifest_sha256: string;
  readonly request_payload_sha256: string;
  readonly permit_expires_at: string;
  readonly permit_window_mode: "CURRENT_FOR_EXECUTE" | "HISTORICAL_FOR_CONTINUATION";
  readonly automatic_retry_allowed: false;
  readonly automatic_replay_allowed: false;
  readonly maximum_marketplace_write_calls: 1;
  readonly [validatedRuntimeAuthorityBrand]: true;
}

export class WalmartListingIntegrityRuntimeAuthorityError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "WalmartListingIntegrityRuntimeAuthorityError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new WalmartListingIntegrityRuntimeAuthorityError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("RUNTIME_AUTHORITY_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactInstant(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("RUNTIME_AUTHORITY_INVALID", `${label} must be canonical UTC`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("RUNTIME_AUTHORITY_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

export function authorizeWalmartListingIntegrityRuntimeForOneSku(input: {
  current: WalmartListingIntegrityControlState;
  owner_permit: unknown;
  worker_release_id_sha256: string;
  now?: Date;
  verify_current_permit?: (
    permit: unknown,
    now: Date,
  ) => WalmartListingRepairOneSkuPermit;
  verify_historical_permit?: (
    permit: unknown,
  ) => WalmartListingRepairOneSkuPermit;
}): ValidatedWalmartListingIntegrityRuntimeAuthority {
  const current = verifyWalmartListingIntegrityControlState(input.current);
  if (!current.owner_permit_sha256 || !current.execution_package_sha256) {
    fail(
      "RUNTIME_AUTHORITY_STATE_UNBOUND",
      "one-SKU runtime requires an exact execution package and owner permit",
    );
  }
  const workerRelease = exactSha(
    input.worker_release_id_sha256,
    "worker_release_id_sha256",
  );
  const isContinuation = CONTINUATION_STATES.has(current.state);
  let permit: WalmartListingRepairOneSkuPermit;
  try {
    permit = isContinuation
      ? (input.verify_historical_permit
        ?? verifyWalmartListingRepairOneSkuPermitHistorical)(input.owner_permit)
      : (input.verify_current_permit
        ?? verifyCurrentWalmartListingRepairOneSkuPermit)(
          input.owner_permit,
          input.now ?? new Date(),
        );
  } catch (error) {
    fail(
      "RUNTIME_AUTHORITY_PERMIT_REJECTED",
      "exact owner permit did not pass the required signature/window verification",
      error,
    );
  }
  const body = permit.signed_body;
  if (permit.authorization_sha256 !== current.owner_permit_sha256
    || body.listing.channel !== "WALMART_US"
    || body.listing.listing_key !== current.identity.listing_key
    || body.listing.sku !== current.identity.sku
    || body.listing.store_index !== current.identity.store_index) {
    fail(
      "RUNTIME_AUTHORITY_LISTING_DRIFT",
      "owner permit differs from the exact current listing/control-state binding",
    );
  }
  if (body.apply_engine_release_sha256 !== workerRelease) {
    fail(
      "RUNTIME_AUTHORITY_RELEASE_DRIFT",
      "owner permit does not authorize the pinned worker release",
    );
  }
  if (body.claims.exact_listing_count !== 1
    || body.claims.marketplace_write_calls !== 1
    || body.claims.retry_allowed !== false
    || body.claims.automatic_reapply_allowed !== false
    || body.claims.mass_apply_allowed !== false
    || body.claims.delist !== false
    || body.claims.reprice !== false
    || body.claims.purchase !== false
    || body.claims.schedule !== false) {
    fail(
      "RUNTIME_AUTHORITY_POLICY_DRIFT",
      "owner permit grants authority outside one exact non-retriable listing repair",
    );
  }

  const authority = Object.freeze({
    schema_version: WALMART_LISTING_INTEGRITY_RUNTIME_AUTHORITY_SCHEMA,
    stage: "ONE_SKU" as const,
    listing_key: current.identity.listing_key,
    sku: current.identity.sku,
    store_index: current.identity.store_index,
    current_state_body_sha256: current.body_sha256,
    owner_permit_authorization_sha256: permit.authorization_sha256,
    plan_body_sha256: exactSha(body.plan_body_sha256, "permit plan_body_sha256"),
    apply_engine_release_sha256: body.apply_engine_release_sha256,
    request_manifest_sha256: exactSha(
      body.request_manifest_sha256,
      "permit request_manifest_sha256",
    ),
    request_payload_sha256: exactSha(
      body.request_payload_sha256,
      "permit request_payload_sha256",
    ),
    permit_expires_at: exactInstant(body.expires_at, "permit expires_at"),
    permit_window_mode: isContinuation
      ? "HISTORICAL_FOR_CONTINUATION" as const
      : "CURRENT_FOR_EXECUTE" as const,
    automatic_retry_allowed: false as const,
    automatic_replay_allowed: false as const,
    maximum_marketplace_write_calls: 1 as const,
  }) as ValidatedWalmartListingIntegrityRuntimeAuthority;
  admittedAuthorities.add(authority);
  return authority;
}

export function assertValidatedWalmartListingIntegrityRuntimeAuthority(
  value: ValidatedWalmartListingIntegrityRuntimeAuthority,
  current: WalmartListingIntegrityControlState,
): void {
  if (!admittedAuthorities.has(value as object)
    || value.schema_version !== WALMART_LISTING_INTEGRITY_RUNTIME_AUTHORITY_SCHEMA
    || value.stage !== "ONE_SKU"
    || value.listing_key !== current.identity.listing_key
    || value.sku !== current.identity.sku
    || value.store_index !== current.identity.store_index
    || value.current_state_body_sha256 !== current.body_sha256
    || value.owner_permit_authorization_sha256 !== current.owner_permit_sha256
    || value.automatic_retry_allowed !== false
    || value.automatic_replay_allowed !== false
    || value.maximum_marketplace_write_calls !== 1) {
    fail(
      "RUNTIME_AUTHORITY_NOT_ADMITTED",
      "runtime authority is absent, forged, stale, or belongs to another SKU revision",
    );
  }
}
