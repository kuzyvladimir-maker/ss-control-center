import {
  nextWalmartListingIntegritySchedulerDecision,
  verifyWalmartListingIntegrityControlState,
  type WalmartListingIntegrityControlState,
} from "./listing-integrity-control-plane";
import {
  assertValidatedWalmartListingIntegrityRuntimeAuthority,
  type ValidatedWalmartListingIntegrityRuntimeAuthority,
} from "./listing-integrity-runtime-authority";
import {
  admitAndPersistWalmartListingIntegrityOperatorReceipt,
  type WalmartListingIntegrityControlRawTransactionHost,
  type WalmartListingIntegrityPersistedTransition,
} from "./listing-integrity-control-transition-store.server";

export const WALMART_LISTING_INTEGRITY_FROZEN_WORKER_SCHEMA =
  "walmart-listing-integrity-frozen-operator-worker/v1" as const;

export interface WalmartListingIntegrityFrozenWorkerBinding {
  run_release_id_sha256: string;
  run_manifest_sha256: string;
  worker_release_id_sha256: string;
  worker_manifest_sha256: string;
  global_admission_identity_sha256: string;
}

export interface WalmartListingIntegrityFrozenWorkerInvocation {
  schema_version: typeof WALMART_LISTING_INTEGRITY_FROZEN_WORKER_SCHEMA;
  command: "execute" | "resume" | "qualify";
  listing_key: string;
  sku: string;
  current_state_body_sha256: string;
  execution_package_sha256: string;
  owner_permit_sha256: string;
  plan_body_sha256: string;
  feed_id: string | null;
  frozen_release_id_sha256: string;
  manifest_sha256: string;
  global_admission_identity_sha256: string;
  automatic_retry_allowed: false;
  automatic_replay_allowed: false;
  maximum_operator_calls: 1;
}

export type WalmartListingIntegrityFrozenWorkerResult =
  | {
      status: "STOPPED_DEFAULT_OFF" | "WAITING_NON_OPERATOR_STAGE";
      listing_key: string | null;
      invocation_called: false;
      persisted: null;
    }
  | {
      status: "WAITING_APPLY_REQUESTING_TRANSITION";
      listing_key: string;
      invocation_called: false;
      persisted: null;
    }
  | {
      status: "OPERATOR_RECEIPT_PERSISTED";
      listing_key: string;
      invocation_called: true;
      persisted: WalmartListingIntegrityPersistedTransition;
    };

export class WalmartListingIntegrityFrozenWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "WalmartListingIntegrityFrozenWorkerError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new WalmartListingIntegrityFrozenWorkerError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("WORKER_BINDING_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function verifyBinding(
  value: WalmartListingIntegrityFrozenWorkerBinding,
): WalmartListingIntegrityFrozenWorkerBinding {
  const binding = {
    run_release_id_sha256: sha(value.run_release_id_sha256, "run release ID"),
    run_manifest_sha256: sha(value.run_manifest_sha256, "run manifest"),
    worker_release_id_sha256: sha(value.worker_release_id_sha256, "worker release ID"),
    worker_manifest_sha256: sha(value.worker_manifest_sha256, "worker manifest"),
    global_admission_identity_sha256: sha(
      value.global_admission_identity_sha256,
      "global admission identity",
    ),
  };
  if (binding.run_release_id_sha256 !== binding.worker_release_id_sha256
    || binding.run_manifest_sha256 !== binding.worker_manifest_sha256) {
    fail("WORKER_RELEASE_DRIFT", "active run differs from the pinned frozen worker release");
  }
  return binding;
}

function activeItem(items: readonly WalmartListingIntegrityControlState[]) {
  const terminal = new Set([
    "AUDITED_PASS",
    "QUALIFIED_PASS",
    "QUARANTINED_SOURCE_REQUIRED",
    "QUARANTINED_UNRESOLVED",
  ]);
  return items.find((item) => !terminal.has(item.state)) ?? null;
}

function invocationFor(input: {
  current: WalmartListingIntegrityControlState;
  binding: WalmartListingIntegrityFrozenWorkerBinding;
  authority: ValidatedWalmartListingIntegrityRuntimeAuthority;
}): WalmartListingIntegrityFrozenWorkerInvocation {
  const current = input.current;
  if (!current.execution_package_sha256 || !current.owner_permit_sha256) {
    fail("WORKER_STATE_INVALID", "operator action lacks exact package or owner permit binding");
  }
  const command = current.state === "APPLY_REQUESTING"
    ? "execute"
    : current.state === "APPLIED" || current.state === "PROPAGATING"
      ? "resume"
      : current.state === "LIVE_REREAD"
        ? "qualify" : null;
  if (!command) {
    fail("WORKER_STATE_INVALID", `state ${current.state} is not an admitted operator action`);
  }
  if ((command === "resume" || command === "qualify") && !current.feed_id) {
    fail("WORKER_STATE_INVALID", `${command} requires the exact accepted feed`);
  }
  return Object.freeze({
    schema_version: WALMART_LISTING_INTEGRITY_FROZEN_WORKER_SCHEMA,
    command,
    listing_key: current.identity.listing_key,
    sku: current.identity.sku,
    current_state_body_sha256: current.body_sha256,
    execution_package_sha256: current.execution_package_sha256,
    owner_permit_sha256: current.owner_permit_sha256,
    plan_body_sha256: input.authority.plan_body_sha256,
    feed_id: current.feed_id,
    frozen_release_id_sha256: input.binding.worker_release_id_sha256,
    manifest_sha256: input.binding.worker_manifest_sha256,
    global_admission_identity_sha256:
      input.binding.global_admission_identity_sha256,
    automatic_retry_allowed: false,
    automatic_replay_allowed: false,
    maximum_operator_calls: 1,
  });
}

export function buildWalmartListingIntegrityFrozenWorkerInvocation(input: {
  current: WalmartListingIntegrityControlState;
  binding: WalmartListingIntegrityFrozenWorkerBinding;
  authority: ValidatedWalmartListingIntegrityRuntimeAuthority;
}): WalmartListingIntegrityFrozenWorkerInvocation {
  const current = verifyWalmartListingIntegrityControlState(input.current);
  assertValidatedWalmartListingIntegrityRuntimeAuthority(input.authority, current);
  return invocationFor({
    current,
    binding: verifyBinding(input.binding),
    authority: input.authority,
  });
}

export async function runWalmartListingIntegrityFrozenOperatorWorkerOnce(input: {
  /** No process-local validated authority means runtime OFF. */
  authority: ValidatedWalmartListingIntegrityRuntimeAuthority | null;
  items: readonly WalmartListingIntegrityControlState[];
  binding: WalmartListingIntegrityFrozenWorkerBinding;
  invoke_frozen_operator: (
    invocation: WalmartListingIntegrityFrozenWorkerInvocation,
  ) => Promise<Uint8Array>;
  store?: WalmartListingIntegrityControlRawTransactionHost;
  persist_receipt?: typeof admitAndPersistWalmartListingIntegrityOperatorReceipt;
}): Promise<WalmartListingIntegrityFrozenWorkerResult> {
  const items = input.items.map(verifyWalmartListingIntegrityControlState);
  const stage = input.authority === null ? "OFF" as const : "ONE_SKU" as const;
  const decision = nextWalmartListingIntegritySchedulerDecision({
    stage,
    items,
  });
  if (decision.action === "STOP_DEFAULT_OFF") {
    return {
      status: "STOPPED_DEFAULT_OFF",
      listing_key: decision.listing_key,
      invocation_called: false,
      persisted: null,
    };
  }
  const current = activeItem(items);
  if (!current) {
    return {
      status: "WAITING_NON_OPERATOR_STAGE",
      listing_key: null,
      invocation_called: false,
      persisted: null,
    };
  }
  if (!input.authority) fail("WORKER_AUTHORITY_MISSING", "one-SKU worker authority is absent");
  assertValidatedWalmartListingIntegrityRuntimeAuthority(input.authority, current);
  if (decision.action === "RUN_FROZEN_EXECUTE" && current.state === "OWNER_APPROVED") {
    return {
      status: "WAITING_APPLY_REQUESTING_TRANSITION",
      listing_key: current.identity.listing_key,
      invocation_called: false,
      persisted: null,
    };
  }
  if (!["RUN_FROZEN_EXECUTE", "POLL_EXACT_FEED_GET_ONLY", "RUN_FRESH_QUALIFICATION"]
    .includes(decision.action)) {
    return {
      status: "WAITING_NON_OPERATOR_STAGE",
      listing_key: current.identity.listing_key,
      invocation_called: false,
      persisted: null,
    };
  }

  const invocation = buildWalmartListingIntegrityFrozenWorkerInvocation({
    current,
    binding: input.binding,
    authority: input.authority,
  });
  let receiptBytes: Uint8Array;
  try {
    receiptBytes = await input.invoke_frozen_operator(invocation);
  } catch (error) {
    fail(
      "WORKER_INVOCATION_FAILED_UNKNOWN_OUTCOME",
      "frozen operator invocation failed; automatic retry/replay is forbidden",
      error,
    );
  }
  const persist = input.persist_receipt
    ?? admitAndPersistWalmartListingIntegrityOperatorReceipt;
  const persisted = await persist({
    stage,
    current,
    receipt_bytes: receiptBytes,
    ...(input.store ? { store: input.store } : {}),
  });
  return {
    status: "OPERATOR_RECEIPT_PERSISTED",
    listing_key: current.identity.listing_key,
    invocation_called: true,
    persisted,
  };
}
