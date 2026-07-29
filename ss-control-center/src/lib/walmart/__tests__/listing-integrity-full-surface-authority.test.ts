import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";

import {
  WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION,
  WALMART_LISTING_FULL_SURFACE_PERMIT_ALGORITHM,
  WALMART_LISTING_FULL_SURFACE_PERMIT_SCHEMA,
  assembleWalmartListingFullSurfacePermit,
  verifyWalmartListingFullSurfacePermit,
  walmartListingFullSurfacePermitSigningMessage,
  type WalmartListingFullSurfaceLedgerBinding,
  type WalmartListingFullSurfacePermitSignedBody,
  type WalmartListingFullSurfacePermitSigningEnvelope,
} from "../listing-integrity-full-surface-authority";
import {
  WALMART_LISTING_FULL_SURFACE_OPERATION_SCHEMA,
  WALMART_LISTING_FULL_SURFACE_PLAN_SCHEMA,
  buildWalmartListingFullSurfacePlan,
} from "../listing-integrity-full-surface";

const HASH = "a".repeat(64);
const NOW = "2026-07-29T16:00:00.000Z";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const trustedKey = {
    key_id: "walmart-owner-control-test",
    public_key_spki_der_base64: publicDer.toString("base64"),
    public_key_spki_sha256: sha256(publicDer),
    status: "ACTIVE" as const,
    environment: "TEST_FIXTURE_ONLY" as const,
  };
  const payload = Buffer.from('{"sku":"FaisalX-1434","price":47.99}', "utf8");
  const plan = buildWalmartListingFullSurfacePlan({
    plan_id: "maruchan-repair-1",
    owner_decision_id: "owner-chat-2026-07-29",
    owner_decision_sha256: "1".repeat(64),
    created_at: "2026-07-29T15:55:00.000Z",
    expires_at: "2026-07-30T15:55:00.000Z",
    seller_account_fingerprint_sha256: "2".repeat(64),
    product_truth_snapshot_sha256: "3".repeat(64),
    exact_listings: [{
      channel: "WALMART_US",
      store_index: 1,
      sku: "FaisalX-1434",
      listing_key: "walmart:1:FaisalX-1434",
      item_id: "517674888",
    }],
    operations: [{
      operation_id: "price-FaisalX-1434",
      operation_kind: "PRICE",
      exact_skus: ["FaisalX-1434"],
      request_payload_bytes: payload,
      content_type: "application/json",
      evidence_sha256: "4".repeat(64),
      account_scope_receipt_sha256: "5".repeat(64),
      baseline_state_sha256: "6".repeat(64),
      expected_state_sha256: "7".repeat(64),
    }],
  });
  const operation = plan.operations[0];
  const ledger: WalmartListingFullSurfaceLedgerBinding = {
    policy_id: "walmart-listing-full-surface-operation-ledger/1.0.0",
    ledger_id: "walmart-production",
    ledger_epoch: "2026-07-29T15:58:00.000Z",
    state_directory_path_sha256: "8".repeat(64),
    directory_identity_sha256: "9".repeat(64),
    identity_artifact_sha256: "b".repeat(64),
    reservation_filename_policy:
      "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
  const signedBody: WalmartListingFullSurfacePermitSignedBody = {
    action: WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION,
    environment: "TEST_FIXTURE_ONLY",
    permit_id: "permit-price-FaisalX-1434",
    issued_at: "2026-07-29T15:59:00.000Z",
    expires_at: "2026-07-29T16:20:00.000Z",
    approved_by: "owner",
    decision_ref: "owner instruction in task",
    plan_schema_version: WALMART_LISTING_FULL_SURFACE_PLAN_SCHEMA,
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    operation_schema_version: WALMART_LISTING_FULL_SURFACE_OPERATION_SCHEMA,
    operation_id: operation.operation_id,
    operation_body_sha256: operation.body_sha256,
    operation_kind: operation.operation_kind,
    exact_skus: operation.exact_skus,
    seller_account_fingerprint_sha256:
      plan.seller_account_fingerprint_sha256,
    evidence_sha256: operation.evidence_sha256,
    request_payload_sha256:
      operation.exact_request.request_payload_sha256,
    request_byte_length: operation.exact_request.request_byte_length,
    irreversible_owner_decision_sha256: null,
    consumption_ledger: ledger,
    claims: {
      exact_operation_count: 1,
      marketplace_write_calls: 1,
      retry_allowed: false,
      automatic_replay_allowed: false,
      payload_substitution_allowed: false,
      account_substitution_allowed: false,
      stop_on_unknown_outcome: true,
    },
  };
  const envelope: WalmartListingFullSurfacePermitSigningEnvelope = {
    schema_version: WALMART_LISTING_FULL_SURFACE_PERMIT_SCHEMA,
    algorithm: WALMART_LISTING_FULL_SURFACE_PERMIT_ALGORITHM,
    key_id: trustedKey.key_id,
    owner_public_key_spki_sha256: trustedKey.public_key_spki_sha256,
    signed_body: signedBody,
  };
  const permit = assembleWalmartListingFullSurfacePermit({
    envelope,
    signature: sign(
      null,
      walmartListingFullSurfacePermitSigningMessage(envelope),
      privateKey,
    ),
  });
  return { ledger, operation, payload, permit, plan, privateKey, trustedKey };
}

test("verifies one exact domain-separated operation permit", () => {
  const fx = fixture();
  assert.equal(
    verifyWalmartListingFullSurfacePermit({
      permit: fx.permit,
      plan: fx.plan,
      operation: fx.operation,
      ledger_binding: fx.ledger,
      now: NOW,
      trusted_keys: [fx.trustedKey],
    }).authorization_sha256,
    fx.permit.authorization_sha256,
  );
});

test("rejects plan, operation, account, payload and ledger substitution", () => {
  const fx = fixture();
  for (const mutation of [
    () => ({
      plan: { ...fx.plan, plan_id: "other-plan" },
      operation: fx.operation,
      ledger_binding: fx.ledger,
    }),
    () => ({
      plan: fx.plan,
      operation: {
        ...fx.operation,
        exact_request: {
          ...fx.operation.exact_request,
          request_payload_sha256: HASH,
        },
      },
      ledger_binding: fx.ledger,
    }),
    () => ({
      plan: fx.plan,
      operation: fx.operation,
      ledger_binding: { ...fx.ledger, ledger_id: "other-ledger" },
    }),
  ]) {
    assert.throws(
      () => verifyWalmartListingFullSurfacePermit({
        permit: fx.permit,
        ...mutation(),
        now: NOW,
        trusted_keys: [fx.trustedKey],
      }),
      /rejected/u,
    );
  }
});

test("rejects expired, incorrectly signed and cross-domain signatures", () => {
  const fx = fixture();
  assert.throws(
    () => verifyWalmartListingFullSurfacePermit({
      permit: fx.permit,
      plan: fx.plan,
      operation: fx.operation,
      ledger_binding: fx.ledger,
      now: "2026-07-29T17:00:00.000Z",
      trusted_keys: [fx.trustedKey],
    }),
    /not current/u,
  );
  const crossDomainSignature = sign(
    null,
    Buffer.concat([
      Buffer.from("SS_COMMAND_CENTER\0OTHER_DOMAIN\0v1\0", "utf8"),
      Buffer.from("same permit", "utf8"),
    ]),
    fx.privateKey,
  );
  const tampered = assembleWalmartListingFullSurfacePermit({
    envelope: {
      schema_version: fx.permit.schema_version,
      algorithm: fx.permit.algorithm,
      key_id: fx.permit.key_id,
      owner_public_key_spki_sha256:
        fx.permit.owner_public_key_spki_sha256,
      signed_body: fx.permit.signed_body,
    },
    signature: crossDomainSignature,
  });
  assert.throws(
    () => verifyWalmartListingFullSurfacePermit({
      permit: tampered,
      plan: fx.plan,
      operation: fx.operation,
      ledger_binding: fx.ledger,
      now: NOW,
      trusted_keys: [fx.trustedKey],
    }),
    /signature is invalid/u,
  );
});

