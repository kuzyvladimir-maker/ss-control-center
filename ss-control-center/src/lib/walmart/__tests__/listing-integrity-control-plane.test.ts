import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createWalmartListingIntegrityQueuedState,
  nextWalmartListingIntegritySchedulerDecision,
  recoverWalmartListingIntegrityCaptureLogFalseQuarantine,
  transitionWalmartListingIntegrityControlState,
  verifyWalmartListingIntegrityControlState,
  type WalmartListingIntegrityControlState,
} from "../listing-integrity-control-plane.ts";
import {
  buildWalmartListingIntegrityDiagnosisStartEvidence,
} from "../listing-integrity-production-diagnosis.server.ts";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const T0 = "2026-08-01T17:00:00.000Z";

function queued(ordinal = 1) {
  return createWalmartListingIntegrityQueuedState({
    identity: {
      run_id: "listing-integrity-run-1",
      pool_body_sha256: H("pool"),
      ordinal,
      listing_key: `walmart:1:FaisalX-${1143 + ordinal}`,
      sku: `FaisalX-${1143 + ordinal}`,
      item_id: String(8394316917 + ordinal),
      store_index: 1,
    },
    created_at: T0,
    queue_evidence_sha256: H(`queue-${ordinal}`),
  });
}

function advance(
  current: WalmartListingIntegrityControlState,
  next: Parameters<typeof transitionWalmartListingIntegrityControlState>[0]["next_state"],
  extras: Partial<Parameters<typeof transitionWalmartListingIntegrityControlState>[0]> = {},
) {
  return transitionWalmartListingIntegrityControlState({
    current,
    next_state: next,
    transitioned_at: new Date(Date.parse(current.transitioned_at) + 1_000).toISOString(),
    evidence_sha256: H(`${current.state}-${next}`),
    ...extras,
  });
}

test("default-OFF scheduler never starts even a read-only queued SKU", () => {
  assert.deepEqual(nextWalmartListingIntegritySchedulerDecision({
    stage: "OFF",
    items: [queued()],
  }), {
    action: "STOP_DEFAULT_OFF",
    listing_key: "walmart:1:FaisalX-1144",
  });
});

test("read-only stage diagnoses but cannot cross the write boundary", () => {
  const issue = advance(advance(queued(), "DIAGNOSING"), "ISSUE_PROVEN");
  const planned = advance(issue, "REPAIR_PLANNED");
  const awaiting = advance(planned, "AWAITING_OWNER");
  const approved = advance(awaiting, "OWNER_APPROVED", {
    execution_package_sha256: H("package"),
    owner_permit_sha256: H("permit"),
  });
  assert.equal(nextWalmartListingIntegritySchedulerDecision({
    stage: "READ_ONLY",
    items: [approved],
  }).action, "STOP_DEFAULT_OFF");
});

test("one-SKU lifecycle binds the package and permit before the sole write", () => {
  let state = advance(advance(queued(), "DIAGNOSING"), "ISSUE_PROVEN");
  state = advance(state, "REPAIR_PLANNED", { execution_package_sha256: H("package") });
  state = advance(state, "AWAITING_OWNER");
  state = advance(state, "OWNER_APPROVED", { owner_permit_sha256: H("permit") });
  state = advance(state, "APPLY_REQUESTING");
  assert.equal(nextWalmartListingIntegritySchedulerDecision({
    stage: "ONE_SKU",
    items: [state],
  }).action, "RUN_FROZEN_EXECUTE");
  state = advance(state, "APPLIED", {
    feed_id: "18C7B9727AC0538CA1F1E40C884D0BCD@AX8BBwA",
    marketplace_write_calls: 1,
  });
  assert.deepEqual(nextWalmartListingIntegritySchedulerDecision({
    stage: "ONE_SKU",
    items: [state],
  }), {
    action: "POLL_EXACT_FEED_GET_ONLY",
    listing_key: "walmart:1:FaisalX-1144",
    feed_id: "18C7B9727AC0538CA1F1E40C884D0BCD@AX8BBwA",
  });
});

test("unknown POST outcome is terminal manual review and cannot replay", () => {
  let state = advance(advance(queued(), "DIAGNOSING"), "ISSUE_PROVEN");
  state = advance(state, "REPAIR_PLANNED", { execution_package_sha256: H("package") });
  state = advance(state, "AWAITING_OWNER");
  state = advance(state, "OWNER_APPROVED", { owner_permit_sha256: H("permit") });
  state = advance(state, "APPLY_REQUESTING");
  state = advance(state, "MANUAL_REVIEW", { marketplace_write_calls: 1 });
  assert.equal(nextWalmartListingIntegritySchedulerDecision({
    stage: "ONE_SKU",
    items: [state],
  }).action, "STOP_MANUAL_REVIEW");
  assert.throws(() => advance(state, "APPLIED"), /not permitted/);
});

test("strict queue rejects a later SKU that advanced before its predecessor", () => {
  const first = advance(queued(1), "DIAGNOSING");
  const second = advance(queued(2), "DIAGNOSING");
  assert.throws(() => nextWalmartListingIntegritySchedulerDecision({
    stage: "READ_ONLY",
    items: [first, second],
  }), /later SKU advanced/);
});

test("strict queue permits only one in-flight apply", () => {
  const makeApplied = (ordinal: number) => {
    let state = advance(advance(queued(ordinal), "DIAGNOSING"), "ISSUE_PROVEN");
    state = advance(state, "REPAIR_PLANNED", { execution_package_sha256: H(`package-${ordinal}`) });
    state = advance(state, "AWAITING_OWNER");
    state = advance(state, "OWNER_APPROVED", { owner_permit_sha256: H(`permit-${ordinal}`) });
    return advance(state, "APPLY_REQUESTING");
  };
  assert.throws(() => nextWalmartListingIntegritySchedulerDecision({
    stage: "ONE_SKU",
    items: [makeApplied(1), makeApplied(2)],
  }), /more than one live apply/);
});

test("Qualification PASS unblocks exactly the next queued SKU", () => {
  let first = advance(advance(queued(1), "DIAGNOSING"), "ISSUE_PROVEN");
  first = advance(first, "REPAIR_PLANNED", { execution_package_sha256: H("package") });
  first = advance(first, "AWAITING_OWNER");
  first = advance(first, "OWNER_APPROVED", { owner_permit_sha256: H("permit") });
  first = advance(first, "APPLY_REQUESTING");
  first = advance(first, "APPLIED", {
    feed_id: "feed-1",
    marketplace_write_calls: 1,
  });
  first = advance(first, "PROPAGATING");
  first = advance(first, "LIVE_REREAD");
  first = advance(first, "QUALIFIED_PASS");
  assert.deepEqual(nextWalmartListingIntegritySchedulerDecision({
    stage: "ONE_SKU",
    items: [first, queued(2)],
  }), {
    action: "RUN_DIAGNOSE",
    listing_key: "walmart:1:FaisalX-1145",
  });
});

test("pending Qualification repeats fresh live reread and never returns to feed polling", () => {
  let state = advance(advance(queued(), "DIAGNOSING"), "ISSUE_PROVEN");
  state = advance(state, "REPAIR_PLANNED", { execution_package_sha256: H("package") });
  state = advance(state, "AWAITING_OWNER");
  state = advance(state, "OWNER_APPROVED", { owner_permit_sha256: H("permit") });
  state = advance(state, "APPLY_REQUESTING");
  state = advance(state, "APPLIED", {
    feed_id: "feed-1",
    marketplace_write_calls: 1,
  });
  state = advance(state, "PROPAGATING");
  state = advance(state, "LIVE_REREAD");

  const pending = advance(state, "LIVE_REREAD");
  assert.equal(pending.revision, state.revision + 1);
  assert.equal(pending.previous_state_sha256, state.body_sha256);
  assert.deepEqual(nextWalmartListingIntegritySchedulerDecision({
    stage: "ONE_SKU",
    items: [pending],
  }), {
    action: "RUN_FRESH_QUALIFICATION",
    listing_key: "walmart:1:FaisalX-1144",
    feed_id: "feed-1",
  });
});

test("tampering with a sealed state fails closed", () => {
  const state = queued();
  assert.throws(() => verifyWalmartListingIntegrityControlState({
    ...state,
    automatic_retry_allowed: true,
  }), /seal or immutable policy differs/);
});

test("capture-log incident recovery requeues only zero-write diagnosis states", () => {
  const diagnosing = advance(queued(), "DIAGNOSING");
  const quarantined = advance(diagnosing, "QUARANTINED_SOURCE_REQUIRED");
  const recovered = recoverWalmartListingIntegrityCaptureLogFalseQuarantine({
    current: quarantined,
    recovered_at: "2026-08-01T23:40:00.000Z",
    recovery_evidence_sha256: H("capture-log-recovery"),
  });
  assert.equal(recovered.state, "QUEUED");
  assert.equal(recovered.revision, quarantined.revision + 1);
  assert.equal(recovered.previous_state_sha256, quarantined.body_sha256);
  assert.equal(recovered.marketplace_write_calls, 0);
  const firstStart = buildWalmartListingIntegrityDiagnosisStartEvidence(queued());
  const recoveredStart = buildWalmartListingIntegrityDiagnosisStartEvidence(recovered);
  assert.notDeepEqual(recoveredStart.predecessor, firstStart.predecessor);
  assert.equal(recoveredStart.predecessor.revision, recovered.revision);
  assert.equal(recoveredStart.predecessor.body_sha256, recovered.body_sha256);
  assert.throws(() => recoverWalmartListingIntegrityCaptureLogFalseQuarantine({
    current: advance(diagnosing, "MANUAL_REVIEW"),
    recovered_at: "2026-08-01T23:40:00.000Z",
    recovery_evidence_sha256: H("forbidden"),
  }), /zero-write diagnosis-only state/u);
});
