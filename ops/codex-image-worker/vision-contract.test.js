"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_CODEX_VISION_MODEL,
  VISION_CALL_RESERVATION_SCHEMA,
  VISION_REQUEST_ATTESTATION_SCHEMA,
  VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  VisionCallKeyAlreadyReservedError,
  buildClaudeSubscriptionEnv,
  buildCodexVisionArgs,
  computeWorkerBuild,
  configuredVisionReservationLedgerIdentity,
  createVisionContracts,
  createVisionReceiptSigner,
  initializeVisionReservationLedger,
  parseVisionRequestAttestation,
  parseVisionTimeoutMs,
  reserveVisionCallKey,
  sha256,
  validateOptionalHealthAuthorization,
  verifyVisionWorkerReceipt,
  visionMetadata,
} = require("./vision-contract");

function ledgerContract(overrides = {}) {
  return {
    schema_version: VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA,
    ledger_id: "ledger-11111111-1111-4111-8111-111111111111",
    ledger_epoch: "epoch-22222222-2222-4222-8222-222222222222",
    state_directory_path_sha256: "3".repeat(64),
    directory_identity_sha256: "4".repeat(64),
    identity_artifact_sha256: "5".repeat(64),
    ...overrides,
  };
}

function attestedRequest({
  prompt = "blind prompt",
  imageBytes = [Buffer.from("image-a")],
  callKey = "b".repeat(64),
} = {}) {
  return parseVisionRequestAttestation({
    schema_version: VISION_REQUEST_ATTESTATION_SCHEMA,
    run_lock_sha256: "a".repeat(64),
    shard_id: "shard-000001",
    call_index: 0,
    call_key: callKey,
    prompt_sha256: sha256(Buffer.from(prompt)),
    execution_permit_sha256: "f".repeat(64),
    partition_id: "partition-000001",
    image_sha256: imageBytes.map(sha256),
  }, prompt, imageBytes);
}

function expectedLedgerIdentity(ledger) {
  return {
    ledger_id: ledger.contract.ledger_id,
    ledger_epoch: ledger.contract.ledger_epoch,
  };
}

function contracts(overrides = {}) {
  return createVisionContracts({
    env: {},
    codexCliVersion: "codex-cli 0.144.5",
    claudeCliVersion: "2.1.202 (Claude Code)",
    nodeVersion: "v25.8.1",
    platform: "linux",
    arch: "x64",
    ...overrides,
  });
}

test("pins Codex vision model and reasoning in non-interactive args", () => {
  const contract = contracts().codex_cli_subscription;
  const args = buildCodexVisionArgs(["/tmp/a.jpg", "/tmp/b.jpg"], contract);
  assert.deepEqual(args.slice(0, 6), [
    "exec",
    "--skip-git-repo-check",
    "--model",
    DEFAULT_CODEX_VISION_MODEL,
    "--config",
    'model_reasoning_effort="medium"',
  ]);
  assert.deepEqual(args.slice(6), ["-i", "/tmp/a.jpg", "-i", "/tmp/b.jpg"]);
});

test("health/call metadata binds model, CLI, Node, platform, and build", () => {
  const resolved = contracts();
  const ledger = ledgerContract();
  const build = computeWorkerBuild(
    [Buffer.from("server"), Buffer.from("contract")],
    resolved,
    ledger,
  );
  const metadata = visionMetadata("codex_cli_subscription", 2, resolved, build, ledger);
  assert.deepEqual(metadata, {
    input_image_count: 2,
    vision_provider: "codex_cli_subscription",
    vision_model: "gpt-5.6-sol",
    vision_reasoning_effort: "medium",
    cli_version: "codex-cli 0.144.5",
    node_version: "v25.8.1",
    runtime_platform: "linux",
    runtime_arch: "x64",
    worker_build: build,
    reservation_ledger: ledger,
  });
  assert.match(build, /^sha256:[a-f0-9]{64}$/);
});

test("worker build changes when runtime model or CLI changes", () => {
  const base = contracts();
  const changedModel = contracts({ env: { CODEX_VISION_MODEL: "gpt-5.6-luna" } });
  const changedCli = contracts({ codexCliVersion: "codex-cli 0.145.0" });
  const sources = [Buffer.from("same-source")];
  const ledger = ledgerContract();
  assert.notEqual(
    computeWorkerBuild(sources, base, ledger),
    computeWorkerBuild(sources, changedModel, ledger),
  );
  assert.notEqual(
    computeWorkerBuild(sources, base, ledger),
    computeWorkerBuild(sources, changedCli, ledger),
  );
  for (const changedLedger of [
    ledgerContract({ ledger_id: "ledger-33333333-3333-4333-8333-333333333333" }),
    ledgerContract({ ledger_epoch: "epoch-44444444-4444-4444-8444-444444444444" }),
    ledgerContract({ state_directory_path_sha256: "6".repeat(64) }),
    ledgerContract({ directory_identity_sha256: "7".repeat(64) }),
    ledgerContract({ identity_artifact_sha256: "8".repeat(64) }),
  ]) {
    assert.notEqual(
      computeWorkerBuild(sources, base, ledger),
      computeWorkerBuild(sources, base, changedLedger),
    );
  }
});

test("rejects missing images and unsupported reasoning effort", () => {
  assert.throws(
    () => buildCodexVisionArgs([], contracts().codex_cli_subscription),
    /at least one image/,
  );
  assert.throws(
    () => contracts({ env: { CODEX_VISION_REASONING_EFFORT: "automatic" } }),
    /unsupported/,
  );
});

test("vision timeout override is exact, bounded, and health-attestable", () => {
  assert.equal(parseVisionTimeoutMs(undefined), 180_000);
  assert.equal(parseVisionTimeoutMs("210000"), 210_000);
  for (const value of ["not-a-number", "180000.5", "999", "600001"]) {
    assert.throws(() => parseVisionTimeoutMs(value), /VISION_TIMEOUT_MS/);
  }
});

test("Claude child environment strips every paid and alternate cloud credential route", () => {
  const env = buildClaudeSubscriptionEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    ANTHROPIC_API_KEY: "paid",
    ANTHROPIC_AUTH_TOKEN: "paid-token",
    ANTHROPIC_BASE_URL: "https://paid.invalid",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    AWS_ACCESS_KEY_ID: "paid-aws",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/paid-google.json",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/home");
  for (const key of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "AWS_ACCESS_KEY_ID",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]) assert.equal(Object.hasOwn(env, key), false, key);
});

test("optional health authorization preserves public probes but verifies supplied bearer", () => {
  assert.deepEqual(validateOptionalHealthAuthorization(undefined, "secret"), {
    allowed: true,
    auth_verified: false,
  });
  assert.deepEqual(validateOptionalHealthAuthorization("Bearer secret", "secret"), {
    allowed: true,
    auth_verified: true,
  });
  assert.deepEqual(validateOptionalHealthAuthorization("Bearer wrong", "secret"), {
    allowed: false,
    auth_verified: false,
  });
});

test("signed worker receipt binds exact prompt, ordered image bytes, result, and runtime", () => {
  const prompt = "blind prompt";
  const imageBytes = [Buffer.from("image-a"), Buffer.from("image-b")];
  const request = parseVisionRequestAttestation({
    schema_version: VISION_REQUEST_ATTESTATION_SCHEMA,
    run_lock_sha256: "a".repeat(64),
    shard_id: "shard-000001",
    call_index: 1,
    call_key: "b".repeat(64),
    prompt_sha256: sha256(Buffer.from(prompt)),
    execution_permit_sha256: "f".repeat(64),
    partition_id: "partition-000001",
    image_sha256: imageBytes.map(sha256),
  }, prompt, imageBytes);
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const signer = createVisionReceiptSigner(privateDer.toString("base64"), "worker-key-1");
  const resolved = contracts();
  const ledger = ledgerContract();
  const workerBuild = computeWorkerBuild([Buffer.from("worker")], resolved, ledger);
  const receipt = signer.sign({
    issued_at: "2026-07-18T12:00:00.000Z",
    reservation_reserved_at: "2026-07-18T11:59:00.000Z",
    request_attestation: request,
    result_canonical_sha256: "c".repeat(64),
    worker_contract: visionMetadata(
      "claude_cli_subscription",
      imageBytes.length,
      resolved,
      workerBuild,
      ledger,
    ),
    subscription_policy: {
      auth_mode: "claude_subscription_oauth",
      paid_api_environment_absent: true,
      alternate_cloud_routing_absent: true,
    },
  });
  assert.equal(verifyVisionWorkerReceipt(receipt), receipt);
  const tampered = structuredClone(receipt);
  tampered.body.result_canonical_sha256 = "e".repeat(64);
  assert.throws(() => verifyVisionWorkerReceipt(tampered), /signature/);
  const custodyTampered = structuredClone(receipt);
  custodyTampered.body.worker_contract.reservation_ledger.state_directory_path_sha256 =
    "9".repeat(64);
  assert.throws(() => verifyVisionWorkerReceipt(custodyTampered), /signature/);
  assert.throws(() => parseVisionRequestAttestation({
    ...request,
    image_sha256: [request.image_sha256[1], request.image_sha256[0]],
  }, prompt, imageBytes), /exact prompt\/image bytes/);
});

test("durable call_key reservation is immutable and permanently rejects replay", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vision-call-key-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const request = attestedRequest();
  const ledger = await initializeVisionReservationLedger(directory);
  const first = await reserveVisionCallKey(
    directory,
    request,
    "2026-07-18T12:00:00.000Z",
    ledger,
  );
  assert.equal((await stat(first.file)).mode & 0o777, 0o400);
  assert.equal(first.body.reserved_at, "2026-07-18T12:00:00.000Z");
  const persisted = JSON.parse(await readFile(first.file, "utf8"));
  assert.equal(persisted.schema_version, VISION_CALL_RESERVATION_SCHEMA);
  assert.equal(persisted.request_attestation.call_key, request.call_key);
  assert.deepEqual(persisted.reservation_ledger, ledger.contract);
  assert.equal((await stat(path.join(directory, ".ledger-identity.json"))).mode & 0o777, 0o400);
  assert.equal((await stat(path.join(directory, ".ledger-head.json"))).mode & 0o777, 0o400);
  await assert.rejects(
    () => reserveVisionCallKey(
      directory,
      request,
      "2026-07-18T12:00:01.000Z",
      first.ledger,
    ),
    (error) => error instanceof VisionCallKeyAlreadyReservedError,
  );
});

test("configured ledger identity is an all-or-nothing validated pair", () => {
  assert.equal(configuredVisionReservationLedgerIdentity({}), null);
  assert.deepEqual(configuredVisionReservationLedgerIdentity({
    VISION_CALL_LEDGER_EXPECTED_ID: ledgerContract().ledger_id,
    VISION_CALL_LEDGER_EXPECTED_EPOCH: ledgerContract().ledger_epoch,
  }), {
    ledger_id: ledgerContract().ledger_id,
    ledger_epoch: ledgerContract().ledger_epoch,
  });
  assert.throws(() => configuredVisionReservationLedgerIdentity({
    VISION_CALL_LEDGER_EXPECTED_ID: ledgerContract().ledger_id,
  }), /configured together/);
  assert.throws(() => configuredVisionReservationLedgerIdentity({
    VISION_CALL_LEDGER_EXPECTED_ID: "ledger-not-a-uuid",
    VISION_CALL_LEDGER_EXPECTED_EPOCH: ledgerContract().ledger_epoch,
  }), /EXPECTED_ID is invalid/);
});

test("restart on the same ledger preserves identity, build, files, and replay fence", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-restart-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const first = await initializeVisionReservationLedger(directory);
  const request = attestedRequest();
  const reservation = await reserveVisionCallKey(
    directory,
    request,
    "2026-07-18T12:00:00.000Z",
    first,
  );
  const exactReservationBytes = await readFile(reservation.file);
  const restarted = await initializeVisionReservationLedger(directory, {
    expected_identity: expectedLedgerIdentity(first),
  });
  assert.deepEqual(restarted.contract, first.contract);
  assert.deepEqual(await readFile(reservation.file), exactReservationBytes);
  assert.equal(
    computeWorkerBuild([Buffer.from("worker")], contracts(), first.contract),
    computeWorkerBuild([Buffer.from("worker")], contracts(), restarted.contract),
  );
  await assert.rejects(
    () => reserveVisionCallKey(
      directory,
      request,
      "2026-07-18T12:00:01.000Z",
      restarted,
    ),
    (error) => error instanceof VisionCallKeyAlreadyReservedError,
  );
});

test("legacy call-key files are adopted byte-for-byte and still block replay", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-legacy-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const request = attestedRequest();
  const file = path.join(directory, `${request.call_key}.reservation.json`);
  const legacyBytes = Buffer.from(`${JSON.stringify({
    schema_version: "vision-call-key-reservation/v2",
    reserved_at: "2026-07-18T12:00:00.000Z",
    request_attestation: request,
  })}\n`, "utf8");
  await writeFile(file, legacyBytes, { mode: 0o400, flag: "wx" });
  await chmod(file, 0o400);

  const ledger = await initializeVisionReservationLedger(directory);
  assert.equal(ledger.head.body.reservation_count, 1);
  assert.deepEqual(await readFile(file), legacyBytes);
  await assert.rejects(
    () => reserveVisionCallKey(
      directory,
      request,
      "2026-07-18T12:00:01.000Z",
      ledger,
    ),
    (error) => error instanceof VisionCallKeyAlreadyReservedError,
  );
});

test("changing the ledger path changes identity and worker build", async (t) => {
  const firstDirectory = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-path-a-"));
  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-path-b-"));
  const copiedDirectory = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-path-copy-"));
  t.after(async () => Promise.all([
    rm(firstDirectory, { recursive: true, force: true }),
    rm(secondDirectory, { recursive: true, force: true }),
    rm(copiedDirectory, { recursive: true, force: true }),
  ]));
  const first = await initializeVisionReservationLedger(firstDirectory);
  const second = await initializeVisionReservationLedger(secondDirectory);
  assert.notEqual(first.contract.ledger_id, second.contract.ledger_id);
  assert.notEqual(
    first.contract.state_directory_path_sha256,
    second.contract.state_directory_path_sha256,
  );
  assert.notEqual(
    computeWorkerBuild([Buffer.from("worker")], contracts(), first.contract),
    computeWorkerBuild([Buffer.from("worker")], contracts(), second.contract),
  );

  const copiedIdentity = path.join(copiedDirectory, ".ledger-identity.json");
  await copyFile(path.join(firstDirectory, ".ledger-identity.json"), copiedIdentity);
  await chmod(copiedIdentity, 0o400);
  await assert.rejects(
    () => initializeVisionReservationLedger(copiedDirectory, {
      expected_identity: expectedLedgerIdentity(first),
    }),
    /directory\/path custody mismatch/,
  );
});

test("replacing a ledger directory at the same path fails inode custody", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-replaced-"));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "active");
  const oldDirectory = path.join(parent, "old");
  await mkdir(directory, { mode: 0o700 });
  const first = await initializeVisionReservationLedger(directory);
  await rename(directory, oldDirectory);
  await mkdir(directory, { mode: 0o700 });
  const copiedIdentity = path.join(directory, ".ledger-identity.json");
  await copyFile(path.join(oldDirectory, ".ledger-identity.json"), copiedIdentity);
  await chmod(copiedIdentity, 0o400);
  await assert.rejects(
    () => initializeVisionReservationLedger(directory, {
      expected_identity: expectedLedgerIdentity(first),
    }),
    /directory\/path custody mismatch/,
  );
});

test("cleared established ledger fails closed, then gets a new identity/build only unpinned", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-cleared-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const first = await initializeVisionReservationLedger(directory);
  const firstBuild = computeWorkerBuild([Buffer.from("worker")], contracts(), first.contract);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { mode: 0o700 });
  await assert.rejects(
    () => initializeVisionReservationLedger(directory, {
      expected_identity: expectedLedgerIdentity(first),
    }),
    /configured vision reservation ledger identity is missing/,
  );

  const replacement = await initializeVisionReservationLedger(directory);
  assert.notEqual(replacement.contract.ledger_id, first.contract.ledger_id);
  assert.notEqual(replacement.contract.ledger_epoch, first.contract.ledger_epoch);
  assert.notEqual(
    computeWorkerBuild([Buffer.from("worker")], contracts(), replacement.contract),
    firstBuild,
  );
});

test("missing reserved call-key file is detected from the custody head on restart", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-lost-call-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const first = await initializeVisionReservationLedger(directory);
  const reservation = await reserveVisionCallKey(
    directory,
    attestedRequest(),
    "2026-07-18T12:00:00.000Z",
    first,
  );
  await rm(reservation.file);
  await assert.rejects(
    () => initializeVisionReservationLedger(directory, {
      expected_identity: expectedLedgerIdentity(first),
    }),
    /lost or changed reserved call_key/,
  );
});

test("orphaned custody head can never bootstrap a new ledger identity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vision-ledger-orphan-head-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, ".ledger-head.json"), "{}\n", { mode: 0o400 });
  await assert.rejects(
    () => initializeVisionReservationLedger(directory),
    /custody head but no identity/,
  );
});
