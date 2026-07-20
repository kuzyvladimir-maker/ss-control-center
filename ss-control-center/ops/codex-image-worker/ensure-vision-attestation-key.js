#!/usr/bin/env node
"use strict";

/** One-time, no-secret-output installer for the worker's Ed25519 receipt key. */

const {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} = require("node:crypto");
const { chmod, open, readFile } = require("node:fs/promises");
const path = require("node:path");

const PRIVATE_NAME = "VISION_ATTESTATION_PRIVATE_KEY_PKCS8_B64";
const KEY_ID_NAME = "VISION_ATTESTATION_KEY_ID";

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (key === PRIVATE_NAME || key === KEY_ID_NAME) {
      if (values.has(key)) throw new Error(`${key} is duplicated`);
      values.set(key, line.slice(equals + 1).trim());
    }
  }
  return values;
}

function keyFacts(privateBase64, keyId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/u.test(keyId || "")) {
    throw new Error(`${KEY_ID_NAME} is invalid`);
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(privateBase64 || "", "base64"),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${PRIVATE_NAME} is not an Ed25519 PKCS8 key`);
  }
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return {
    key_id: keyId,
    public_key_spki_sha256: createHash("sha256").update(publicDer).digest("hex"),
  };
}

async function main() {
  const rawPath = process.argv[2];
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)
    || path.resolve(rawPath) !== rawPath || rawPath === path.parse(rawPath).root) {
    throw new Error("usage: ensure-vision-attestation-key.js /absolute/path/to/.env");
  }
  const original = await readFile(rawPath, "utf8");
  const existing = parseEnv(original);
  if (existing.has(PRIVATE_NAME) !== existing.has(KEY_ID_NAME)) {
    throw new Error("worker env contains an incomplete receipt-key pair");
  }
  if (existing.has(PRIVATE_NAME)) {
    process.stdout.write(`${JSON.stringify({
      status: "existing_key_verified",
      ...keyFacts(existing.get(PRIVATE_NAME), existing.get(KEY_ID_NAME)),
    })}\n`);
    return;
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicSha = createHash("sha256").update(publicDer).digest("hex");
  const keyId = `walmart-listing-vision-${publicSha.slice(0, 16)}`;
  const prefix = original.endsWith("\n") ? "" : "\n";
  const addition = Buffer.from(
    `${prefix}${PRIVATE_NAME}=${privateDer.toString("base64")}\n${KEY_ID_NAME}=${keyId}\n`,
    "utf8",
  );
  const handle = await open(rawPath, "a", 0o600);
  try {
    await handle.write(addition);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(rawPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    status: "new_key_installed",
    key_id: keyId,
    public_key_spki_sha256: publicSha,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
