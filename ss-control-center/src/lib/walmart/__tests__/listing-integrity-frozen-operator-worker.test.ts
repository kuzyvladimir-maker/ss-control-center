import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createWalmartListingIntegrityQueuedState,
  transitionWalmartListingIntegrityControlState,
  type WalmartListingIntegrityControlState,
} from "../listing-integrity-control-plane";
import {
  runWalmartListingIntegrityFrozenOperatorWorkerOnce,
  type WalmartListingIntegrityFrozenWorkerBinding,
  type WalmartListingIntegrityFrozenWorkerInvocation,
} from "../listing-integrity-frozen-operator-worker";
import {
  authorizeWalmartListingIntegrityRuntimeForOneSku,
} from "../listing-integrity-runtime-authority";
import type {
  WalmartListingRepairOneSkuPermit,
} from "../listing-integrity-remediation-authority";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const PACKAGE = H("package");
const PERMIT = H("permit");
const FEED = "18C7B9727AC0538CA1F1E40C884D0BCD@AX8BBwA";

const BINDING: WalmartListingIntegrityFrozenWorkerBinding = Object.freeze({
  run_release_id_sha256: H("release"),
  run_manifest_sha256: H("manifest"),
  worker_release_id_sha256: H("release"),
  worker_manifest_sha256: H("manifest"),
  global_admission_identity_sha256: H("global-admission"),
});

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

function ownerApproved() {
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
  state = advance(state, "REPAIR_PLANNED", { execution_package_sha256: PACKAGE });
  state = advance(state, "AWAITING_OWNER");
  return advance(state, "OWNER_APPROVED", { owner_permit_sha256: PERMIT });
}

function applyRequesting() {
  return advance(ownerApproved(), "APPLY_REQUESTING");
}

function applied() {
  return advance(applyRequesting(), "APPLIED", {
    feed_id: FEED,
    marketplace_write_calls: 1,
  });
}

function liveReread() {
  return advance(applied(), "LIVE_REREAD");
}

function persisted(state: WalmartListingIntegrityControlState) {
  return {
    state,
    artifact: {
      artifact_id: "artifact-1",
      role: "FROZEN_OPERATOR_APPLIED",
      sha256: H("receipt"),
      locator: `sha256:${H("receipt")}`,
      byte_size: 2,
    },
    event: {
      event_id: "event-1",
      sequence: 1,
      event_type: "STATE_APPLY_REQUESTING_TO_APPLIED",
      payload_sha256: H("payload"),
      previous_event_hash: "0".repeat(64),
      event_hash: H("event"),
    },
  };
}

function permitFor(
  state: WalmartListingIntegrityControlState,
  overrides: Record<string, unknown> = {},
): WalmartListingRepairOneSkuPermit {
  return {
    authorization_sha256: state.owner_permit_sha256,
    signed_body: {
      listing: {
        channel: "WALMART_US",
        listing_key: state.identity.listing_key,
        sku: state.identity.sku,
        store_index: state.identity.store_index,
        item_id: "123456789",
      },
      apply_engine_release_sha256: BINDING.worker_release_id_sha256,
      plan_body_sha256: H("plan-body"),
      expires_at: "2026-08-01T18:30:00.000Z",
      request_manifest_sha256: H("request-manifest"),
      request_payload_sha256: H("request-payload"),
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
      ...overrides,
    },
  } as unknown as WalmartListingRepairOneSkuPermit;
}

function authority(
  state: WalmartListingIntegrityControlState,
  overrides: Record<string, unknown> = {},
) {
  const permit = permitFor(state, overrides);
  return authorizeWalmartListingIntegrityRuntimeForOneSku({
    current: state,
    owner_permit: permit,
    worker_release_id_sha256: BINDING.worker_release_id_sha256,
    verify_current_permit: () => permit,
    verify_historical_permit: () => permit,
  });
}

test("default-OFF worker performs no invocation and no persistence", async () => {
  let invocations = 0;
  let persists = 0;
  const result = await runWalmartListingIntegrityFrozenOperatorWorkerOnce({
    authority: null,
    items: [applyRequesting()],
    binding: BINDING,
    invoke_frozen_operator: async () => {
      invocations += 1;
      return Buffer.from("{}");
    },
    persist_receipt: async () => {
      persists += 1;
      return persisted(applyRequesting());
    },
  });
  assert.equal(result.status, "STOPPED_DEFAULT_OFF");
  assert.equal(invocations, 0);
  assert.equal(persists, 0);
});

test("owner-approved state cannot invoke until APPLY_REQUESTING is durably admitted", async () => {
  let invocations = 0;
  const result = await runWalmartListingIntegrityFrozenOperatorWorkerOnce({
    authority: authority(ownerApproved()),
    items: [ownerApproved()],
    binding: BINDING,
    invoke_frozen_operator: async () => {
      invocations += 1;
      return Buffer.from("{}");
    },
  });
  assert.equal(result.status, "WAITING_APPLY_REQUESTING_TRANSITION");
  assert.equal(invocations, 0);
});

test("APPLY_REQUESTING invokes the pinned execute exactly once and persists its receipt", async () => {
  const current = applyRequesting();
  const receipt = Buffer.from("{}", "utf8");
  const invocations: WalmartListingIntegrityFrozenWorkerInvocation[] = [];
  let persists = 0;
  const result = await runWalmartListingIntegrityFrozenOperatorWorkerOnce({
    authority: authority(current),
    items: [current],
    binding: BINDING,
    invoke_frozen_operator: async (invocation) => {
      invocations.push(invocation);
      return receipt;
    },
    persist_receipt: async (input) => {
      persists += 1;
      assert.equal(input.current.body_sha256, current.body_sha256);
      assert.equal(input.receipt_bytes, receipt);
      return persisted(current);
    },
  });
  assert.equal(result.status, "OPERATOR_RECEIPT_PERSISTED");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.command, "execute");
  assert.equal(invocations[0]?.maximum_operator_calls, 1);
  assert.equal(invocations[0]?.automatic_retry_allowed, false);
  assert.equal(invocations[0]?.automatic_replay_allowed, false);
  assert.equal(persists, 1);
});

test("accepted feed routes only to resume and terminal feed routes only to qualify", async () => {
  for (const [state, expected] of [
    [applied(), "resume"],
    [liveReread(), "qualify"],
  ] as const) {
    let actual: string | null = null;
    await runWalmartListingIntegrityFrozenOperatorWorkerOnce({
      authority: authority(state),
      items: [state],
      binding: BINDING,
      invoke_frozen_operator: async (invocation) => {
        actual = invocation.command;
        assert.equal(invocation.feed_id, FEED);
        return Buffer.from("{}", "utf8");
      },
      persist_receipt: async () => persisted(state),
    });
    assert.equal(actual, expected);
  }
});

test("release drift and an unknown invocation outcome fail closed without retry", async () => {
  let invocations = 0;
  await assert.rejects(
    runWalmartListingIntegrityFrozenOperatorWorkerOnce({
      authority: authority(applyRequesting()),
      items: [applyRequesting()],
      binding: { ...BINDING, worker_manifest_sha256: H("drift") },
      invoke_frozen_operator: async () => {
        invocations += 1;
        return Buffer.from("{}");
      },
    }),
    /WORKER_RELEASE_DRIFT/,
  );
  assert.equal(invocations, 0);

  await assert.rejects(
    runWalmartListingIntegrityFrozenOperatorWorkerOnce({
      authority: authority(applyRequesting()),
      items: [applyRequesting()],
      binding: BINDING,
      invoke_frozen_operator: async () => {
        invocations += 1;
        throw new Error("connection ended after send");
      },
    }),
    /WORKER_INVOCATION_FAILED_UNKNOWN_OUTCOME/,
  );
  assert.equal(invocations, 1);
});
