import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  admitWalmartListingIntegrityOperatorReceipt,
} from "../listing-integrity-operator-admission.ts";
import {
  createWalmartListingIntegrityQueuedState,
  nextWalmartListingIntegritySchedulerDecision,
  transitionWalmartListingIntegrityControlState,
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
} from "../listing-integrity-control-plane.ts";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const PACKAGE = H("package");
const PERMIT = H("permit");
const FEED = "18C7B9727AC0538CA1F1E40C884D0BCD@AX8BBwA";

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
      // Controlled pool stores WPID; operator receipt below stores numeric buyer item ID.
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
  state = advance(state, "OWNER_APPROVED", { owner_permit_sha256: PERMIT });
  return advance(state, "APPLY_REQUESTING");
}

function listing() {
  return {
    channel: "WALMART_US",
    item_id: "8394316918",
    listing_key: "walmart:1:FaisalX-1144",
    sku: "FaisalX-1144",
    store_index: 1,
  };
}

function receiptBytes(body: Record<string, unknown>) {
  const receipt = {
    ...body,
    body_sha256: walmartListingIntegrityControlSha256(body),
  };
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

function executeReceipt(overrides: Record<string, unknown> = {}) {
  return receiptBytes({
    schema_version: "walmart-listing-repair-operator-receipt/v1",
    command: "execute",
    completed_at: "2026-08-01T17:10:00.000Z",
    listing: listing(),
    status: "APPLIED_PROPAGATING",
    reason_code: "FEED_STATUS_HTTP_PENDING",
    feed_id: FEED,
    execution_package_artifact_sha256: PACKAGE,
    permit_authorization_sha256: PERMIT,
    marketplace_write_calls: 1,
    automatic_reapply_allowed: false,
    transport_counts: {
      feed_status_get_calls: 20,
      maintenance_post_calls: 1,
      oauth_token_calls: 1,
      total_http_calls: 22,
    },
    ...overrides,
  });
}

function resumeReceipt(status: "APPLIED_PROPAGATING" | "SUCCEEDED" | "FAILED") {
  return receiptBytes({
    schema_version: "walmart-listing-repair-operator-receipt/v1",
    command: "resume",
    completed_at: status === "APPLIED_PROPAGATING"
      ? "2026-08-01T17:11:00.000Z" : "2026-08-01T17:12:00.000Z",
    listing: listing(),
    status,
    reason_code: status === "APPLIED_PROPAGATING" ? "FEED_NOT_TERMINAL" : null,
    feed_id: FEED,
    execution_package_artifact_sha256: PACKAGE,
    permit_authorization_sha256: PERMIT,
    marketplace_write_calls: 1,
    continuation_marketplace_write_calls: 0,
    automatic_reapply_allowed: false,
    external_effects: {
      database_writes: 0,
      model_calls: 0,
      network_calls: "BOUNDED_GET_ONLY",
      paid_provider_calls: 0,
      walmart_content_writes: 0,
    },
    transport_counts: {
      feed_status_get_calls: 1,
      maintenance_post_calls: 0,
      oauth_token_calls: 1,
      total_http_calls: 2,
    },
  });
}

const FACETS = Object.freeze({
  attributes: "PASS",
  bullets: "PASS",
  description: "PASS",
  exact_listing_identity: "PASS",
  exact_repair_target: "PASS",
  fresh_authenticated_live_reread: "PASS",
  gallery: "PASS",
  main: "PASS",
  pack_count: "PASS",
  product_and_variant: "PASS",
  published_and_indexed: "PASS",
  terminal_apply_custody: "PASS",
  title: "PASS",
  unchanged_fields_preserved: "PASS",
});

function qualificationReceipt(
  status: "PASS" | "PENDING_PROPAGATION" | "FAIL",
  overrides: Record<string, unknown> = {},
) {
  const facets = status === "PENDING_PROPAGATION"
    ? { ...FACETS, main: "FAIL", exact_repair_target: "FAIL", unchanged_fields_preserved: "FAIL" }
    : FACETS;
  return receiptBytes({
    schema_version: "walmart-listing-repair-operator-receipt/v1",
    command: "qualify",
    completed_at: "2026-08-01T17:13:00.000Z",
    listing: listing(),
    status,
    feed_id: FEED,
    execution_package_artifact_sha256: PACKAGE,
    permit_authorization_sha256: PERMIT,
    automatic_reapply_allowed: false,
    external_effects: {
      database_writes: 0,
      model_calls: 0,
      network_calls: "BOUNDED_LIVE_REREAD",
      paid_provider_calls: 0,
      walmart_content_writes: 0,
    },
    qualification: {
      verdict: status,
      automatic_reapply_allowed: false,
      marketplace_write_authorized: false,
      next_sku_unblocked: status === "PASS",
      facets,
      authority: {
        terminal_apply_custody_verified: true,
        live_capture_created_by_qualifier: true,
        cached_capture_accepted: false,
        caller_authored_verdict_accepted: false,
      },
      propagation: {
        recheck_same_sku_without_write: status === "PENDING_PROPAGATION",
      },
      ...overrides,
    },
  });
}

test("OFF and READ_ONLY runtime reject frozen operator receipt admission", () => {
  const current = applyRequesting();
  for (const stage of ["OFF", "READ_ONLY"] as const) {
    assert.throws(
      () => admitWalmartListingIntegrityOperatorReceipt({
        stage,
        current,
        receipt_bytes: executeReceipt(),
      }),
      /requires explicitly activated ONE_SKU/,
    );
  }
});

test("execute admits exactly one POST and binds the accepted feed", () => {
  const applied = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: applyRequesting(),
    receipt_bytes: executeReceipt(),
  });
  assert.equal(applied.state, "APPLIED");
  assert.equal(applied.marketplace_write_calls, 1);
  assert.equal(applied.feed_id, FEED);
  assert.equal(applied.execution_package_sha256, PACKAGE);
  assert.equal(applied.owner_permit_sha256, PERMIT);
});

test("controlled-pool WPID and buyer item ID remain separate exact namespaces", () => {
  const applied = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: applyRequesting(),
    receipt_bytes: executeReceipt(),
  });
  assert.equal(applied.identity.item_id, "3AVBUC6GCQH2");
  assert.equal(applied.feed_id, FEED);
});

test("resume adds zero writes and moves only the exact feed to live reread", () => {
  const applied = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: applyRequesting(),
    receipt_bytes: executeReceipt(),
  });
  const propagating = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: applied,
    receipt_bytes: resumeReceipt("APPLIED_PROPAGATING"),
  });
  assert.equal(propagating.state, "PROPAGATING");
  const liveReread = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: propagating,
    receipt_bytes: resumeReceipt("SUCCEEDED"),
  });
  assert.equal(liveReread.state, "LIVE_REREAD");
  assert.equal(liveReread.marketplace_write_calls, 1);
});

test("pending Qualification repeats live reread without returning to feed polling", () => {
  const applied = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: applyRequesting(),
    receipt_bytes: executeReceipt(),
  });
  const liveReread = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: applied,
    receipt_bytes: resumeReceipt("SUCCEEDED"),
  });
  const pending = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: liveReread,
    receipt_bytes: qualificationReceipt("PENDING_PROPAGATION"),
  });
  assert.equal(pending.state, "LIVE_REREAD");
  assert.equal(
    nextWalmartListingIntegritySchedulerDecision({ stage: "ONE_SKU", items: [pending] }).action,
    "RUN_FRESH_QUALIFICATION",
  );
});

test("Qualification PASS terminalizes only when every frozen facet passes", () => {
  const applied = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: applyRequesting(),
    receipt_bytes: executeReceipt(),
  });
  const liveReread = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: applied,
    receipt_bytes: resumeReceipt("SUCCEEDED"),
  });
  const passed = admitWalmartListingIntegrityOperatorReceipt({
    stage: "ONE_SKU",
    current: liveReread,
    receipt_bytes: qualificationReceipt("PASS"),
  });
  assert.equal(passed.state, "QUALIFIED_PASS");

  assert.throws(
    () => admitWalmartListingIntegrityOperatorReceipt({
      stage: "ONE_SKU",
      current: liveReread,
      receipt_bytes: qualificationReceipt("PASS", {
        facets: { ...FACETS, main: "FAIL" },
      }),
    }),
    /every facet PASS/,
  );
});

test("tampered receipt bytes and changed listing identity fail closed", () => {
  const bytes = executeReceipt();
  const parsed = JSON.parse(bytes.toString("utf8"));
  parsed.status = "SUCCEEDED";
  assert.throws(
    () => admitWalmartListingIntegrityOperatorReceipt({
      stage: "ONE_SKU",
      current: applyRequesting(),
      receipt_bytes: Buffer.from(JSON.stringify(parsed)),
    }),
    /body seal is invalid/,
  );

  assert.throws(
    () => admitWalmartListingIntegrityOperatorReceipt({
      stage: "ONE_SKU",
      current: applyRequesting(),
      receipt_bytes: executeReceipt({ listing: { ...listing(), sku: "FaisalX-1434" } }),
    }),
    /listing identity differs/,
  );
});
