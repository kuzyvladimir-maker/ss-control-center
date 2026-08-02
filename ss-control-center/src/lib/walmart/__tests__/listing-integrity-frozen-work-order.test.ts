import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  WalmartListingIntegrityFrozenWorkerInvocation,
} from "../listing-integrity-frozen-operator-worker";
import {
  buildWalmartListingIntegrityFrozenWorkOrder,
  verifyWalmartListingIntegrityFrozenWorkOrder,
} from "../listing-integrity-frozen-work-order";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const CREATED = "2026-08-01T18:00:00.000Z";
const EXPIRES = "2026-08-01T18:15:00.000Z";

function invocation(): WalmartListingIntegrityFrozenWorkerInvocation {
  return {
    schema_version: "walmart-listing-integrity-frozen-operator-worker/v1",
    command: "resume",
    listing_key: "walmart:1:FaisalX-1144",
    sku: "FaisalX-1144",
    current_state_body_sha256: H("state"),
    execution_package_sha256: H("package"),
    owner_permit_sha256: H("permit"),
    plan_body_sha256: H("plan"),
    feed_id: "feed-1",
    frozen_release_id_sha256: H("release"),
    manifest_sha256: H("manifest"),
    global_admission_identity_sha256: H("admission"),
    automatic_retry_allowed: false,
    automatic_replay_allowed: false,
    maximum_operator_calls: 1,
  };
}

function argv(value = invocation()) {
  return [
    "resume",
    "--package", "/private/owner/package.json",
    "--package-sha256", value.execution_package_sha256,
    "--confirm", `RESUME_EXACT_FEED_GET_ONLY:${value.owner_permit_sha256}`,
  ];
}

test("sealed work order binds one current SKU revision and exact argv", () => {
  const decision = invocation();
  const order = buildWalmartListingIntegrityFrozenWorkOrder({
    work_order_id: "work-order-FaisalX-1144-r8",
    invocation: decision,
    operator_args: argv(decision),
    created_at: CREATED,
    expires_at: EXPIRES,
  });
  const verified = verifyWalmartListingIntegrityFrozenWorkOrder({
    work_order: order,
    invocation: decision,
    now: new Date("2026-08-01T18:10:00.000Z"),
  });
  assert.equal(verified.command, "resume");
  assert.equal(verified.claims.maximum_operator_calls, 1);
  assert.equal(verified.claims.automatic_retry_allowed, false);
  assert.deepEqual(verified.operator_args, argv(decision));
});

test("expired, tampered, or another-revision work order fails closed", () => {
  const decision = invocation();
  const order = buildWalmartListingIntegrityFrozenWorkOrder({
    work_order_id: "work-order-FaisalX-1144-r8",
    invocation: decision,
    operator_args: argv(decision),
    created_at: CREATED,
    expires_at: EXPIRES,
  });
  assert.throws(
    () => verifyWalmartListingIntegrityFrozenWorkOrder({
      work_order: order,
      invocation: decision,
      now: new Date(EXPIRES),
    }),
    /FROZEN_WORK_ORDER_EXPIRED/,
  );
  assert.throws(
    () => verifyWalmartListingIntegrityFrozenWorkOrder({
      work_order: { ...order, sku: "FaisalX-1434" },
      invocation: decision,
      now: new Date(CREATED),
    }),
    /FROZEN_WORK_ORDER_SEAL_INVALID/,
  );
  assert.throws(
    () => verifyWalmartListingIntegrityFrozenWorkOrder({
      work_order: order,
      invocation: { ...decision, current_state_body_sha256: H("next-revision") },
      now: new Date(CREATED),
    }),
    /FROZEN_WORK_ORDER_BINDING_DRIFT/,
  );
});

test("claims cannot be widened to mass apply, retry, price, or inventory", () => {
  const decision = invocation();
  const order = buildWalmartListingIntegrityFrozenWorkOrder({
    work_order_id: "work-order-FaisalX-1144-r8",
    invocation: decision,
    operator_args: argv(decision),
    created_at: CREATED,
    expires_at: EXPIRES,
  });
  for (const claims of [
    { ...order.claims, mass_apply_allowed: true },
    { ...order.claims, automatic_retry_allowed: true },
    { ...order.claims, inventory_write: true },
  ]) {
    assert.throws(
      () => verifyWalmartListingIntegrityFrozenWorkOrder({
        work_order: { ...order, claims },
        invocation: decision,
        now: new Date(CREATED),
      }),
      /FROZEN_WORK_ORDER_POLICY_DRIFT/,
    );
  }
});
