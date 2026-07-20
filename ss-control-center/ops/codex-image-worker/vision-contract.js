"use strict";

const {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} = require("crypto");
const {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} = require("fs/promises");
const path = require("path");

const DEFAULT_CODEX_VISION_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_VISION_REASONING_EFFORT = "medium";
const DEFAULT_CLAUDE_VISION_MODEL = "sonnet";
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const VISION_REQUEST_ATTESTATION_SCHEMA = "vision-request-attestation/v2";
const VISION_WORKER_RECEIPT_SCHEMA = "vision-worker-receipt/v2";
const VISION_CALL_RESERVATION_SCHEMA = "vision-call-key-reservation/v3";
const VISION_CALL_RESERVATION_LEGACY_SCHEMA = "vision-call-key-reservation/v2";
const VISION_RESERVATION_LEDGER_IDENTITY_SCHEMA =
  "vision-call-reservation-ledger-identity/v1";
const VISION_RESERVATION_LEDGER_HEAD_SCHEMA =
  "vision-call-reservation-ledger-head/v1";
const VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA =
  "vision-call-reservation-ledger-contract/v1";
const VISION_RESERVATION_LEDGER_IDENTITY_FILE = ".ledger-identity.json";
const VISION_RESERVATION_LEDGER_HEAD_FILE = ".ledger-head.json";
const MAX_LEDGER_CONTROL_BYTES = 16 * 1024 * 1024;
const RESERVATION_FILE_PATTERN = /^([a-f0-9]{64})\.reservation\.json$/;
const LEDGER_TOKEN_PATTERN = /^(?:ledger|epoch)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ledgerMutationChains = new Map();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON rejects undefined");
  return encoded;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys are invalid`);
  }
}

function digest(value, label) {
  const text = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} must be SHA-256`);
  return text;
}

function parseVisionRequestAttestation(raw, prompt, imageBytes) {
  const parsed = parseVisionRequestAttestationShape(raw);
  if (parsed.image_sha256.length !== imageBytes.length) {
    throw new Error("request_attestation image count is invalid");
  }
  const actualPromptSha = sha256(Buffer.from(prompt, "utf8"));
  const actualImageShas = imageBytes.map((bytes) => sha256(bytes));
  if (parsed.prompt_sha256 !== actualPromptSha
    || parsed.image_sha256.some((value, index) => value !== actualImageShas[index])) {
    throw new Error("request_attestation does not match exact prompt/image bytes");
  }
  return parsed;
}

function buildClaudeSubscriptionEnv(source = process.env) {
  const env = { ...source };
  for (const key of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
    "AWS_BEARER_TOKEN_BEDROCK", "GOOGLE_APPLICATION_CREDENTIALS",
    "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
  ]) delete env[key];
  return env;
}

function validateOptionalHealthAuthorization(header, token) {
  if (header === undefined || header === null || header === "") {
    return { allowed: true, auth_verified: false };
  }
  const expected = Buffer.from(`Bearer ${String(token || "")}`, "utf8");
  const actual = Buffer.from(String(header), "utf8");
  const allowed = expected.length === actual.length && timingSafeEqual(expected, actual);
  return { allowed, auth_verified: allowed };
}

function configuredVisionReservationLedgerIdentity(source = process.env) {
  const ledgerId = String(source.VISION_CALL_LEDGER_EXPECTED_ID || "").trim();
  const ledgerEpoch = String(source.VISION_CALL_LEDGER_EXPECTED_EPOCH || "").trim();
  if (!ledgerId && !ledgerEpoch) return null;
  if (!ledgerId || !ledgerEpoch) {
    throw new Error(
      "VISION_CALL_LEDGER_EXPECTED_ID and VISION_CALL_LEDGER_EXPECTED_EPOCH must be configured together",
    );
  }
  if (!LEDGER_TOKEN_PATTERN.test(ledgerId) || !ledgerId.startsWith("ledger-")) {
    throw new Error("VISION_CALL_LEDGER_EXPECTED_ID is invalid");
  }
  if (!LEDGER_TOKEN_PATTERN.test(ledgerEpoch) || !ledgerEpoch.startsWith("epoch-")) {
    throw new Error("VISION_CALL_LEDGER_EXPECTED_EPOCH is invalid");
  }
  return { ledger_id: ledgerId, ledger_epoch: ledgerEpoch };
}

function normalizedLedgerDirectory(stateDirectory) {
  if (typeof stateDirectory !== "string" || !stateDirectory
    || stateDirectory !== stateDirectory.trim()) {
    throw new Error("vision call state directory must be a non-empty path");
  }
  const directory = path.resolve(stateDirectory);
  if (!path.isAbsolute(directory) || directory === path.parse(directory).root) {
    throw new Error("vision call state directory must be a non-root absolute path");
  }
  return directory;
}

async function assertNoSymlinkComponents(target, label) {
  // Bind the canonical real path separately, but reject a symlink at the
  // controlled leaf itself. Rejecting every ancestor would make ordinary
  // macOS paths under /var (a system symlink to /private/var) unusable.
  const info = await lstat(path.resolve(target));
  if (info.isSymbolicLink()) throw new Error(`${label} may not be a symlink`);
}

async function nearestExistingParent(target) {
  let cursor = path.dirname(target);
  while (true) {
    try {
      await lstat(cursor);
      return cursor;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("vision ledger has no existing parent directory");
      cursor = parent;
    }
  }
}

async function ledgerDirectoryCustody(directory, { allowCreate, expectedIdentity }) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    if (!allowCreate || expectedIdentity) {
      throw new Error("configured vision reservation ledger directory is missing");
    }
    const parent = await nearestExistingParent(directory);
    await assertNoSymlinkComponents(parent, "vision reservation ledger parent");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    info = await lstat(directory);
  }
  await assertNoSymlinkComponents(directory, "vision reservation ledger directory");
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("vision call state directory must be a real directory");
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error("vision call state directory mode must be exactly 0700");
  }
  const canonicalPath = await realpath(directory);
  return {
    directory,
    state_directory_path_sha256: sha256(Buffer.from(canonicalPath, "utf8")),
    directory_identity_sha256: sha256(Buffer.from(canonicalJson({
      device: String(info.dev),
      inode: String(info.ino),
    }), "utf8")),
  };
}

function parseLedgerIdentityArtifact(raw, exactBytesSha256, custody) {
  exactKeys(raw, ["schema_version", "body", "body_sha256"], "ledger identity");
  if (raw.schema_version !== VISION_RESERVATION_LEDGER_IDENTITY_SCHEMA) {
    throw new Error("ledger identity schema is invalid");
  }
  exactKeys(raw.body, [
    "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "created_at",
  ], "ledger identity body");
  const body = {
    ledger_id: requiredText(raw.body.ledger_id, "ledger identity ledger_id"),
    ledger_epoch: requiredText(raw.body.ledger_epoch, "ledger identity ledger_epoch"),
    state_directory_path_sha256: digest(
      raw.body.state_directory_path_sha256,
      "ledger identity state_directory_path_sha256",
    ),
    directory_identity_sha256: digest(
      raw.body.directory_identity_sha256,
      "ledger identity directory_identity_sha256",
    ),
    created_at: requiredText(raw.body.created_at, "ledger identity created_at"),
  };
  if (!LEDGER_TOKEN_PATTERN.test(body.ledger_id) || !body.ledger_id.startsWith("ledger-")
    || !LEDGER_TOKEN_PATTERN.test(body.ledger_epoch) || !body.ledger_epoch.startsWith("epoch-")) {
    throw new Error("ledger identity id/epoch is invalid");
  }
  if (!Number.isFinite(Date.parse(body.created_at))
    || new Date(body.created_at).toISOString() !== body.created_at) {
    throw new Error("ledger identity created_at must be canonical UTC ISO-8601");
  }
  if (raw.body_sha256 !== sha256(Buffer.from(canonicalJson(body), "utf8"))) {
    throw new Error("ledger identity body SHA mismatch");
  }
  if (body.state_directory_path_sha256 !== custody.state_directory_path_sha256
    || body.directory_identity_sha256 !== custody.directory_identity_sha256) {
    throw new Error("vision reservation ledger directory/path custody mismatch");
  }
  return {
    schema_version: VISION_RESERVATION_LEDGER_IDENTITY_SCHEMA,
    body,
    body_sha256: raw.body_sha256,
    exact_bytes_sha256: exactBytesSha256,
  };
}

function visionReservationLedgerContract(identity) {
  return {
    schema_version: VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA,
    ledger_id: identity.body.ledger_id,
    ledger_epoch: identity.body.ledger_epoch,
    state_directory_path_sha256: identity.body.state_directory_path_sha256,
    directory_identity_sha256: identity.body.directory_identity_sha256,
    identity_artifact_sha256: identity.exact_bytes_sha256,
  };
}

function parseVisionReservationLedgerContract(raw) {
  exactKeys(raw, [
    "schema_version", "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "identity_artifact_sha256",
  ], "vision reservation ledger contract");
  if (raw.schema_version !== VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA
    || !LEDGER_TOKEN_PATTERN.test(String(raw.ledger_id || ""))
    || !String(raw.ledger_id).startsWith("ledger-")
    || !LEDGER_TOKEN_PATTERN.test(String(raw.ledger_epoch || ""))
    || !String(raw.ledger_epoch).startsWith("epoch-")) {
    throw new Error("vision reservation ledger contract identity is invalid");
  }
  return {
    schema_version: VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA,
    ledger_id: raw.ledger_id,
    ledger_epoch: raw.ledger_epoch,
    state_directory_path_sha256: digest(
      raw.state_directory_path_sha256,
      "ledger contract state_directory_path_sha256",
    ),
    directory_identity_sha256: digest(
      raw.directory_identity_sha256,
      "ledger contract directory_identity_sha256",
    ),
    identity_artifact_sha256: digest(
      raw.identity_artifact_sha256,
      "ledger contract identity_artifact_sha256",
    ),
  };
}

function buildLedgerHead(identitySha256, reservations) {
  const sorted = [...reservations].sort((left, right) => left.call_key.localeCompare(right.call_key));
  const body = {
    identity_artifact_sha256: identitySha256,
    reservation_count: sorted.length,
    reservations: sorted,
  };
  return {
    schema_version: VISION_RESERVATION_LEDGER_HEAD_SCHEMA,
    body,
    body_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
}

function parseLedgerHead(raw, identitySha256) {
  exactKeys(raw, ["schema_version", "body", "body_sha256"], "ledger head");
  if (raw.schema_version !== VISION_RESERVATION_LEDGER_HEAD_SCHEMA) {
    throw new Error("ledger head schema is invalid");
  }
  exactKeys(raw.body, [
    "identity_artifact_sha256", "reservation_count", "reservations",
  ], "ledger head body");
  if (raw.body.identity_artifact_sha256 !== identitySha256
    || !Number.isSafeInteger(raw.body.reservation_count)
    || raw.body.reservation_count < 0
    || !Array.isArray(raw.body.reservations)
    || raw.body.reservation_count !== raw.body.reservations.length) {
    throw new Error("ledger head identity/count is invalid");
  }
  const reservations = raw.body.reservations.map((entry, index) => {
    exactKeys(entry, ["call_key", "reservation_file_sha256"], `ledger head reservation[${index}]`);
    return {
      call_key: digest(entry.call_key, `ledger head reservation[${index}].call_key`),
      reservation_file_sha256: digest(
        entry.reservation_file_sha256,
        `ledger head reservation[${index}].reservation_file_sha256`,
      ),
    };
  });
  if (new Set(reservations.map((entry) => entry.call_key)).size !== reservations.length
    || reservations.some((entry, index) => index > 0
      && reservations[index - 1].call_key.localeCompare(entry.call_key) >= 0)) {
    throw new Error("ledger head reservations must be unique and sorted");
  }
  const body = {
    identity_artifact_sha256: identitySha256,
    reservation_count: reservations.length,
    reservations,
  };
  if (raw.body_sha256 !== sha256(Buffer.from(canonicalJson(body), "utf8"))) {
    throw new Error("ledger head body SHA mismatch");
  }
  return { schema_version: VISION_RESERVATION_LEDGER_HEAD_SCHEMA, body, body_sha256: raw.body_sha256 };
}

async function readBoundLedgerJson(file, label, expectedMode = 0o400) {
  await assertNoSymlinkComponents(file, label);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== expectedMode) {
    throw new Error(`${label} must be a mode-${expectedMode.toString(8)} regular file`);
  }
  if (info.size > MAX_LEDGER_CONTROL_BYTES) throw new Error(`${label} exceeds its byte cap`);
  const bytes = await readFile(file);
  if (bytes.length !== info.size) throw new Error(`${label} changed while being read`);
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
  return { bytes, value, sha256: sha256(bytes) };
}

async function writeExclusiveLedgerJson(file, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(file, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return { bytes, sha256: sha256(bytes) };
}

async function replaceLedgerHead(file, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const staging = `${file}.staging-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o400);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, file);
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    try { await unlink(staging); } catch (cleanupError) {
      if (cleanupError && cleanupError.code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], "ledger head cleanup failed");
      }
    }
    throw error;
  }
  return { bytes, sha256: sha256(bytes) };
}

async function scanLedgerReservations(directory, contract) {
  const names = await readdir(directory);
  const reservations = [];
  for (const name of names) {
    if (name === VISION_RESERVATION_LEDGER_IDENTITY_FILE
      || name === VISION_RESERVATION_LEDGER_HEAD_FILE) continue;
    if (name.startsWith(`${VISION_RESERVATION_LEDGER_HEAD_FILE}.staging-`)) {
      throw new Error(`vision reservation ledger contains an unpublished head staging file: ${name}`);
    }
    const match = RESERVATION_FILE_PATTERN.exec(name);
    if (!match) throw new Error(`vision reservation ledger contains an unexpected entry: ${name}`);
    const callKey = match[1];
    const loaded = await readBoundLedgerJson(path.join(directory, name), `reservation ${callKey}`);
    exactKeys(
      loaded.value,
      loaded.value.schema_version === VISION_CALL_RESERVATION_SCHEMA
        ? ["schema_version", "reserved_at", "request_attestation", "reservation_ledger"]
        : ["schema_version", "reserved_at", "request_attestation"],
      `reservation ${callKey}`,
    );
    if (loaded.value.schema_version !== VISION_CALL_RESERVATION_SCHEMA
      && loaded.value.schema_version !== VISION_CALL_RESERVATION_LEGACY_SCHEMA) {
      throw new Error(`reservation ${callKey} schema is unsupported`);
    }
    const request = parseVisionRequestAttestationShape(loaded.value.request_attestation);
    if (request.call_key !== callKey) throw new Error(`reservation ${callKey} filename/body mismatch`);
    const timestamp = requiredText(loaded.value.reserved_at, `reservation ${callKey} timestamp`);
    if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
      throw new Error(`reservation ${callKey} timestamp is invalid`);
    }
    if (loaded.value.schema_version === VISION_CALL_RESERVATION_SCHEMA) {
      if (!contract || canonicalJson(parseVisionReservationLedgerContract(
        loaded.value.reservation_ledger,
      )) !== canonicalJson(contract)) {
        throw new Error(`reservation ${callKey} is bound to a different ledger identity`);
      }
    }
    reservations.push({ call_key: callKey, reservation_file_sha256: loaded.sha256 });
  }
  reservations.sort((left, right) => left.call_key.localeCompare(right.call_key));
  return reservations;
}

async function readVisionReservationLedger(stateDirectory, expectedIdentity, reconcileExtras) {
  const directory = normalizedLedgerDirectory(stateDirectory);
  const custody = await ledgerDirectoryCustody(directory, {
    allowCreate: false,
    expectedIdentity,
  });
  const identityPath = path.join(directory, VISION_RESERVATION_LEDGER_IDENTITY_FILE);
  let identityFile;
  try {
    identityFile = await readBoundLedgerJson(identityPath, "vision reservation ledger identity");
  } catch (error) {
    if (error && error.code === "ENOENT" && expectedIdentity) {
      throw new Error("configured vision reservation ledger identity is missing");
    }
    throw error;
  }
  const identity = parseLedgerIdentityArtifact(identityFile.value, identityFile.sha256, custody);
  if (expectedIdentity && (identity.body.ledger_id !== expectedIdentity.ledger_id
    || identity.body.ledger_epoch !== expectedIdentity.ledger_epoch)) {
    throw new Error("configured vision reservation ledger identity/epoch mismatch");
  }
  const contract = visionReservationLedgerContract(identity);
  const headPath = path.join(directory, VISION_RESERVATION_LEDGER_HEAD_FILE);
  let headFile;
  try {
    headFile = await readBoundLedgerJson(headPath, "vision reservation ledger head");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error("established vision reservation ledger custody head is missing");
    }
    throw error;
  }
  let head = parseLedgerHead(headFile.value, identity.exact_bytes_sha256);
  const actualReservations = await scanLedgerReservations(directory, contract);
  const actualByKey = new Map(actualReservations.map((entry) => [entry.call_key, entry]));
  for (const entry of head.body.reservations) {
    const actual = actualByKey.get(entry.call_key);
    if (!actual || actual.reservation_file_sha256 !== entry.reservation_file_sha256) {
      throw new Error(`vision reservation ledger lost or changed reserved call_key ${entry.call_key}`);
    }
  }
  if (actualReservations.length !== head.body.reservations.length) {
    if (!reconcileExtras) {
      throw new Error("vision reservation ledger contains an uncommitted reservation");
    }
    head = buildLedgerHead(identity.exact_bytes_sha256, actualReservations);
    await replaceLedgerHead(headPath, head);
  }
  return { directory, identity, contract, head };
}

async function initializeVisionReservationLedger(stateDirectory, options = {}) {
  const directory = normalizedLedgerDirectory(stateDirectory);
  const expectedIdentity = options.expected_identity
    ?? configuredVisionReservationLedgerIdentity(options.env ?? process.env);
  let custody;
  try {
    custody = await ledgerDirectoryCustody(directory, {
      allowCreate: true,
      expectedIdentity,
    });
  } catch (error) {
    throw new Error(`vision reservation ledger startup failed: ${error.message}`);
  }
  const identityPath = path.join(directory, VISION_RESERVATION_LEDGER_IDENTITY_FILE);
  try {
    await lstat(identityPath);
    return await readVisionReservationLedger(directory, expectedIdentity, true);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (expectedIdentity) {
    throw new Error("configured vision reservation ledger identity is missing");
  }
  try {
    await lstat(path.join(directory, VISION_RESERVATION_LEDGER_HEAD_FILE));
    throw new Error("vision reservation ledger has a custody head but no identity");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const preexistingReservations = await scanLedgerReservations(directory, null);
  const nowValue = options.now ? options.now() : new Date();
  const createdAt = nowValue instanceof Date
    ? nowValue.toISOString()
    : String(nowValue);
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw new Error("vision reservation ledger creation clock is invalid");
  }
  const uuid = options.random_uuid ?? randomUUID;
  const body = {
    ledger_id: `ledger-${uuid()}`,
    ledger_epoch: `epoch-${uuid()}`,
    state_directory_path_sha256: custody.state_directory_path_sha256,
    directory_identity_sha256: custody.directory_identity_sha256,
    created_at: createdAt,
  };
  const identityArtifact = {
    schema_version: VISION_RESERVATION_LEDGER_IDENTITY_SCHEMA,
    body,
    body_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
  let identityWritten = false;
  try {
    const written = await writeExclusiveLedgerJson(identityPath, identityArtifact);
    identityWritten = true;
    const identity = parseLedgerIdentityArtifact(identityArtifact, written.sha256, custody);
    const head = buildLedgerHead(identity.exact_bytes_sha256, preexistingReservations);
    await replaceLedgerHead(path.join(directory, VISION_RESERVATION_LEDGER_HEAD_FILE), head);
  } catch (error) {
    if (identityWritten) {
      try { await unlink(identityPath); } catch { /* preserve the original startup failure */ }
    }
    throw error;
  }
  return readVisionReservationLedger(directory, null, false);
}

function withLedgerMutation(directory, operation) {
  const prior = ledgerMutationChains.get(directory) ?? Promise.resolve();
  const current = prior.then(operation, operation);
  const tail = current.then(() => undefined, () => undefined);
  ledgerMutationChains.set(directory, tail);
  return current.finally(() => {
    if (ledgerMutationChains.get(directory) === tail) ledgerMutationChains.delete(directory);
  });
}

class VisionCallKeyAlreadyReservedError extends Error {
  constructor(callKey) {
    super(`vision call_key is already reserved: ${callKey}`);
    this.name = "VisionCallKeyAlreadyReservedError";
    this.code = "VISION_CALL_KEY_ALREADY_RESERVED";
  }
}

/**
 * Permanently reserve an attested call_key before spawning the model process.
 * The file is exclusive-create + fsync + read-only; a crash therefore becomes
 * an explicit ambiguous stop rather than a replay that consumes a second turn.
 */
async function reserveVisionCallKey(
  stateDirectory,
  requestAttestation,
  reservedAt,
  establishedLedger,
) {
  const directory = normalizedLedgerDirectory(stateDirectory);
  const parsed = parseVisionRequestAttestationShape(requestAttestation);
  const timestamp = requiredText(reservedAt, "vision reservation timestamp");
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error("vision reservation timestamp must be canonical UTC ISO-8601");
  }
  const initialLedger = establishedLedger
    ?? await initializeVisionReservationLedger(directory);
  const establishedContract = parseVisionReservationLedgerContract(initialLedger.contract);
  return withLedgerMutation(directory, async () => {
    const ledger = await readVisionReservationLedger(directory, {
      ledger_id: establishedContract.ledger_id,
      ledger_epoch: establishedContract.ledger_epoch,
    }, true);
    if (canonicalJson(ledger.contract) !== canonicalJson(establishedContract)) {
      throw new Error("vision reservation ledger identity changed after worker startup");
    }
    const file = path.join(directory, `${parsed.call_key}.reservation.json`);
    const body = {
      schema_version: VISION_CALL_RESERVATION_SCHEMA,
      reserved_at: timestamp,
      request_attestation: parsed,
      reservation_ledger: establishedContract,
    };
    const bytes = Buffer.from(`${canonicalJson(body)}\n`, "utf8");
    let handle;
    try {
      handle = await open(file, "wx", 0o400);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw new VisionCallKeyAlreadyReservedError(parsed.call_key);
      }
      throw error;
    }
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o400);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    const reservationSha256 = sha256(bytes);
    const nextReservations = [...ledger.head.body.reservations, {
      call_key: parsed.call_key,
      reservation_file_sha256: reservationSha256,
    }];
    const nextHead = buildLedgerHead(
      ledger.identity.exact_bytes_sha256,
      nextReservations,
    );
    await replaceLedgerHead(
      path.join(directory, VISION_RESERVATION_LEDGER_HEAD_FILE),
      nextHead,
    );
    return {
      file,
      body,
      ledger_contract: establishedContract,
      ledger: { ...ledger, head: nextHead },
    };
  });
}

function parseVisionRequestAttestationShape(raw) {
  exactKeys(raw, [
    "schema_version", "run_lock_sha256", "shard_id", "call_index", "call_key",
    "prompt_sha256", "image_sha256", "execution_permit_sha256", "partition_id",
  ], "request_attestation");
  if (raw.schema_version !== VISION_REQUEST_ATTESTATION_SCHEMA) {
    throw new Error("request_attestation schema is invalid");
  }
  if (!Number.isSafeInteger(raw.call_index) || raw.call_index < 0) {
    throw new Error("request_attestation.call_index is invalid");
  }
  if (!Array.isArray(raw.image_sha256) || raw.image_sha256.length < 1
    || raw.image_sha256.length > 6) {
    throw new Error("request_attestation image count is invalid");
  }
  return {
    schema_version: VISION_REQUEST_ATTESTATION_SCHEMA,
    run_lock_sha256: digest(raw.run_lock_sha256, "request_attestation.run_lock_sha256"),
    shard_id: requiredText(raw.shard_id, "request_attestation.shard_id"),
    call_index: raw.call_index,
    call_key: digest(raw.call_key, "request_attestation.call_key"),
    prompt_sha256: digest(raw.prompt_sha256, "request_attestation.prompt_sha256"),
    execution_permit_sha256: digest(
      raw.execution_permit_sha256,
      "request_attestation.execution_permit_sha256",
    ),
    partition_id: requiredText(raw.partition_id, "request_attestation.partition_id"),
    image_sha256: raw.image_sha256.map((value, index) => (
      digest(value, `request_attestation.image_sha256[${index}]`)
    )),
  };
}

function createVisionReceiptSigner(privateKeyPkcs8Base64, keyId) {
  const encoded = String(privateKeyPkcs8Base64 || "").trim();
  if (!encoded) return null;
  const privateKey = createPrivateKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("vision receipt key must be Ed25519 PKCS8 DER");
  }
  const parsedKeyId = requiredToken(keyId, "VISION_ATTESTATION_KEY_ID");
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKeySpkiDerBase64 = publicDer.toString("base64");
  const publicKeySpkiSha256 = sha256(publicDer);
  return {
    key_id: parsedKeyId,
    public_key_spki_der_base64: publicKeySpkiDerBase64,
    public_key_spki_sha256: publicKeySpkiSha256,
    sign(body) {
      const signature = sign(null, Buffer.from(canonicalJson(body), "utf8"), privateKey);
      return {
        schema_version: VISION_WORKER_RECEIPT_SCHEMA,
        key_id: parsedKeyId,
        public_key_spki_der_base64: publicKeySpkiDerBase64,
        public_key_spki_sha256: publicKeySpkiSha256,
        body,
        signature_base64: signature.toString("base64"),
      };
    },
  };
}

function verifyVisionWorkerReceipt(receipt) {
  exactKeys(receipt, [
    "schema_version", "key_id", "public_key_spki_der_base64",
    "public_key_spki_sha256", "body", "signature_base64",
  ], "worker_receipt");
  if (receipt.schema_version !== VISION_WORKER_RECEIPT_SCHEMA) {
    throw new Error("worker_receipt schema is invalid");
  }
  const publicDer = Buffer.from(String(receipt.public_key_spki_der_base64 || ""), "base64");
  if (!publicDer.length || sha256(publicDer) !== receipt.public_key_spki_sha256) {
    throw new Error("worker_receipt public key fingerprint mismatch");
  }
  const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  const signature = Buffer.from(String(receipt.signature_base64 || ""), "base64");
  if (!verify(null, Buffer.from(canonicalJson(receipt.body), "utf8"), publicKey, signature)) {
    throw new Error("worker_receipt signature is invalid");
  }
  return receipt;
}

function requiredToken(value, label) {
  const text = String(value || "").trim();
  if (!text || !/^[a-zA-Z0-9][a-zA-Z0-9._:+/-]*$/.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function parseVisionTimeoutMs(value) {
  const timeout = Number(value === undefined || value === null || value === ""
    ? 180_000
    : value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 600_000) {
    throw new Error("VISION_TIMEOUT_MS must be a safe integer from 1000 to 600000");
  }
  return timeout;
}

function createVisionContracts({
  env = process.env,
  codexCliVersion,
  claudeCliVersion,
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
}) {
  const codexModel = requiredToken(
    env.CODEX_VISION_MODEL || DEFAULT_CODEX_VISION_MODEL,
    "CODEX_VISION_MODEL",
  );
  const codexReasoning = requiredToken(
    env.CODEX_VISION_REASONING_EFFORT || DEFAULT_CODEX_VISION_REASONING_EFFORT,
    "CODEX_VISION_REASONING_EFFORT",
  );
  if (!REASONING_EFFORTS.has(codexReasoning)) {
    throw new Error("CODEX_VISION_REASONING_EFFORT is unsupported");
  }
  const common = {
    node_version: requiredText(nodeVersion, "node version"),
    platform: requiredToken(platform, "platform"),
    arch: requiredToken(arch, "architecture"),
  };
  return {
    codex_cli_subscription: {
      model: codexModel,
      reasoning_effort: codexReasoning,
      cli_version: requiredText(codexCliVersion, "Codex CLI version"),
      ...common,
    },
    claude_cli_subscription: {
      model: requiredToken(
        env.CLAUDE_VISION_MODEL || DEFAULT_CLAUDE_VISION_MODEL,
        "CLAUDE_VISION_MODEL",
      ),
      reasoning_effort: null,
      cli_version: requiredText(claudeCliVersion, "Claude CLI version"),
      ...common,
    },
  };
}

function buildCodexVisionArgs(imgFiles, contract) {
  if (!Array.isArray(imgFiles) || imgFiles.length === 0
    || imgFiles.some((file) => typeof file !== "string" || !file)) {
    throw new Error("Codex vision requires at least one image path");
  }
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--model",
    requiredToken(contract && contract.model, "Codex vision model"),
    "--config",
    `model_reasoning_effort=${JSON.stringify(requiredToken(
      contract && contract.reasoning_effort,
      "Codex reasoning effort",
    ))}`,
  ];
  for (const file of imgFiles) args.push("-i", file);
  return args;
}

function visionMetadata(
  provider,
  inputImageCount,
  contracts,
  workerBuild,
  reservationLedgerContract,
) {
  const contract = contracts[provider];
  if (!contract) throw new Error(`unsupported vision provider ${provider}`);
  if (!Number.isInteger(inputImageCount) || inputImageCount < 0) {
    throw new Error("input image count must be a non-negative integer");
  }
  const reservationLedger = parseVisionReservationLedgerContract(
    reservationLedgerContract,
  );
  return {
    input_image_count: inputImageCount,
    vision_provider: provider,
    vision_model: contract.model,
    vision_reasoning_effort: contract.reasoning_effort,
    cli_version: contract.cli_version,
    node_version: contract.node_version,
    runtime_platform: contract.platform,
    runtime_arch: contract.arch,
    worker_build: workerBuild,
    reservation_ledger: reservationLedger,
  };
}

function computeWorkerBuild(sourceBuffers, contracts, reservationLedgerContract) {
  if (!Array.isArray(sourceBuffers) || sourceBuffers.length === 0) {
    throw new Error("worker build requires source bytes");
  }
  const reservationLedger = parseVisionReservationLedgerContract(
    reservationLedgerContract,
  );
  const hash = createHash("sha256");
  for (const bytes of sourceBuffers) hash.update(bytes).update("\0");
  hash.update(JSON.stringify(contracts));
  hash.update("\0").update(canonicalJson(reservationLedger));
  return `sha256:${hash.digest("hex")}`;
}

module.exports = {
  DEFAULT_CODEX_VISION_MODEL,
  DEFAULT_CODEX_VISION_REASONING_EFFORT,
  DEFAULT_CLAUDE_VISION_MODEL,
  VISION_CALL_RESERVATION_SCHEMA,
  VISION_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  VISION_RESERVATION_LEDGER_HEAD_SCHEMA,
  VISION_RESERVATION_LEDGER_IDENTITY_SCHEMA,
  VISION_REQUEST_ATTESTATION_SCHEMA,
  VISION_WORKER_RECEIPT_SCHEMA,
  VisionCallKeyAlreadyReservedError,
  buildClaudeSubscriptionEnv,
  canonicalJson,
  buildCodexVisionArgs,
  computeWorkerBuild,
  configuredVisionReservationLedgerIdentity,
  createVisionContracts,
  createVisionReceiptSigner,
  initializeVisionReservationLedger,
  parseVisionRequestAttestation,
  parseVisionReservationLedgerContract,
  parseVisionTimeoutMs,
  reserveVisionCallKey,
  sha256,
  validateOptionalHealthAuthorization,
  verifyVisionWorkerReceipt,
  visionMetadata,
};
