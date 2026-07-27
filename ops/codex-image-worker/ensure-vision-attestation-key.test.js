"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { mkdtemp, readFile, rm, stat, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const run = promisify(execFile);
const script = path.join(__dirname, "ensure-vision-attestation-key.js");

test("receipt-key installer creates one valid pair and is idempotent without exposing it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vision-key-installer-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, ".env");
  await writeFile(envFile, "CODEX_IMAGE_WORKER_TOKEN=test-token\n", { mode: 0o600 });

  const first = JSON.parse((await run(process.execPath, [script, envFile])).stdout);
  assert.equal(first.status, "new_key_installed");
  assert.match(first.public_key_spki_sha256, /^[a-f0-9]{64}$/u);
  const afterFirst = await readFile(envFile, "utf8");
  assert.equal((afterFirst.match(/^VISION_ATTESTATION_PRIVATE_KEY_PKCS8_B64=/gmu) ?? []).length, 1);
  assert.equal((afterFirst.match(/^VISION_ATTESTATION_KEY_ID=/gmu) ?? []).length, 1);
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);

  const second = JSON.parse((await run(process.execPath, [script, envFile])).stdout);
  assert.equal(second.status, "existing_key_verified");
  assert.equal(second.key_id, first.key_id);
  assert.equal(second.public_key_spki_sha256, first.public_key_spki_sha256);
  assert.equal(await readFile(envFile, "utf8"), afterFirst);
  assert.equal(first.private_key, undefined);
  assert.equal(second.private_key, undefined);
});
