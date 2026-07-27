import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

export const PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA =
  "product-truth-control-command/1.0.0" as const;
export const PRODUCT_TRUTH_CONTROL_ARTIFACT_SCHEMA =
  "product-truth-control-artifact/1.0.0" as const;
export const PRODUCT_TRUTH_CONTROL_EVENT_SCHEMA =
  "product-truth-control-event/1.0.0" as const;
export const PRODUCT_TRUTH_CONTROL_KEY_FAMILY =
  "product-truth-owner-control" as const;
export const PRODUCT_TRUTH_CONTROL_ALGORITHM = "Ed25519" as const;
export const PRODUCT_TRUTH_CONTROL_RUNTIME_MODE = "OFF" as const;
export const PRODUCT_TRUTH_CONTROL_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const PRODUCT_TRUTH_CONTROL_ZERO_HASH = "0".repeat(64);

const SIGNING_DOMAIN = Buffer.from(
  "SSCC_PRODUCT_TRUTH_COMMAND_AUTHORITY_V1\0",
  "utf8",
);
const EVENT_DOMAIN = Buffer.from(
  "SSCC_PRODUCT_TRUTH_CONTROL_EVENT_V1\0",
  "utf8",
);

export const PRODUCT_TRUTH_CONTROL_COMMAND_KINDS = [
  "DOCTOR",
  "READINESS",
  "STATUS",
  "REPORT",
  "CENSUS_CAPTURE",
  "MANIFEST_COMPILE",
  "MIGRATIONS_PLAN",
  "BACKFILL_PLAN",
  "RUN_PLAN",
  "MIGRATIONS_APPLY",
  "BACKFILL_APPLY",
  "EXECUTE",
  "RESUME",
] as const;

export type ProductTruthControlCommandKind =
  (typeof PRODUCT_TRUTH_CONTROL_COMMAND_KINDS)[number];

export const PRODUCT_TRUTH_CONTROL_GATE_CLASSES = [
  "READ_ONLY",
  "ARTIFACT_PLAN",
  "DB_WRITE",
  "METERED_EXECUTE",
] as const;

export type ProductTruthControlGateClass =
  (typeof PRODUCT_TRUTH_CONTROL_GATE_CLASSES)[number];

export const PRODUCT_TRUTH_CONTROL_ARTIFACT_ROLES = [
  "REQUEST",
  "CENSUS_CAPTURE",
  "OWNER_DISPOSITION",
  "SOURCE_REPORT",
  "MANIFEST",
  "MIGRATION_PLAN",
  "MIGRATION_CERTIFICATION",
  "BACKFILL_PLAN",
  "RUN_PLAN",
  "OWNER_APPROVAL",
  "PROVIDER_PERMIT",
  "BALANCE_EVIDENCE",
  "RESULT",
  "REPORT",
  "ARTIFACT_INDEX",
] as const;

export type ProductTruthControlArtifactRole =
  (typeof PRODUCT_TRUTH_CONTROL_ARTIFACT_ROLES)[number];

export const PRODUCT_TRUTH_CONTROL_STATUSES = [
  "DRAFT",
  "VALIDATING",
  "BLOCKED",
  "AWAITING_OWNER",
  "ADMITTED",
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "AMBIGUOUS",
  "CANCELLED",
] as const;

export type ProductTruthControlStatus =
  (typeof PRODUCT_TRUTH_CONTROL_STATUSES)[number];

export const PRODUCT_TRUTH_CONTROL_EVENT_TYPES = [
  "REQUESTED",
  "ARTIFACTS_VALIDATED",
  "AWAITING_OWNER",
  "OWNER_VERIFIED",
  "ADMITTED",
  "CLAIMED",
  "HEARTBEAT",
  "EXECUTION_BOUNDARY",
  "ARTIFACT_RECEIVED",
  "SUCCEEDED",
  "FAILED",
  "AMBIGUOUS",
  "CANCELLED_BEFORE_EXECUTION",
] as const;

export type ProductTruthControlEventType =
  (typeof PRODUCT_TRUTH_CONTROL_EVENT_TYPES)[number];

export type ProductTruthControlEnvironment =
  | "LOCAL"
  | "STAGING"
  | "PRODUCTION";

export interface ProductTruthControlArtifactReference {
  role: ProductTruthControlArtifactRole;
  sha256: string;
  byteSize: number;
}

export interface ProductTruthControlAuthority {
  ownerKeyId: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  nonce: string | null;
}

export interface ProductTruthControlEnvelope {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA;
  commandId: string;
  commandKind: ProductTruthControlCommandKind;
  gateClass: ProductTruthControlGateClass;
  engine: {
    releaseId: string;
    commitSha: string;
    treeSha: string;
    executableTreeSha256: string;
  };
  target: {
    environment: ProductTruthControlEnvironment;
    databaseTargetFingerprint: string;
    manifestSha256: string;
  };
  artifacts: ProductTruthControlArtifactReference[];
  authority: ProductTruthControlAuthority;
  claims: {
    noImplicitScope: true;
    noMarketplaceMutation: true;
    ambiguousNeverReplay: true;
    bjsForbidden: true;
    clubsRequireSeparateGate: true;
  };
}

export interface ProductTruthControlTrustedKey {
  keyId: string;
  keyFamily: typeof PRODUCT_TRUTH_CONTROL_KEY_FAMILY;
  algorithm: typeof PRODUCT_TRUTH_CONTROL_ALGORITHM;
  environment: ProductTruthControlEnvironment;
  publicKeySpkiDerBase64: string;
  publicKeySpkiSha256: string;
  status: "ACTIVE" | "REVOKED";
}

export interface ProductTruthControlSealedArtifact {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_ARTIFACT_SCHEMA;
  artifactId: string;
  commandId: string;
  role: ProductTruthControlArtifactRole;
  mediaType: string;
  content: Buffer;
  byteSize: number;
  sha256: string;
  locator: string;
  createdAt: string;
  createdByPrincipal: string;
}

export interface ProductTruthControlSealedEvent {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_EVENT_SCHEMA;
  eventId: string;
  commandId: string;
  sequence: number;
  eventType: ProductTruthControlEventType;
  source: "SERVER" | "OWNER_VERIFIER" | "WORKER";
  occurredAt: string;
  payload: Buffer;
  payloadSha256: string;
  previousEventHash: string;
  eventHash: string;
}

export class ProductTruthControlContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthControlContractError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthControlContractError(code, message);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail("NON_CANONICAL_KEYS", `${label} keys/order are not canonical`);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function validToken(value: unknown, minimum = 8, maximum = 200): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value) &&
    !/TODO|PLACEHOLDER/u.test(value)
  );
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || !value || /\s/u.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.toString("base64") === value;
  } catch {
    return false;
  }
}

export function productTruthControlGateClass(
  kind: ProductTruthControlCommandKind,
): ProductTruthControlGateClass {
  if (["DOCTOR", "READINESS", "STATUS", "REPORT"].includes(kind)) {
    return "READ_ONLY";
  }
  if (
    [
      "CENSUS_CAPTURE",
      "MANIFEST_COMPILE",
      "MIGRATIONS_PLAN",
      "BACKFILL_PLAN",
      "RUN_PLAN",
    ].includes(kind)
  ) {
    return "ARTIFACT_PLAN";
  }
  if (["MIGRATIONS_APPLY", "BACKFILL_APPLY"].includes(kind)) {
    return "DB_WRITE";
  }
  return "METERED_EXECUTE";
}

function parseArtifactReference(
  value: unknown,
): ProductTruthControlArtifactReference {
  if (!isRecord(value)) fail("INVALID_ARTIFACT_REFERENCE", "artifact must be an object");
  exactKeys(value, ["role", "sha256", "byteSize"], "artifact");
  if (
    !PRODUCT_TRUTH_CONTROL_ARTIFACT_ROLES.includes(
      value.role as ProductTruthControlArtifactRole,
    ) ||
    !isSha256(value.sha256) ||
    !Number.isSafeInteger(value.byteSize) ||
    Number(value.byteSize) <= 0 ||
    Number(value.byteSize) > PRODUCT_TRUTH_CONTROL_MAX_ARTIFACT_BYTES
  ) {
    fail("INVALID_ARTIFACT_REFERENCE", "artifact binding is invalid");
  }
  return {
    role: value.role as ProductTruthControlArtifactRole,
    sha256: value.sha256,
    byteSize: Number(value.byteSize),
  };
}

function parseAuthority(
  value: unknown,
  gateClass: ProductTruthControlGateClass,
): ProductTruthControlAuthority {
  if (!isRecord(value)) fail("INVALID_AUTHORITY", "authority must be an object");
  exactKeys(value, ["ownerKeyId", "issuedAt", "expiresAt", "nonce"], "authority");
  const requiresOwner =
    gateClass === "DB_WRITE" || gateClass === "METERED_EXECUTE";
  const allNull = [value.ownerKeyId, value.issuedAt, value.expiresAt, value.nonce]
    .every((entry) => entry === null);
  if (!requiresOwner && allNull) {
    return {
      ownerKeyId: null,
      issuedAt: null,
      expiresAt: null,
      nonce: null,
    };
  }
  if (
    !requiresOwner ||
    !validToken(value.ownerKeyId) ||
    !canonicalUtc(value.issuedAt) ||
    !canonicalUtc(value.expiresAt) ||
    !validToken(value.nonce, 16, 200)
  ) {
    fail("INVALID_AUTHORITY", "owner authority is missing or not canonical");
  }
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 30 * 60_000) {
    fail("INVALID_AUTHORITY", "owner authority lifetime is invalid");
  }
  return {
    ownerKeyId: value.ownerKeyId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    nonce: value.nonce,
  };
}

export function parseProductTruthControlEnvelope(
  value: unknown,
): ProductTruthControlEnvelope {
  if (!isRecord(value)) fail("INVALID_COMMAND", "command must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "commandId",
      "commandKind",
      "gateClass",
      "engine",
      "target",
      "artifacts",
      "authority",
      "claims",
    ],
    "command",
  );
  if (
    value.schemaVersion !== PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA ||
    !validToken(value.commandId) ||
    !PRODUCT_TRUTH_CONTROL_COMMAND_KINDS.includes(
      value.commandKind as ProductTruthControlCommandKind,
    ) ||
    !PRODUCT_TRUTH_CONTROL_GATE_CLASSES.includes(
      value.gateClass as ProductTruthControlGateClass,
    )
  ) {
    fail("INVALID_COMMAND", "command identity or class is invalid");
  }
  const commandKind = value.commandKind as ProductTruthControlCommandKind;
  const gateClass = value.gateClass as ProductTruthControlGateClass;
  if (productTruthControlGateClass(commandKind) !== gateClass) {
    fail("GATE_CLASS_MISMATCH", "command kind cannot select another gate class");
  }

  if (!isRecord(value.engine)) fail("INVALID_ENGINE", "engine must be an object");
  exactKeys(
    value.engine,
    ["releaseId", "commitSha", "treeSha", "executableTreeSha256"],
    "engine",
  );
  if (
    !validToken(value.engine.releaseId) ||
    !isGitSha(value.engine.commitSha) ||
    !isGitSha(value.engine.treeSha) ||
    !isSha256(value.engine.executableTreeSha256)
  ) {
    fail("INVALID_ENGINE", "engine release binding is invalid");
  }

  if (!isRecord(value.target)) fail("INVALID_TARGET", "target must be an object");
  exactKeys(
    value.target,
    ["environment", "databaseTargetFingerprint", "manifestSha256"],
    "target",
  );
  if (
    !["LOCAL", "STAGING", "PRODUCTION"].includes(
      String(value.target.environment),
    ) ||
    !isSha256(value.target.databaseTargetFingerprint) ||
    !isSha256(value.target.manifestSha256)
  ) {
    fail("INVALID_TARGET", "target binding is invalid");
  }

  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > 32
  ) {
    fail("INVALID_ARTIFACT_REFERENCE", "artifact list is empty or too large");
  }
  const artifacts = value.artifacts.map(parseArtifactReference);
  const artifactKeys = artifacts.map(
    (artifact) => `${artifact.role}:${artifact.sha256}`,
  );
  const sortedArtifactKeys = [...artifactKeys].sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
  if (
    new Set(artifactKeys).size !== artifactKeys.length ||
    artifactKeys.some((key, index) => key !== sortedArtifactKeys[index])
  ) {
    fail(
      "NON_CANONICAL_ARTIFACT_ORDER",
      "artifacts must be unique and sorted by role/hash",
    );
  }

  if (!isRecord(value.claims)) fail("INVALID_CLAIMS", "claims must be an object");
  exactKeys(
    value.claims,
    [
      "noImplicitScope",
      "noMarketplaceMutation",
      "ambiguousNeverReplay",
      "bjsForbidden",
      "clubsRequireSeparateGate",
    ],
    "claims",
  );
  if (
    value.claims.noImplicitScope !== true ||
    value.claims.noMarketplaceMutation !== true ||
    value.claims.ambiguousNeverReplay !== true ||
    value.claims.bjsForbidden !== true ||
    value.claims.clubsRequireSeparateGate !== true
  ) {
    fail("INVALID_CLAIMS", "mandatory fail-closed claims are absent");
  }

  return {
    schemaVersion: PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
    commandId: value.commandId,
    commandKind,
    gateClass,
    engine: {
      releaseId: value.engine.releaseId,
      commitSha: value.engine.commitSha,
      treeSha: value.engine.treeSha,
      executableTreeSha256: value.engine.executableTreeSha256,
    },
    target: {
      environment: value.target.environment as ProductTruthControlEnvironment,
      databaseTargetFingerprint: value.target.databaseTargetFingerprint,
      manifestSha256: value.target.manifestSha256,
    },
    artifacts,
    authority: parseAuthority(value.authority, gateClass),
    claims: {
      noImplicitScope: true,
      noMarketplaceMutation: true,
      ambiguousNeverReplay: true,
      bjsForbidden: true,
      clubsRequireSeparateGate: true,
    },
  };
}

export function canonicalProductTruthControlEnvelope(
  value: unknown,
): string {
  return `${JSON.stringify(parseProductTruthControlEnvelope(value))}\n`;
}

export function parseProductTruthControlEnvelopeBytes(
  bytes: Uint8Array,
): ProductTruthControlEnvelope {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("NON_CANONICAL_BYTES", "command is not valid UTF-8");
  }
  if (text.includes("\r") || text.startsWith("\uFEFF")) {
    fail("NON_CANONICAL_BYTES", "command must use UTF-8/LF without BOM");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("INVALID_JSON", "command JSON cannot be parsed");
  }
  const envelope = parseProductTruthControlEnvelope(parsed);
  if (text !== `${JSON.stringify(envelope)}\n`) {
    fail("NON_CANONICAL_BYTES", "command bytes are not byte-canonical");
  }
  return envelope;
}

export function productTruthControlCommandBytes(value: unknown): Buffer {
  return Buffer.from(canonicalProductTruthControlEnvelope(value), "utf8");
}

export function productTruthControlRequestSha256(value: unknown): string {
  return sha256(productTruthControlCommandBytes(value));
}

export function productTruthControlSigningMessage(value: unknown): Buffer {
  return Buffer.concat([
    SIGNING_DOMAIN,
    productTruthControlCommandBytes(value),
  ]);
}

export function verifyProductTruthControlAuthority(input: {
  envelope: unknown;
  signatureBase64: string;
  trustedKey: ProductTruthControlTrustedKey;
  now?: Date;
}): { signatureSha256: string; commandSha256: string } {
  const envelope = parseProductTruthControlEnvelope(input.envelope);
  if (
    envelope.gateClass !== "DB_WRITE" &&
    envelope.gateClass !== "METERED_EXECUTE"
  ) {
    fail("OWNER_AUTHORITY_NOT_APPLICABLE", "this gate class cannot carry owner authority");
  }
  const authority = envelope.authority;
  const key = input.trustedKey;
  if (
    key.keyFamily !== PRODUCT_TRUTH_CONTROL_KEY_FAMILY ||
    key.algorithm !== PRODUCT_TRUTH_CONTROL_ALGORITHM ||
    key.status !== "ACTIVE" ||
    key.keyId !== authority.ownerKeyId ||
    key.environment !== envelope.target.environment ||
    !isSha256(key.publicKeySpkiSha256) ||
    !canonicalBase64(key.publicKeySpkiDerBase64) ||
    sha256(Buffer.from(key.publicKeySpkiDerBase64, "base64")) !==
      key.publicKeySpkiSha256
  ) {
    fail("UNTRUSTED_OWNER_KEY", "owner key is absent, revoked, or from another domain");
  }
  const issuedAt = Date.parse(authority.issuedAt ?? "");
  const expiresAt = Date.parse(authority.expiresAt ?? "");
  const now = (input.now ?? new Date()).getTime();
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + 5 * 60_000 ||
    now > expiresAt
  ) {
    fail("OWNER_AUTHORITY_EXPIRED", "owner authority is not current");
  }
  if (!canonicalBase64(input.signatureBase64)) {
    fail("INVALID_SIGNATURE", "detached signature is not canonical base64");
  }
  const signature = Buffer.from(input.signatureBase64, "base64");
  if (signature.length !== 64) {
    fail("INVALID_SIGNATURE", "detached Ed25519 signature must contain 64 bytes");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpkiDerBase64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("INVALID_OWNER_KEY", "owner public key cannot be parsed");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("INVALID_OWNER_KEY", "owner public key must be Ed25519");
  }
  if (
    !verifySignature(
      null,
      productTruthControlSigningMessage(envelope),
      publicKey,
      signature,
    )
  ) {
    fail("INVALID_SIGNATURE", "detached owner signature is invalid");
  }
  return {
    signatureSha256: sha256(signature),
    commandSha256: productTruthControlRequestSha256(envelope),
  };
}

const TERMINAL_STATUSES = new Set<ProductTruthControlStatus>([
  "BLOCKED",
  "SUCCEEDED",
  "FAILED",
  "AMBIGUOUS",
  "CANCELLED",
]);

export function assertProductTruthControlTransition(input: {
  from: ProductTruthControlStatus;
  to: ProductTruthControlStatus;
  gateClass?: ProductTruthControlGateClass;
  ownerVerified?: boolean;
  workerLeaseRecorded?: boolean;
  leaseExpired?: boolean;
  executionBoundary?: "NONE" | "RECORDED" | "UNKNOWN";
  attempts?: number;
  durableZeroAttempt?: boolean;
}): void {
  if (
    !PRODUCT_TRUTH_CONTROL_STATUSES.includes(input.from) ||
    !PRODUCT_TRUTH_CONTROL_STATUSES.includes(input.to) ||
    input.from === input.to ||
    TERMINAL_STATUSES.has(input.from)
  ) {
    fail("INVALID_STATE_TRANSITION", "terminal, equal, or unknown transition");
  }
  const ordinary = new Set<string>([
    "DRAFT:VALIDATING",
    "DRAFT:CANCELLED",
    "VALIDATING:BLOCKED",
    "VALIDATING:CANCELLED",
    "AWAITING_OWNER:CANCELLED",
    "ADMITTED:CANCELLED",
    "RUNNING:SUCCEEDED",
    "RUNNING:FAILED",
  ]);
  const transition = `${input.from}:${input.to}`;
  if (ordinary.has(transition)) return;
  if (
    transition === "VALIDATING:ADMITTED" &&
    (input.gateClass === "READ_ONLY" || input.gateClass === "ARTIFACT_PLAN")
  ) {
    return;
  }
  if (
    transition === "VALIDATING:AWAITING_OWNER" &&
    (input.gateClass === "DB_WRITE" || input.gateClass === "METERED_EXECUTE")
  ) {
    return;
  }
  if (
    transition === "AWAITING_OWNER:ADMITTED" &&
    input.ownerVerified === true
  ) {
    return;
  }
  if (
    transition === "ADMITTED:CLAIMED" &&
    input.workerLeaseRecorded === true &&
    input.attempts === 0 &&
    input.executionBoundary === "NONE"
  ) {
    return;
  }
  if (
    transition === "CLAIMED:RUNNING" &&
    input.executionBoundary === "RECORDED" &&
    input.attempts === 1
  ) {
    return;
  }
  if (
    (transition === "CLAIMED:AMBIGUOUS" ||
      transition === "RUNNING:AMBIGUOUS") &&
    input.executionBoundary === "UNKNOWN"
  ) {
    return;
  }
  if (
    transition === "CLAIMED:ADMITTED" &&
    input.leaseExpired === true &&
    input.executionBoundary === "NONE" &&
    input.attempts === 0 &&
    input.durableZeroAttempt === true
  ) {
    return;
  }
  fail("INVALID_STATE_TRANSITION", `${transition} is not safely permitted`);
}

export function sealProductTruthControlArtifact(input: {
  artifactId: string;
  commandId: string;
  role: ProductTruthControlArtifactRole;
  mediaType: string;
  content: Uint8Array;
  createdAt: string;
  createdByPrincipal: string;
}): ProductTruthControlSealedArtifact {
  const content = Buffer.from(input.content);
  if (
    !validToken(input.artifactId) ||
    !validToken(input.commandId) ||
    !PRODUCT_TRUTH_CONTROL_ARTIFACT_ROLES.includes(input.role) ||
    !/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/u.test(
      input.mediaType,
    ) ||
    content.length < 1 ||
    content.length > PRODUCT_TRUTH_CONTROL_MAX_ARTIFACT_BYTES ||
    !canonicalUtc(input.createdAt) ||
    !validToken(input.createdByPrincipal)
  ) {
    fail("INVALID_ARTIFACT", "artifact metadata or bytes are invalid");
  }
  const digest = sha256(content);
  return {
    schemaVersion: PRODUCT_TRUTH_CONTROL_ARTIFACT_SCHEMA,
    artifactId: input.artifactId,
    commandId: input.commandId,
    role: input.role,
    mediaType: input.mediaType,
    content,
    byteSize: content.length,
    sha256: digest,
    locator: `product-truth-control/${input.commandId}/sha256/${digest}`,
    createdAt: input.createdAt,
    createdByPrincipal: input.createdByPrincipal,
  };
}

export function assertProductTruthControlArtifact(
  artifact: ProductTruthControlSealedArtifact,
): void {
  const expected = sealProductTruthControlArtifact({
    artifactId: artifact.artifactId,
    commandId: artifact.commandId,
    role: artifact.role,
    mediaType: artifact.mediaType,
    content: artifact.content,
    createdAt: artifact.createdAt,
    createdByPrincipal: artifact.createdByPrincipal,
  });
  if (
    artifact.schemaVersion !== expected.schemaVersion ||
    artifact.byteSize !== expected.byteSize ||
    artifact.sha256 !== expected.sha256 ||
    artifact.locator !== expected.locator
  ) {
    fail("ARTIFACT_INTEGRITY_MISMATCH", "artifact bytes or seal drifted");
  }
}

export function sealProductTruthControlEvent(input: {
  eventId: string;
  commandId: string;
  sequence: number;
  eventType: ProductTruthControlEventType;
  source: ProductTruthControlSealedEvent["source"];
  occurredAt: string;
  payload: Uint8Array;
  previousEventHash: string;
}): ProductTruthControlSealedEvent {
  const payload = Buffer.from(input.payload);
  if (
    !validToken(input.eventId) ||
    !validToken(input.commandId) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !PRODUCT_TRUTH_CONTROL_EVENT_TYPES.includes(input.eventType) ||
    !["SERVER", "OWNER_VERIFIER", "WORKER"].includes(input.source) ||
    !canonicalUtc(input.occurredAt) ||
    payload.length < 1 ||
    payload.length > PRODUCT_TRUTH_CONTROL_MAX_ARTIFACT_BYTES ||
    !isSha256(input.previousEventHash) ||
    (input.sequence === 1) !==
      (input.previousEventHash === PRODUCT_TRUTH_CONTROL_ZERO_HASH)
  ) {
    fail("INVALID_EVENT", "event metadata, payload, or chain predecessor is invalid");
  }
  const payloadSha256 = sha256(payload);
  const header = Buffer.from(
    JSON.stringify({
      schemaVersion: PRODUCT_TRUTH_CONTROL_EVENT_SCHEMA,
      eventId: input.eventId,
      commandId: input.commandId,
      sequence: input.sequence,
      eventType: input.eventType,
      source: input.source,
      occurredAt: input.occurredAt,
      payloadSha256,
      previousEventHash: input.previousEventHash,
    }),
    "utf8",
  );
  return {
    schemaVersion: PRODUCT_TRUTH_CONTROL_EVENT_SCHEMA,
    eventId: input.eventId,
    commandId: input.commandId,
    sequence: input.sequence,
    eventType: input.eventType,
    source: input.source,
    occurredAt: input.occurredAt,
    payload,
    payloadSha256,
    previousEventHash: input.previousEventHash,
    eventHash: sha256(Buffer.concat([EVENT_DOMAIN, header])),
  };
}

export function assertProductTruthControlEvent(
  event: ProductTruthControlSealedEvent,
): void {
  const expected = sealProductTruthControlEvent({
    eventId: event.eventId,
    commandId: event.commandId,
    sequence: event.sequence,
    eventType: event.eventType,
    source: event.source,
    occurredAt: event.occurredAt,
    payload: event.payload,
    previousEventHash: event.previousEventHash,
  });
  if (
    event.schemaVersion !== expected.schemaVersion ||
    event.payloadSha256 !== expected.payloadSha256 ||
    event.eventHash !== expected.eventHash
  ) {
    fail("EVENT_INTEGRITY_MISMATCH", "event payload or chain seal drifted");
  }
}

export function productTruthControlRuntimeStatus(): {
  mode: typeof PRODUCT_TRUTH_CONTROL_RUNTIME_MODE;
  databaseReads: false;
  databaseWrites: false;
  workerClaim: false;
  processSpawn: false;
  networkCalls: false;
} {
  return {
    mode: PRODUCT_TRUTH_CONTROL_RUNTIME_MODE,
    databaseReads: false,
    databaseWrites: false,
    workerClaim: false,
    processSpawn: false,
    networkCalls: false,
  };
}

export function assertProductTruthControlRuntimeEnabled(): never {
  fail(
    "PRODUCT_TRUTH_CONTROL_RUNTIME_OFF",
    "Stage A has no admission, worker, process, network, or database runtime",
  );
}
