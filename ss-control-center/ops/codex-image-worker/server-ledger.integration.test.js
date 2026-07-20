"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { generateKeyPairSync } = require("node:crypto");
const { chmod, mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  VISION_REQUEST_ATTESTATION_SCHEMA,
  VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  sha256,
  verifyVisionWorkerReceipt,
} = require("./vision-contract");

const SERVER = path.join(__dirname, "server.js");

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolve, reject) => probe.close((error) => (
    error ? reject(error) : resolve()
  )));
  if (!Number.isSafeInteger(port)) throw new Error("failed to allocate test port");
  return port;
}

function spawnWorker(env) {
  const child = spawn(process.execPath, [SERVER], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function waitForExit(worker, timeoutMs = 5_000) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    return worker.child.exitCode;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.child.kill("SIGKILL");
      reject(new Error(`worker did not exit; stdout=${worker.stdout()} stderr=${worker.stderr()}`));
    }, timeoutMs);
    worker.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stopWorker(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill("SIGTERM");
  await waitForExit(worker);
}

async function health(port, token, worker) {
  const deadline = Date.now() + 7_500;
  let lastError = null;
  while (Date.now() < deadline) {
    if (worker.child.exitCode !== null) {
      throw new Error(
        `worker exited ${worker.child.exitCode}; stdout=${worker.stdout()} stderr=${worker.stderr()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      if (response.ok && body.ok === true) return body;
      lastError = new Error(`health returned ${response.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `worker health timed out: ${lastError}; stdout=${worker.stdout()} stderr=${worker.stderr()}`,
  );
}

function workerEnv({ base, port, codexHome, fakeCli, privateKeyBase64, token, expected }) {
  const env = {
    ...base,
    HOST: "127.0.0.1",
    PORT: String(port),
    CODEX_HOME: codexHome,
    CODEX_BIN: fakeCli,
    CLAUDE_BIN: fakeCli,
    CODEX_IMAGE_WORKER_TOKEN: token,
    VISION_ATTESTATION_PRIVATE_KEY_PKCS8_B64: privateKeyBase64,
    VISION_ATTESTATION_KEY_ID: "integration-worker-key",
  };
  delete env.VISION_CALL_LEDGER_EXPECTED_ID;
  delete env.VISION_CALL_LEDGER_EXPECTED_EPOCH;
  if (expected) {
    env.VISION_CALL_LEDGER_EXPECTED_ID = expected.ledger_id;
    env.VISION_CALL_LEDGER_EXPECTED_EPOCH = expected.ledger_epoch;
  }
  return env;
}

test("HTTP worker pins ledger in health/build/receipt and fails closed after restart/clear", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vision-worker-ledger-e2e-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const firstHome = path.join(root, "codex-home-a");
  const secondHome = path.join(root, "codex-home-b");
  await mkdir(firstHome, { mode: 0o700 });
  await mkdir(secondHome, { mode: 0o700 });

  const fakeCli = path.join(root, "fake-subscription-cli.js");
  await writeFile(fakeCli, [
    "#!/usr/bin/env node",
    "\"use strict\";",
    "if (process.argv.includes(\"--version\")) {",
    "  process.stdout.write(\"fake-subscription-cli 1.0.0\\n\");",
    "} else {",
    "  process.stdout.write(JSON.stringify({ result: JSON.stringify({ answer: \"ok\" }) }));",
    "}",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(fakeCli, 0o700);

  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyBase64 = privateKey.export({
    format: "der",
    type: "pkcs8",
  }).toString("base64");
  const token = "integration-secret-token";
  const baseEnv = { ...process.env };
  delete baseEnv.VISION_CALL_LEDGER_EXPECTED_ID;
  delete baseEnv.VISION_CALL_LEDGER_EXPECTED_EPOCH;

  const firstPort = await unusedPort();
  const firstWorker = spawnWorker(workerEnv({
    base: baseEnv,
    port: firstPort,
    codexHome: firstHome,
    fakeCli,
    privateKeyBase64,
    token,
  }));
  t.after(async () => stopWorker(firstWorker));
  const firstHealth = await health(firstPort, token, firstWorker);
  assert.equal(firstHealth.health_authorization_verified, true);
  assert.equal(firstHealth.durable_call_key_reservations, true);
  assert.match(firstHealth.worker_build, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(firstHealth.reservation_ledger, {
    schema_version: VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA,
    ledger_id: firstHealth.reservation_ledger.ledger_id,
    ledger_epoch: firstHealth.reservation_ledger.ledger_epoch,
    state_directory_path_sha256: firstHealth.reservation_ledger.state_directory_path_sha256,
    directory_identity_sha256: firstHealth.reservation_ledger.directory_identity_sha256,
    identity_artifact_sha256: firstHealth.reservation_ledger.identity_artifact_sha256,
  });
  assert.match(firstHealth.reservation_ledger.ledger_id, /^ledger-[0-9a-f-]{36}$/);
  assert.match(firstHealth.reservation_ledger.ledger_epoch, /^epoch-[0-9a-f-]{36}$/);
  for (const field of [
    "state_directory_path_sha256",
    "directory_identity_sha256",
    "identity_artifact_sha256",
  ]) assert.match(firstHealth.reservation_ledger[field], /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(firstHealth).includes(privateKeyBase64), false);
  assert.equal(Object.hasOwn(firstHealth.reservation_ledger, "state_directory"), false);

  const prompt = "integration blind prompt";
  const imageBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4),
  ]);
  const requestAttestation = {
    schema_version: VISION_REQUEST_ATTESTATION_SCHEMA,
    run_lock_sha256: "a".repeat(64),
    shard_id: "shard-000001",
    call_index: 0,
    call_key: "b".repeat(64),
    prompt_sha256: sha256(Buffer.from(prompt)),
    image_sha256: [sha256(imageBytes)],
    execution_permit_sha256: "f".repeat(64),
    partition_id: "partition-000001",
  };
  const requestBody = {
    prompt,
    images: [imageBytes.toString("base64")],
    request_attestation: requestAttestation,
  };
  const analysisResponse = await fetch(`http://127.0.0.1:${firstPort}/analyze-claude`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const analysis = await analysisResponse.json();
  assert.equal(analysisResponse.status, 200, JSON.stringify(analysis));
  assert.equal(analysis.ok, true);
  assert.deepEqual(analysis.reservation_ledger, firstHealth.reservation_ledger);
  assert.equal(analysis.worker_build, firstHealth.worker_build);
  assert.deepEqual(
    analysis.worker_receipt.body.worker_contract.reservation_ledger,
    firstHealth.reservation_ledger,
  );
  assert.equal(
    analysis.worker_receipt.body.worker_contract.worker_build,
    firstHealth.worker_build,
  );
  assert.equal(verifyVisionWorkerReceipt(analysis.worker_receipt), analysis.worker_receipt);

  await stopWorker(firstWorker);
  const expected = {
    ledger_id: firstHealth.reservation_ledger.ledger_id,
    ledger_epoch: firstHealth.reservation_ledger.ledger_epoch,
  };
  const restartPort = await unusedPort();
  const restartedWorker = spawnWorker(workerEnv({
    base: baseEnv,
    port: restartPort,
    codexHome: firstHome,
    fakeCli,
    privateKeyBase64,
    token,
    expected,
  }));
  t.after(async () => stopWorker(restartedWorker));
  const restartedHealth = await health(restartPort, token, restartedWorker);
  assert.deepEqual(restartedHealth.reservation_ledger, firstHealth.reservation_ledger);
  assert.equal(restartedHealth.worker_build, firstHealth.worker_build);
  const replayResponse = await fetch(`http://127.0.0.1:${restartPort}/analyze-claude`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const replay = await replayResponse.json();
  assert.equal(replayResponse.status, 409, JSON.stringify(replay));
  assert.equal(replay.error, "call_key_already_reserved_or_ambiguous");
  await rm(path.join(firstHome, "vision-call-reservations"), {
    recursive: true,
    force: true,
  });
  const brokenHealthResponse = await fetch(`http://127.0.0.1:${restartPort}/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const brokenHealth = await brokenHealthResponse.json();
  assert.equal(brokenHealthResponse.status, 503, JSON.stringify(brokenHealth));
  assert.deepEqual(brokenHealth, {
    ok: false,
    error: "reservation_ledger_custody_failed",
    health_authorization_verified: true,
  });
  await stopWorker(restartedWorker);

  const clearedPort = await unusedPort();
  const clearedWorker = spawnWorker(workerEnv({
    base: baseEnv,
    port: clearedPort,
    codexHome: firstHome,
    fakeCli,
    privateKeyBase64,
    token,
    expected,
  }));
  t.after(async () => stopWorker(clearedWorker));
  const clearedExit = await waitForExit(clearedWorker);
  assert.notEqual(clearedExit, 0);
  assert.match(clearedWorker.stderr(), /configured vision reservation ledger directory is missing/);
  assert.equal(clearedWorker.stderr().includes(privateKeyBase64), false);

  const newPathPort = await unusedPort();
  const newPathWorker = spawnWorker(workerEnv({
    base: baseEnv,
    port: newPathPort,
    codexHome: secondHome,
    fakeCli,
    privateKeyBase64,
    token,
  }));
  t.after(async () => stopWorker(newPathWorker));
  const newPathHealth = await health(newPathPort, token, newPathWorker);
  assert.notEqual(
    newPathHealth.reservation_ledger.state_directory_path_sha256,
    firstHealth.reservation_ledger.state_directory_path_sha256,
  );
  assert.notEqual(newPathHealth.reservation_ledger.ledger_id, expected.ledger_id);
  assert.notEqual(newPathHealth.worker_build, firstHealth.worker_build);
});
