import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createWalmartListingIntegrityQueuedState,
  transitionWalmartListingIntegrityControlState,
  type WalmartListingIntegrityControlState,
} from "../listing-integrity-control-plane";
import {
  assertValidatedWalmartListingIntegrityRuntimeAuthority,
  authorizeWalmartListingIntegrityRuntimeForOneSku,
} from "../listing-integrity-runtime-authority";
import type {
  WalmartListingRepairOneSkuPermit,
} from "../listing-integrity-remediation-authority";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const RELEASE = H("release");
const PERMIT = H("permit");

function advance(
  current: WalmartListingIntegrityControlState,
  nextState: Parameters<typeof transitionWalmartListingIntegrityControlState>[0]["next_state"],
  extras: Partial<Parameters<typeof transitionWalmartListingIntegrityControlState>[0]> = {},
) {
  return transitionWalmartListingIntegrityControlState({
    current,
    next_state: nextState,
    transitioned_at: new Date(Date.parse(current.transitioned_at) + 1_000).toISOString(),
    evidence_sha256: H(`${current.state}-${nextState}`),
    ...extras,
  });
}

function applyRequesting() {
  let state = createWalmartListingIntegrityQueuedState({
    identity: {
      run_id: "run-1",
      pool_body_sha256: H("pool"),
      ordinal: 1,
      listing_key: "walmart:1:FaisalX-1144",
      sku: "FaisalX-1144",
      item_id: "3AVBUC6GCQH2",
      store_index: 1,
    },
    created_at: "2026-08-01T17:00:00.000Z",
    queue_evidence_sha256: H("queue"),
  });
  state = advance(state, "DIAGNOSING");
  state = advance(state, "ISSUE_PROVEN");
  state = advance(state, "REPAIR_PLANNED", { execution_package_sha256: H("package") });
  state = advance(state, "AWAITING_OWNER");
  state = advance(state, "OWNER_APPROVED", { owner_permit_sha256: PERMIT });
  return advance(state, "APPLY_REQUESTING");
}

function permit(
  state: WalmartListingIntegrityControlState,
  input: { listingKey?: string; release?: string; permitSha?: string } = {},
): WalmartListingRepairOneSkuPermit {
  return {
    authorization_sha256: input.permitSha ?? PERMIT,
    signed_body: {
      listing: {
        channel: "WALMART_US",
        store_index: 1,
        sku: state.identity.sku,
        listing_key: input.listingKey ?? state.identity.listing_key,
        item_id: "123456789",
      },
      apply_engine_release_sha256: input.release ?? RELEASE,
      plan_body_sha256: H("plan-body"),
      expires_at: "2026-08-01T18:30:00.000Z",
      request_manifest_sha256: H("manifest"),
      request_payload_sha256: H("payload"),
      claims: {
        exact_listing_count: 1,
        marketplace_write_calls: 1,
        retry_allowed: false,
        automatic_reapply_allowed: false,
        mass_apply_allowed: false,
        delist: false,
        reprice: false,
        purchase: false,
        schedule: false,
      },
    },
  } as unknown as WalmartListingRepairOneSkuPermit;
}

function authorize(
  state: WalmartListingIntegrityControlState,
  value: WalmartListingRepairOneSkuPermit,
  calls?: { current: number; historical: number },
) {
  return authorizeWalmartListingIntegrityRuntimeForOneSku({
    current: state,
    owner_permit: value,
    worker_release_id_sha256: RELEASE,
    verify_current_permit: () => {
      if (calls) calls.current += 1;
      return value;
    },
    verify_historical_permit: () => {
      if (calls) calls.historical += 1;
      return value;
    },
  });
}

test("exact current one-SKU permit creates a process-local authority", () => {
  const state = applyRequesting();
  const calls = { current: 0, historical: 0 };
  const admitted = authorize(state, permit(state), calls);
  assert.equal(admitted.stage, "ONE_SKU");
  assert.equal(admitted.permit_window_mode, "CURRENT_FOR_EXECUTE");
  assert.equal(calls.current, 1);
  assert.equal(calls.historical, 0);
  assert.doesNotThrow(() => (
    assertValidatedWalmartListingIntegrityRuntimeAuthority(admitted, state)
  ));
});

test("wrong listing, permit hash, or worker release is rejected", () => {
  const state = applyRequesting();
  for (const value of [
    permit(state, { listingKey: "walmart:1:another" }),
    permit(state, { permitSha: H("another-permit") }),
    permit(state, { release: H("another-release") }),
  ]) {
    assert.throws(() => authorize(state, value), /RUNTIME_AUTHORITY_(LISTING|RELEASE)_DRIFT/);
  }
});

test("permit verifier rejection remains fail-closed", () => {
  const state = applyRequesting();
  assert.throws(
    () => authorizeWalmartListingIntegrityRuntimeForOneSku({
      current: state,
      owner_permit: {},
      worker_release_id_sha256: RELEASE,
      verify_current_permit: () => {
        throw new Error("expired or bad Ed25519 signature");
      },
    }),
    /RUNTIME_AUTHORITY_PERMIT_REJECTED/,
  );
});

test("accepted-feed continuation uses historical verification and grants no replay", () => {
  let state = applyRequesting();
  state = advance(state, "APPLIED", {
    feed_id: "18C7B9727AC0538CA1F1E40C884D0BCD@AX8BBwA",
    marketplace_write_calls: 1,
  });
  const calls = { current: 0, historical: 0 };
  const admitted = authorize(state, permit(state), calls);
  assert.equal(admitted.permit_window_mode, "HISTORICAL_FOR_CONTINUATION");
  assert.equal(admitted.automatic_retry_allowed, false);
  assert.equal(admitted.automatic_replay_allowed, false);
  assert.equal(calls.current, 0);
  assert.equal(calls.historical, 1);
});

test("authority cannot be forged or reused after state revision changes", () => {
  const state = applyRequesting();
  const admitted = authorize(state, permit(state));
  const forged = { ...admitted } as typeof admitted;
  assert.throws(
    () => assertValidatedWalmartListingIntegrityRuntimeAuthority(forged, state),
    /RUNTIME_AUTHORITY_NOT_ADMITTED/,
  );
  const advanced = advance(state, "APPLIED", {
    feed_id: "18C7B9727AC0538CA1F1E40C884D0BCD@AX8BBwA",
    marketplace_write_calls: 1,
  });
  assert.throws(
    () => assertValidatedWalmartListingIntegrityRuntimeAuthority(admitted, advanced),
    /RUNTIME_AUTHORITY_NOT_ADMITTED/,
  );
});
