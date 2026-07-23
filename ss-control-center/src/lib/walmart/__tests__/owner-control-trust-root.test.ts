import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  validateWalmartOwnerControlTrustedKey,
  walmartOwnerControlProductionTrustedKeys,
  type WalmartOwnerControlTrustedKey,
} from "../owner-control-trust-root";

function fixture(): WalmartOwnerControlTrustedKey {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    key_id: "walmart-owner-control-fixture-1",
    public_key_spki_der_base64: der.toString("base64"),
    public_key_spki_sha256: createHash("sha256").update(der).digest("hex"),
    status: "ACTIVE",
    environment: "PRODUCTION",
  };
}

test("production owner-control trust root contains the enrolled external public key", () => {
  const keys = walmartOwnerControlProductionTrustedKeys();
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0], {
    key_id: "walmart-owner-control-2026-01",
    public_key_spki_der_base64:
      "MCowBQYDK2VwAyEAIT9cBEcfy0WfQAe5qb6z/R1E357FnZAce12X6XmBjTw=",
    public_key_spki_sha256:
      "ca74a2134808ab46eb162b14dfe481730fc69df00b57283cffd7a7bb1d37883a",
    status: "ACTIVE",
    environment: "PRODUCTION",
  });
  assert.doesNotThrow(() => validateWalmartOwnerControlTrustedKey(keys[0]));
});

test("one valid Ed25519 public key is suitable for domain-separated Walmart owner actions", () => {
  assert.doesNotThrow(() => validateWalmartOwnerControlTrustedKey(fixture()));
});

test("fingerprint drift and a non-Ed25519 public key fail closed", () => {
  const wrongFingerprint = fixture();
  wrongFingerprint.public_key_spki_sha256 = "f".repeat(64);
  assert.throws(
    () => validateWalmartOwnerControlTrustedKey(wrongFingerprint),
    /fingerprint mismatch/u,
  );

  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  assert.throws(
    () => validateWalmartOwnerControlTrustedKey({
      key_id: "walmart-owner-control-rsa-forbidden",
      public_key_spki_der_base64: der.toString("base64"),
      public_key_spki_sha256: createHash("sha256").update(der).digest("hex"),
      status: "ACTIVE",
      environment: "PRODUCTION",
    }),
    /must be Ed25519/u,
  );
});
