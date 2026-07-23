import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assembleWalmartOwnerPermit,
  assertWalmartOwnerPermitSignature,
  buildWalmartOwnerPermitSigningRequest,
  inspectWalmartOwnerPermitTrustRoot,
  type WalmartOwnerPermit,
  type WalmartOwnerPermitSignedBody,
} from "@/lib/bundle-factory/walmart-owner-permit";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const env = {
    NODE_ENV: "test",
    WALMART_NEW_SKU_TEST_MODE: "1",
    WALMART_API_BASE_URL: "https://walmart.fixture.test",
    WALMART_NEW_SKU_TEST_OWNER_KEY_ID: "owner-fixture-key-1",
    WALMART_NEW_SKU_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
      publicDer.toString("base64"),
  } as NodeJS.ProcessEnv;
  const now = new Date("2026-07-18T20:00:00.000Z");
  const body: WalmartOwnerPermitSignedBody = {
    permit_id: "owner-permit://fixture/one",
    action: "WALMART_MP_ITEM_SUBMIT",
    environment: "TEST_FIXTURE_ONLY",
    engine_release_sha256: "1".repeat(64),
    approval_sha256: "2".repeat(64),
    doctor_receipt_sha256: "3".repeat(64),
    apply_preview_receipt_sha256: "4".repeat(64),
    certification_sha256: "5".repeat(64),
    candidate_key: "candidate-1",
    channel_sku_id: "channel-sku-1",
    sku: "PILOT-SKU-1",
    upc: "012345678905",
    payload_sha256: "6".repeat(64),
    store_index: 1,
    seller_account_fingerprint_sha256: "7".repeat(64),
    database_target_fingerprint_sha256: "8".repeat(64),
    pilot_slot: 1,
    max_pilot_skus: 2,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 20 * 60_000).toISOString(),
    approved_by: "fixture-owner",
    decision_ref: "owner-decision://fixture/one",
    live_submission_authorized: true,
    claims: {
      exact_one_sku: true,
      marketplace_submission_max: 1,
      delist: false,
      reprice: false,
      purchase: false,
      schedule: false,
    },
  };
  const request = buildWalmartOwnerPermitSigningRequest({
    key_id: "owner-fixture-key-1",
    signed_body: body,
    env,
  });
  const permit = assembleWalmartOwnerPermit({
    request,
    signature_base64: sign(
      null,
      Buffer.from(request.signing_message_base64, "base64"),
      keys.privateKey,
    ).toString("base64"),
    env,
    now,
  });
  return { keys, env, now, body, permit };
}

test("valid Ed25519 owner permit verifies with exact bindings", () => {
  const fx = fixture();
  assertWalmartOwnerPermitSignature(fx.permit, {
    env: fx.env,
    now: fx.now,
    expectedEnvironment: "TEST_FIXTURE_ONLY",
    expected: {
      engine_release_sha256: fx.body.engine_release_sha256,
      approval_sha256: fx.body.approval_sha256,
      doctor_receipt_sha256: fx.body.doctor_receipt_sha256,
      apply_preview_receipt_sha256: fx.body.apply_preview_receipt_sha256,
      certification_sha256: fx.body.certification_sha256,
      candidate_key: fx.body.candidate_key,
      channel_sku_id: fx.body.channel_sku_id,
      sku: fx.body.sku,
      upc: fx.body.upc,
      payload_sha256: fx.body.payload_sha256,
      store_index: fx.body.store_index,
      seller_account_fingerprint_sha256:
        fx.body.seller_account_fingerprint_sha256,
      database_target_fingerprint_sha256:
        fx.body.database_target_fingerprint_sha256,
    },
  });
});

test("hash-only, altered, expired, wrong-key and test-key-in-production permits fail", () => {
  const fx = fixture();
  const altered = structuredClone(fx.permit);
  altered.signed_body.sku = "ATTACKER-SKU";
  assert.throws(
    () => assertWalmartOwnerPermitSignature(altered, {
      env: fx.env,
      now: fx.now,
      expectedEnvironment: "TEST_FIXTURE_ONLY",
    }),
    /SIGNATURE_OR_BINDING_INVALID/,
  );

  const selfHashedV1 = {
    schema_version: "walmart-new-sku-owner-permit/1.0.0",
    approved_by: "owner",
    permit_sha256: "a".repeat(64),
  } as unknown as WalmartOwnerPermit;
  assert.throws(
    () => assertWalmartOwnerPermitSignature(selfHashedV1, { env: fx.env, now: fx.now }),
  );

  assert.throws(
    () => assertWalmartOwnerPermitSignature(fx.permit, {
      env: fx.env,
      now: new Date(Date.parse(fx.body.expires_at) + 1),
      expectedEnvironment: "TEST_FIXTURE_ONLY",
    }),
    /SIGNATURE_OR_BINDING_INVALID/,
  );

  const wrongKeys = generateKeyPairSync("ed25519");
  const wrongDer = wrongKeys.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  assert.throws(
    () => assertWalmartOwnerPermitSignature(fx.permit, {
      now: fx.now,
      env: {
        ...fx.env,
        WALMART_NEW_SKU_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
          wrongDer.toString("base64"),
      },
      expectedEnvironment: "TEST_FIXTURE_ONLY",
    }),
  );

  assert.throws(
    () => assertWalmartOwnerPermitSignature(fx.permit, {
      env: fx.env,
      now: fx.now,
    }),
    /KEY_UNTRUSTED_OR_REVOKED/,
  );

  const productionTrust = inspectWalmartOwnerPermitTrustRoot({
    ...fx.env,
    NODE_ENV: "production",
    WALMART_API_BASE_URL: "https://marketplace.walmartapis.com",
  }, "PRODUCTION");
  assert.equal(productionTrust.ready, true);
  assert.deepEqual(productionTrust.active_key_ids, [
    "walmart-owner-control-2026-01",
  ]);
});

test("operator module contains no private key or signing implementation", async () => {
  const source = await readFile(
    path.resolve(
      process.cwd(),
      "src/lib/bundle-factory/walmart-owner-permit.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /BEGIN (?:ED25519 |)PRIVATE KEY/);
  assert.doesNotMatch(source, /createPrivateKey|generateKeyPairSync/);
  assert.doesNotMatch(source, /\bsign\s*(?:as\s+\w+)?[,}]|\bsign\s*\(/);

  const cliSource = await readFile(
    path.resolve(process.cwd(), "scripts/walmart-new-sku-engine.ts"),
    "utf8",
  );
  assert.match(cliSource, /owner-permit-request/);
  assert.match(cliSource, /owner-permit-assemble/);
  assert.doesNotMatch(cliSource, /BEGIN (?:ED25519 |)PRIVATE KEY/);
  assert.doesNotMatch(cliSource, /createPrivateKey|generateKeyPairSync/);
  assert.doesNotMatch(cliSource, /\bsign\s*(?:as\s+\w+)?[,}]|\bsign\s*\(/);
});
