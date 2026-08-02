import {
  walmartListingIntegrityControlSha256,
} from "./listing-integrity-control-plane";
import type {
  WalmartListingIntegrityControlStoreStatus,
} from "./listing-integrity-control-store.server";

export const WALMART_LISTING_INTEGRITY_CONTROL_WORKER_TICK_SCHEMA =
  "walmart-listing-integrity-control-worker-tick/v1" as const;

export interface WalmartListingIntegrityControlWorkerTick {
  schema_version: typeof WALMART_LISTING_INTEGRITY_CONTROL_WORKER_TICK_SCHEMA;
  observed_at: string;
  status: "NOT_INSTALLED" | "DEFAULT_OFF";
  run_id: string | null;
  listing_key: string | null;
  sku: string | null;
  state: string | null;
  decision: "INSTALL_REQUIRED" | "NO_ACTIVE_RUN" | "STOP_DEFAULT_OFF";
  resume_token: string | null;
  external_effects: {
    database_reads: number;
    database_writes: 0;
    walmart_reads: 0;
    walmart_writes: 0;
    model_calls: 0;
  };
  runtime_activation_granted: false;
  body_sha256: string;
}

function canonicalInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("WALMART_LISTING_INTEGRITY_WORKER_INVALID: observed_at must be canonical UTC");
  }
  return value;
}

export function buildWalmartListingIntegrityControlWorkerTick(input: {
  status: WalmartListingIntegrityControlStoreStatus;
  observed_at: string;
}): WalmartListingIntegrityControlWorkerTick {
  const observedAt = canonicalInstant(input.observed_at);
  const active = input.status.activeRun?.activeItem ?? null;
  const status = input.status.installation === "NOT_INSTALLED"
    ? "NOT_INSTALLED" as const : "DEFAULT_OFF" as const;
  const decision = status === "NOT_INSTALLED"
    ? "INSTALL_REQUIRED" as const
    : input.status.activeRun === null
      ? "NO_ACTIVE_RUN" as const : "STOP_DEFAULT_OFF" as const;
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_CONTROL_WORKER_TICK_SCHEMA,
    observed_at: observedAt,
    status,
    run_id: input.status.activeRun?.runId ?? null,
    listing_key: active?.listingKey ?? null,
    sku: active?.sku ?? null,
    state: active?.state ?? null,
    decision,
    resume_token: active
      ? walmartListingIntegrityControlSha256({
        run_id: input.status.activeRun?.runId,
        listing_key: active.listingKey,
        revision: active.revision,
        transitioned_at: active.transitionedAt,
      }) : null,
    external_effects: {
      database_reads: input.status.installation === "INSTALLED" ? 2 : 1,
      database_writes: 0 as const,
      walmart_reads: 0 as const,
      walmart_writes: 0 as const,
      model_calls: 0 as const,
    },
    runtime_activation_granted: false as const,
  };
  return Object.freeze({
    ...body,
    body_sha256: walmartListingIntegrityControlSha256(body),
  });
}
