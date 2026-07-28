import { createHash } from "node:crypto";

export const CHANNELMAX_AGENT_OPERATIONS = [
  "SNAPSHOT_INVENTORY",
  "DISCOVER_MANUAL_MODEL",
  "UPLOAD_MANUAL_ASSIGNMENT",
  "VERIFY_UPLOAD_TASK",
  "EXPORT_INVENTORY",
  "OBSERVE_POST_UPLOAD_HOLD",
  "RECONCILE_MUTATION",
] as const;

export type ChannelMaxAgentOperation =
  (typeof CHANNELMAX_AGENT_OPERATIONS)[number];

export const CHANNELMAX_MUTATION_OPERATIONS = [
  "UPLOAD_MANUAL_ASSIGNMENT",
] as const satisfies readonly ChannelMaxAgentOperation[];

export const CHANNELMAX_READ_ONLY_OPERATIONS = [
  "SNAPSHOT_INVENTORY",
  "DISCOVER_MANUAL_MODEL",
  "VERIFY_UPLOAD_TASK",
  "EXPORT_INVENTORY",
  "OBSERVE_POST_UPLOAD_HOLD",
  "RECONCILE_MUTATION",
] as const satisfies readonly ChannelMaxAgentOperation[];

export const CHANNELMAX_AGENT_EVENT_TYPES = [
  "PROGRESS",
  "AUTH_REQUIRED",
  "EVIDENCE_CAPTURED",
  "MUTATION_STARTED",
  "MUTATION_CONFIRMED",
  "MUTATION_NOT_APPLIED",
  "MUTATION_AMBIGUOUS",
] as const;

export type ChannelMaxAgentEventType =
  (typeof CHANNELMAX_AGENT_EVENT_TYPES)[number];

export const CHANNELMAX_EVIDENCE_KINDS = [
  "SCREENSHOT",
  "DOM_SNAPSHOT",
  "DOWNLOAD",
  "UPLOAD_SOURCE",
  "INVENTORY_EXPORT",
  "RUN_LOG",
] as const;

export type ChannelMaxEvidenceKind =
  (typeof CHANNELMAX_EVIDENCE_KINDS)[number];

export type ChannelMaxMutationOutcome =
  | "CONFIRMED_APPLIED"
  | "CONFIRMED_NOT_APPLIED"
  | "AMBIGUOUS";

export type ChannelMaxCompletionStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "AMBIGUOUS";

export const CHANNELMAX_OWNER_APPROVAL_SCHEMA =
  "channelmax-owner-approval/v1" as const;

export interface ChannelMaxArtifactRef {
  download_url: string;
  sha256: string;
  byte_size: number;
  media_type: string;
}

interface ChannelMaxPayloadBase {
  account_id: string;
  expected_active_rows: number;
}

export interface ChannelMaxSnapshotPayload extends ChannelMaxPayloadBase {
  include_inactive: boolean;
}

export type ChannelMaxDiscoverManualModelPayload = ChannelMaxPayloadBase;

export interface ChannelMaxUploadManualAssignmentPayload
  extends ChannelMaxPayloadBase {
  assignment_artifact: ChannelMaxArtifactRef;
  manual_model_id: string;
  manual_model_name: string;
  selling_venue: "AmazonUS";
  required_skip_rules: ["44a", "44b"];
}

export interface ChannelMaxVerifyUploadTaskPayload
  extends ChannelMaxPayloadBase {
  upload_task_id: string;
  expected_assignment_sha256: string;
}

export interface ChannelMaxExportInventoryPayload
  extends ChannelMaxPayloadBase {
  purpose: "POST_UPLOAD_EVIDENCE";
}

export interface ChannelMaxObservePostUploadPayload
  extends ChannelMaxPayloadBase {
  upload_task_id: string;
  not_before: string;
  expected_assignment_sha256: string;
}

export interface ChannelMaxReconcileMutationPayload
  extends ChannelMaxPayloadBase {
  ambiguous_job_id: string;
  assignment_sha256: string;
  manual_model_id: string;
  manual_model_name: string;
  strategy: "UPLOAD_TASK_HISTORY_AND_INVENTORY_EXPORT";
}

export type ChannelMaxOperationPayload =
  | ChannelMaxSnapshotPayload
  | ChannelMaxDiscoverManualModelPayload
  | ChannelMaxUploadManualAssignmentPayload
  | ChannelMaxVerifyUploadTaskPayload
  | ChannelMaxExportInventoryPayload
  | ChannelMaxObservePostUploadPayload
  | ChannelMaxReconcileMutationPayload;

export interface CreateChannelMaxAgentJobInput {
  operation: ChannelMaxAgentOperation;
  idempotency_key: string;
  priority: number;
  max_attempts: number;
  payload: ChannelMaxOperationPayload;
}

export interface ApproveChannelMaxAgentJobInput {
  schema_version: typeof CHANNELMAX_OWNER_APPROVAL_SCHEMA;
  job_id: string;
  operation: "UPLOAD_MANUAL_ASSIGNMENT";
  account_id: string;
  manual_model_id: string;
  manual_model_name: string;
  expected_active_rows: number;
  assignment_sha256: string;
  payload_sha256: string;
  request_sha256: string;
  mutation_plan_sha256: string;
  expires_at: string;
  nonce: string;
  step_up_assertion_id: string;
}

export interface CancelChannelMaxAgentJobInput {
  cancellation_key: string;
  reason: string;
}

export interface CreateChannelMaxReconciliationInput {
  idempotency_key: string;
  priority: number;
  max_attempts: number;
}

export interface ChannelMaxPasswordStepUpInput {
  password: string;
}

export interface ClaimChannelMaxAgentJobInput {
  worker_id: string;
  supported_operations: ChannelMaxAgentOperation[];
  lease_seconds: number;
}

export interface ChannelMaxEvidenceRef {
  kind: ChannelMaxEvidenceKind;
  sha256: string;
  byte_size: number;
  media_type: string;
  captured_at: string;
  uri?: string;
}

export interface ChannelMaxManagedEvidenceUploadInput {
  lease_token: string;
  kind: ChannelMaxEvidenceKind;
  media_type: string;
  captured_at: string;
}

export interface ChannelMaxWorkerEventInput {
  event_key: string;
  lease_token: string;
  type: ChannelMaxAgentEventType;
  occurred_at: string;
  message?: string;
  step?: string;
  progress_percent?: number;
  evidence: ChannelMaxEvidenceRef[];
}

export interface ChannelMaxHeartbeatInput {
  lease_token: string;
  phase: string;
  progress_percent?: number;
}

export interface CompleteChannelMaxAgentJobInput {
  completion_key: string;
  lease_token: string;
  status: ChannelMaxCompletionStatus;
  mutation_outcome?: ChannelMaxMutationOutcome;
  message: string;
  result: Record<string, unknown>;
  evidence: ChannelMaxEvidenceRef[];
}

export interface TerminalDecision {
  status: ChannelMaxCompletionStatus;
  mutationOutcome: ChannelMaxMutationOutcome | null;
}

export type ExpiredLeaseDecision = "REQUEUE" | "FAILED" | "AMBIGUOUS";

export class ChannelMaxContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelMaxContractError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelMaxContractError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extras.length > 0) {
    throw new ChannelMaxContractError(
      `${label} has unsupported field(s): ${extras.join(", ")}.`,
    );
  }
}

function stringValue(
  value: unknown,
  label: string,
  options: { max?: number; pattern?: RegExp } = {},
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChannelMaxContractError(`${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (/\p{Cc}/u.test(trimmed)) {
    throw new ChannelMaxContractError(`${label} contains control characters.`);
  }
  if (trimmed.length > (options.max ?? 512)) {
    throw new ChannelMaxContractError(`${label} is too long.`);
  }
  if (options.pattern && !options.pattern.test(trimmed)) {
    throw new ChannelMaxContractError(`${label} has an invalid format.`);
  }
  return trimmed;
}

function integerValue(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ChannelMaxContractError(
      `${label} must be an integer between ${min} and ${max}.`,
    );
  }
  return value as number;
}

function sha256Value(value: unknown, label: string): string {
  return stringValue(value, label, {
    max: 64,
    pattern: /^[a-f0-9]{64}$/,
  });
}

function canonicalInstant(value: unknown, label: string): string {
  const text = stringValue(value, label, { max: 32 });
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new ChannelMaxContractError(
      `${label} must be a canonical ISO-8601 UTC timestamp.`,
    );
  }
  return text;
}

function accountId(value: unknown): string {
  return stringValue(value, "payload.account_id", {
    max: 128,
    pattern: /^[A-Za-z0-9@._:+-]+$/,
  });
}

function httpsUrl(value: unknown, label: string): string {
  const text = stringValue(value, label, { max: 2048 });
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ChannelMaxContractError(`${label} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ChannelMaxContractError(
      `${label} must be HTTPS and must not embed credentials.`,
    );
  }
  return parsed.toString();
}

function mediaType(value: unknown, label: string): string {
  return stringValue(value, label, {
    max: 128,
    pattern: /^[A-Za-z0-9!#$&^_.+/-]+$/,
  });
}

function parseArtifact(value: unknown): ChannelMaxArtifactRef {
  const raw = record(value, "payload.assignment_artifact");
  exactKeys(
    raw,
    ["download_url", "sha256", "byte_size", "media_type"],
    "payload.assignment_artifact",
  );
  const artifact: ChannelMaxArtifactRef = {
    download_url: httpsUrl(
      raw.download_url,
      "payload.assignment_artifact.download_url",
    ),
    sha256: sha256Value(
      raw.sha256,
      "payload.assignment_artifact.sha256",
    ),
    byte_size: integerValue(
      raw.byte_size,
      "payload.assignment_artifact.byte_size",
      1,
      10_000_000,
    ),
    media_type: mediaType(
      raw.media_type,
      "payload.assignment_artifact.media_type",
    ),
  };
  if (!/^(text\/(tab-separated-values|plain)|application\/octet-stream)$/i.test(artifact.media_type)) {
    throw new ChannelMaxContractError(
      "ChannelMAX assignment artifact must be TSV/plain text.",
    );
  }
  return artifact;
}

function basePayload(
  raw: Record<string, unknown>,
): ChannelMaxPayloadBase {
  return {
    account_id: accountId(raw.account_id),
    expected_active_rows: integerValue(
      raw.expected_active_rows,
      "payload.expected_active_rows",
      1,
      10_000,
    ),
  };
}

function parseOperation(value: unknown): ChannelMaxAgentOperation {
  if (
    typeof value !== "string" ||
    !(CHANNELMAX_AGENT_OPERATIONS as readonly string[]).includes(value)
  ) {
    throw new ChannelMaxContractError(
      `operation must be one of: ${CHANNELMAX_AGENT_OPERATIONS.join(", ")}.`,
    );
  }
  return value as ChannelMaxAgentOperation;
}

function parsePayload(
  operation: ChannelMaxAgentOperation,
  value: unknown,
): ChannelMaxOperationPayload {
  const raw = record(value, "payload");
  const baseKeys = ["account_id", "expected_active_rows"];
  const base = basePayload(raw);

  switch (operation) {
    case "SNAPSHOT_INVENTORY":
      exactKeys(raw, [...baseKeys, "include_inactive"], "payload");
      if (typeof raw.include_inactive !== "boolean") {
        throw new ChannelMaxContractError(
          "payload.include_inactive must be boolean.",
        );
      }
      return { ...base, include_inactive: raw.include_inactive };
    case "DISCOVER_MANUAL_MODEL":
      exactKeys(raw, baseKeys, "payload");
      return base;
    case "UPLOAD_MANUAL_ASSIGNMENT": {
      exactKeys(
        raw,
        [
          ...baseKeys,
          "assignment_artifact",
          "manual_model_id",
          "manual_model_name",
          "selling_venue",
          "required_skip_rules",
        ],
        "payload",
      );
      if (raw.selling_venue !== "AmazonUS") {
        throw new ChannelMaxContractError(
          "payload.selling_venue must be AmazonUS.",
        );
      }
      if (
        !Array.isArray(raw.required_skip_rules) ||
        raw.required_skip_rules.length !== 2 ||
        raw.required_skip_rules[0] !== "44a" ||
        raw.required_skip_rules[1] !== "44b"
      ) {
        throw new ChannelMaxContractError(
          "payload.required_skip_rules must be exactly [\"44a\",\"44b\"].",
        );
      }
      return {
        ...base,
        assignment_artifact: parseArtifact(raw.assignment_artifact),
        manual_model_id: stringValue(
          raw.manual_model_id,
          "payload.manual_model_id",
          { max: 32, pattern: /^\d+$/ },
        ),
        manual_model_name: stringValue(
          raw.manual_model_name,
          "payload.manual_model_name",
          { max: 128 },
        ),
        selling_venue: "AmazonUS",
        required_skip_rules: ["44a", "44b"],
      };
    }
    case "VERIFY_UPLOAD_TASK":
      exactKeys(
        raw,
        [...baseKeys, "upload_task_id", "expected_assignment_sha256"],
        "payload",
      );
      return {
        ...base,
        upload_task_id: stringValue(
          raw.upload_task_id,
          "payload.upload_task_id",
          { max: 128, pattern: /^[A-Za-z0-9._:-]+$/ },
        ),
        expected_assignment_sha256: sha256Value(
          raw.expected_assignment_sha256,
          "payload.expected_assignment_sha256",
        ),
      };
    case "EXPORT_INVENTORY":
      exactKeys(raw, [...baseKeys, "purpose"], "payload");
      if (raw.purpose !== "POST_UPLOAD_EVIDENCE") {
        throw new ChannelMaxContractError(
          "payload.purpose must be POST_UPLOAD_EVIDENCE.",
        );
      }
      return { ...base, purpose: "POST_UPLOAD_EVIDENCE" };
    case "OBSERVE_POST_UPLOAD_HOLD":
      exactKeys(
        raw,
        [
          ...baseKeys,
          "upload_task_id",
          "not_before",
          "expected_assignment_sha256",
        ],
        "payload",
      );
      return {
        ...base,
        upload_task_id: stringValue(
          raw.upload_task_id,
          "payload.upload_task_id",
          { max: 128, pattern: /^[A-Za-z0-9._:-]+$/ },
        ),
        not_before: canonicalInstant(raw.not_before, "payload.not_before"),
        expected_assignment_sha256: sha256Value(
          raw.expected_assignment_sha256,
          "payload.expected_assignment_sha256",
        ),
      };
    case "RECONCILE_MUTATION":
      exactKeys(
        raw,
        [
          ...baseKeys,
          "ambiguous_job_id",
          "assignment_sha256",
          "manual_model_id",
          "manual_model_name",
          "strategy",
        ],
        "payload",
      );
      if (raw.strategy !== "UPLOAD_TASK_HISTORY_AND_INVENTORY_EXPORT") {
        throw new ChannelMaxContractError(
          "payload.strategy must be UPLOAD_TASK_HISTORY_AND_INVENTORY_EXPORT.",
        );
      }
      return {
        ...base,
        ambiguous_job_id: stringValue(
          raw.ambiguous_job_id,
          "payload.ambiguous_job_id",
          { max: 128, pattern: /^[A-Za-z0-9._:-]+$/ },
        ),
        assignment_sha256: sha256Value(
          raw.assignment_sha256,
          "payload.assignment_sha256",
        ),
        manual_model_id: stringValue(
          raw.manual_model_id,
          "payload.manual_model_id",
          { max: 32, pattern: /^\d+$/ },
        ),
        manual_model_name: stringValue(
          raw.manual_model_name,
          "payload.manual_model_name",
          { max: 128 },
        ),
        strategy: "UPLOAD_TASK_HISTORY_AND_INVENTORY_EXPORT",
      };
  }
}

export function isMutationOperation(
  operation: ChannelMaxAgentOperation,
): boolean {
  return (CHANNELMAX_MUTATION_OPERATIONS as readonly string[]).includes(
    operation,
  );
}

export function parseCreateChannelMaxAgentJob(
  value: unknown,
): CreateChannelMaxAgentJobInput {
  const raw = record(value, "request");
  exactKeys(
    raw,
    [
      "operation",
      "idempotency_key",
      "priority",
      "max_attempts",
      "payload",
    ],
    "request",
  );
  const operation = parseOperation(raw.operation);
  const payload = parsePayload(operation, raw.payload);
  return {
    operation,
    idempotency_key: stringValue(
      raw.idempotency_key,
      "idempotency_key",
      { max: 128, pattern: /^[A-Za-z0-9._:-]{8,128}$/ },
    ),
    priority:
      raw.priority === undefined
        ? 0
        : integerValue(raw.priority, "priority", -100, 100),
    max_attempts:
      raw.max_attempts === undefined
        ? 3
        : integerValue(raw.max_attempts, "max_attempts", 1, 5),
    payload,
  };
}

export function parseApproveChannelMaxAgentJob(
  value: unknown,
  now = new Date(),
): ApproveChannelMaxAgentJobInput {
  const raw = record(value, "request");
  exactKeys(
    raw,
    [
      "schema_version",
      "job_id",
      "operation",
      "account_id",
      "manual_model_id",
      "manual_model_name",
      "expected_active_rows",
      "assignment_sha256",
      "payload_sha256",
      "request_sha256",
      "mutation_plan_sha256",
      "expires_at",
      "nonce",
      "step_up_assertion_id",
    ],
    "request",
  );
  if (raw.schema_version !== CHANNELMAX_OWNER_APPROVAL_SCHEMA) {
    throw new ChannelMaxContractError(
      `schema_version must be ${CHANNELMAX_OWNER_APPROVAL_SCHEMA}.`,
    );
  }
  if (raw.operation !== "UPLOAD_MANUAL_ASSIGNMENT") {
    throw new ChannelMaxContractError(
      "Only UPLOAD_MANUAL_ASSIGNMENT currently supports owner approval.",
    );
  }
  const expiresAt = canonicalInstant(raw.expires_at, "expires_at");
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= now.getTime()) {
    throw new ChannelMaxContractError("Owner approval must not already be expired.");
  }
  if (expiresMs > now.getTime() + 2 * 60 * 60_000) {
    throw new ChannelMaxContractError(
      "Owner approval lifetime cannot exceed two hours.",
    );
  }
  return {
    schema_version: CHANNELMAX_OWNER_APPROVAL_SCHEMA,
    job_id: stringValue(raw.job_id, "job_id", {
      max: 128,
      pattern: /^[A-Za-z0-9._:-]+$/,
    }),
    operation: "UPLOAD_MANUAL_ASSIGNMENT",
    account_id: accountId(raw.account_id),
    manual_model_id: stringValue(raw.manual_model_id, "manual_model_id", {
      max: 32,
      pattern: /^\d+$/,
    }),
    manual_model_name: stringValue(
      raw.manual_model_name,
      "manual_model_name",
      { max: 128 },
    ),
    expected_active_rows: integerValue(
      raw.expected_active_rows,
      "expected_active_rows",
      1,
      10_000,
    ),
    assignment_sha256: sha256Value(
      raw.assignment_sha256,
      "assignment_sha256",
    ),
    payload_sha256: sha256Value(raw.payload_sha256, "payload_sha256"),
    request_sha256: sha256Value(raw.request_sha256, "request_sha256"),
    mutation_plan_sha256: sha256Value(
      raw.mutation_plan_sha256,
      "mutation_plan_sha256",
    ),
    expires_at: expiresAt,
    nonce: stringValue(raw.nonce, "nonce", {
      max: 128,
      pattern: /^[A-Za-z0-9._:-]{16,128}$/,
    }),
    step_up_assertion_id: stringValue(
      raw.step_up_assertion_id,
      "step_up_assertion_id",
      { max: 128, pattern: /^[A-Za-z0-9._:-]{8,128}$/ },
    ),
  };
}

export function parseCancelChannelMaxAgentJob(
  value: unknown,
): CancelChannelMaxAgentJobInput {
  const raw = record(value, "request");
  exactKeys(raw, ["cancellation_key", "reason"], "request");
  return {
    cancellation_key: stringValue(
      raw.cancellation_key,
      "cancellation_key",
      { max: 128, pattern: /^[A-Za-z0-9._:-]{8,128}$/ },
    ),
    reason: stringValue(raw.reason, "reason", { max: 2_000 }),
  };
}

export function parseCreateChannelMaxReconciliation(
  value: unknown,
): CreateChannelMaxReconciliationInput {
  const raw = record(value, "request");
  exactKeys(
    raw,
    ["idempotency_key", "priority", "max_attempts"],
    "request",
  );
  return {
    idempotency_key: stringValue(
      raw.idempotency_key,
      "idempotency_key",
      { max: 128, pattern: /^[A-Za-z0-9._:-]{8,128}$/ },
    ),
    priority:
      raw.priority === undefined
        ? 100
        : integerValue(raw.priority, "priority", -100, 100),
    max_attempts:
      raw.max_attempts === undefined
        ? 3
        : integerValue(raw.max_attempts, "max_attempts", 1, 5),
  };
}

export function parseChannelMaxPasswordStepUp(
  value: unknown,
): ChannelMaxPasswordStepUpInput {
  const raw = record(value, "request");
  exactKeys(raw, ["password"], "request");
  if (
    typeof raw.password !== "string" ||
    raw.password.length < 1 ||
    raw.password.length > 1_024 ||
    raw.password.includes("\0")
  ) {
    throw new ChannelMaxContractError(
      "password must be a non-empty string of at most 1024 characters.",
    );
  }
  return { password: raw.password };
}

export function parseClaimChannelMaxAgentJob(
  value: unknown,
): ClaimChannelMaxAgentJobInput {
  const raw = record(value, "request");
  exactKeys(
    raw,
    ["worker_id", "supported_operations", "lease_seconds"],
    "request",
  );
  // Claiming mutations must always be an explicit worker capability. A worker
  // that omits supported_operations receives read-only work only.
  let supported: ChannelMaxAgentOperation[] = [
    ...CHANNELMAX_READ_ONLY_OPERATIONS,
  ];
  if (raw.supported_operations !== undefined) {
    if (
      !Array.isArray(raw.supported_operations) ||
      raw.supported_operations.length === 0
    ) {
      throw new ChannelMaxContractError(
        "supported_operations must be a non-empty array.",
      );
    }
    supported = raw.supported_operations.map(parseOperation);
    if (new Set(supported).size !== supported.length) {
      throw new ChannelMaxContractError(
        "supported_operations contains duplicates.",
      );
    }
  }
  return {
    worker_id: stringValue(raw.worker_id, "worker_id", {
      max: 128,
      pattern: /^[A-Za-z0-9._:-]+$/,
    }),
    supported_operations: supported,
    lease_seconds:
      raw.lease_seconds === undefined
        ? 120
        : integerValue(raw.lease_seconds, "lease_seconds", 30, 300),
  };
}

function parseEvidenceRef(
  value: unknown,
  index: number,
): ChannelMaxEvidenceRef {
  const label = `evidence[${index}]`;
  const raw = record(value, label);
  exactKeys(
    raw,
    ["kind", "sha256", "byte_size", "media_type", "captured_at", "uri"],
    label,
  );
  if (
    typeof raw.kind !== "string" ||
    !(CHANNELMAX_EVIDENCE_KINDS as readonly string[]).includes(raw.kind)
  ) {
    throw new ChannelMaxContractError(
      `${label}.kind must be one of: ${CHANNELMAX_EVIDENCE_KINDS.join(", ")}.`,
    );
  }
  const evidence: ChannelMaxEvidenceRef = {
    kind: raw.kind as ChannelMaxEvidenceKind,
    sha256: sha256Value(raw.sha256, `${label}.sha256`),
    byte_size: integerValue(
      raw.byte_size,
      `${label}.byte_size`,
      1,
      100_000_000,
    ),
    media_type: mediaType(raw.media_type, `${label}.media_type`),
    captured_at: canonicalInstant(raw.captured_at, `${label}.captured_at`),
  };
  if (raw.uri !== undefined) evidence.uri = httpsUrl(raw.uri, `${label}.uri`);
  return evidence;
}

function evidenceList(value: unknown): ChannelMaxEvidenceRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 25) {
    throw new ChannelMaxContractError(
      "evidence must be an array with at most 25 entries.",
    );
  }
  const parsed = value.map(parseEvidenceRef);
  if (new Set(parsed.map((item) => item.sha256)).size !== parsed.length) {
    throw new ChannelMaxContractError(
      "evidence contains duplicate SHA-256 references.",
    );
  }
  return parsed;
}

function leaseToken(value: unknown): string {
  return stringValue(value, "lease_token", {
    max: 64,
    pattern: /^[a-f0-9]{64}$/,
  });
}

export function parseChannelMaxManagedEvidenceUpload(
  value: unknown,
  now = new Date(),
): ChannelMaxManagedEvidenceUploadInput {
  const raw = record(value, "managed evidence metadata");
  exactKeys(
    raw,
    ["lease_token", "kind", "media_type", "captured_at"],
    "managed evidence metadata",
  );
  if (
    typeof raw.kind !== "string" ||
    !(CHANNELMAX_EVIDENCE_KINDS as readonly string[]).includes(raw.kind)
  ) {
    throw new ChannelMaxContractError(
      `kind must be one of: ${CHANNELMAX_EVIDENCE_KINDS.join(", ")}.`,
    );
  }
  const capturedAt = canonicalInstant(raw.captured_at, "captured_at");
  if (Math.abs(Date.parse(capturedAt) - now.getTime()) > 15 * 60_000) {
    throw new ChannelMaxContractError(
      "captured_at must be within 15 minutes of the managed upload.",
    );
  }
  return {
    lease_token: leaseToken(raw.lease_token),
    kind: raw.kind as ChannelMaxEvidenceKind,
    media_type: mediaType(raw.media_type, "media_type").toLowerCase(),
    captured_at: capturedAt,
  };
}

export function parseChannelMaxWorkerEvent(
  value: unknown,
  now = new Date(),
): ChannelMaxWorkerEventInput {
  const raw = record(value, "request");
  exactKeys(
    raw,
    [
      "event_key",
      "lease_token",
      "type",
      "occurred_at",
      "message",
      "step",
      "progress_percent",
      "evidence",
    ],
    "request",
  );
  if (
    typeof raw.type !== "string" ||
    !(CHANNELMAX_AGENT_EVENT_TYPES as readonly string[]).includes(raw.type)
  ) {
    throw new ChannelMaxContractError(
      `type must be one of: ${CHANNELMAX_AGENT_EVENT_TYPES.join(", ")}.`,
    );
  }
  const occurredAt =
    raw.occurred_at === undefined
      ? now.toISOString()
      : canonicalInstant(raw.occurred_at, "occurred_at");
  if (Math.abs(Date.parse(occurredAt) - now.getTime()) > 15 * 60_000) {
    throw new ChannelMaxContractError(
      "occurred_at must be within 15 minutes of server time.",
    );
  }
  const evidence = evidenceList(raw.evidence);
  const mutationEvent = raw.type.startsWith("MUTATION_");
  if (mutationEvent && evidence.some((item) => !item.uri)) {
    throw new ChannelMaxContractError(
      `${raw.type} evidence requires immutable HTTPS uri references.`,
    );
  }
  if (
    mutationEvent &&
    evidence.some((item) => {
      const delta = Date.parse(item.captured_at) - Date.parse(occurredAt);
      return delta > 60_000 || delta < -15 * 60_000;
    })
  ) {
    throw new ChannelMaxContractError(
      `${raw.type} evidence captured_at must be between 15 minutes before and 1 minute after occurred_at.`,
    );
  }
  if (raw.type === "EVIDENCE_CAPTURED" && evidence.length === 0) {
    throw new ChannelMaxContractError(
      "EVIDENCE_CAPTURED requires at least one evidence reference.",
    );
  }
  if (
    (raw.type === "MUTATION_STARTED" ||
      raw.type === "MUTATION_CONFIRMED" ||
      raw.type === "MUTATION_NOT_APPLIED" ||
      raw.type === "MUTATION_AMBIGUOUS") &&
    evidence.length === 0
  ) {
    throw new ChannelMaxContractError(
      `${raw.type} requires at least one immutable evidence reference.`,
    );
  }
  if (
    (raw.type === "MUTATION_CONFIRMED" ||
      raw.type === "MUTATION_NOT_APPLIED" ||
      raw.type === "MUTATION_AMBIGUOUS") &&
    !evidence.some(
      (item) => item.kind === "SCREENSHOT" || item.kind === "DOM_SNAPSHOT",
    )
  ) {
    throw new ChannelMaxContractError(
      `${raw.type} requires SCREENSHOT or DOM_SNAPSHOT evidence.`,
    );
  }
  return {
    event_key: stringValue(raw.event_key, "event_key", {
      max: 128,
      pattern: /^[A-Za-z0-9._:-]{8,128}$/,
    }),
    lease_token: leaseToken(raw.lease_token),
    type: raw.type as ChannelMaxAgentEventType,
    occurred_at: occurredAt,
    ...(raw.message !== undefined
      ? { message: stringValue(raw.message, "message", { max: 2_000 }) }
      : {}),
    ...(raw.step !== undefined
      ? {
          step: stringValue(raw.step, "step", {
            max: 128,
            pattern: /^[A-Za-z0-9._:-]+$/,
          }),
        }
      : {}),
    ...(raw.progress_percent !== undefined
      ? {
          progress_percent: integerValue(
            raw.progress_percent,
            "progress_percent",
            0,
            100,
          ),
        }
      : {}),
    evidence,
  };
}

export function parseChannelMaxHeartbeat(
  value: unknown,
): ChannelMaxHeartbeatInput {
  const raw = record(value, "request");
  exactKeys(raw, ["lease_token", "phase", "progress_percent"], "request");
  return {
    lease_token: leaseToken(raw.lease_token),
    phase: stringValue(raw.phase, "phase", {
      max: 128,
      pattern: /^[A-Za-z0-9._:-]+$/,
    }),
    ...(raw.progress_percent !== undefined
      ? {
          progress_percent: integerValue(
            raw.progress_percent,
            "progress_percent",
            0,
            100,
          ),
        }
      : {}),
  };
}

function jsonResult(value: unknown): Record<string, unknown> {
  const parsed = value === undefined ? {} : record(value, "result");
  const serialized = stableJson(parsed);
  if (Buffer.byteLength(serialized, "utf8") > 1_000_000) {
    throw new ChannelMaxContractError("result exceeds the 1 MB limit.");
  }
  return parsed;
}

export function parseCompleteChannelMaxAgentJob(
  value: unknown,
): CompleteChannelMaxAgentJobInput {
  const raw = record(value, "request");
  exactKeys(
    raw,
    [
      "completion_key",
      "lease_token",
      "status",
      "mutation_outcome",
      "message",
      "result",
      "evidence",
    ],
    "request",
  );
  if (
    raw.status !== "SUCCEEDED" &&
    raw.status !== "FAILED" &&
    raw.status !== "AMBIGUOUS"
  ) {
    throw new ChannelMaxContractError(
      "status must be SUCCEEDED, FAILED, or AMBIGUOUS.",
    );
  }
  if (
    raw.mutation_outcome !== undefined &&
    raw.mutation_outcome !== "CONFIRMED_APPLIED" &&
    raw.mutation_outcome !== "CONFIRMED_NOT_APPLIED" &&
    raw.mutation_outcome !== "AMBIGUOUS"
  ) {
    throw new ChannelMaxContractError(
      "mutation_outcome is invalid.",
    );
  }
  return {
    completion_key: stringValue(raw.completion_key, "completion_key", {
      max: 128,
      pattern: /^[A-Za-z0-9._:-]{8,128}$/,
    }),
    lease_token: leaseToken(raw.lease_token),
    status: raw.status,
    ...(raw.mutation_outcome !== undefined
      ? { mutation_outcome: raw.mutation_outcome }
      : {}),
    message: stringValue(raw.message, "message", { max: 4_000 }),
    result: jsonResult(raw.result),
    evidence: evidenceList(raw.evidence),
  };
}

export function deriveTerminalDecision(input: {
  mutation: boolean;
  mutationStarted: boolean;
  operation: ChannelMaxAgentOperation;
  completion: CompleteChannelMaxAgentJobInput;
}): TerminalDecision {
  const { mutation, mutationStarted, operation, completion } = input;
  if (!mutation) {
    if (completion.mutation_outcome !== undefined) {
      throw new ChannelMaxContractError(
        "Read-only jobs must not report mutation_outcome.",
      );
    }
    if (completion.status === "AMBIGUOUS") {
      throw new ChannelMaxContractError(
        "Read-only jobs cannot finish as AMBIGUOUS.",
      );
    }
    return { status: completion.status, mutationOutcome: null };
  }

  const expected: Record<ChannelMaxCompletionStatus, ChannelMaxMutationOutcome> = {
    SUCCEEDED: "CONFIRMED_APPLIED",
    FAILED: "CONFIRMED_NOT_APPLIED",
    AMBIGUOUS: "AMBIGUOUS",
  };
  if (completion.mutation_outcome !== expected[completion.status]) {
    throw new ChannelMaxContractError(
      `${completion.status} mutation completion requires mutation_outcome=${expected[completion.status]}.`,
    );
  }
  if (completion.status === "SUCCEEDED" && !mutationStarted) {
    throw new ChannelMaxContractError(
      "A mutation cannot succeed without an acknowledged MUTATION_STARTED fence.",
    );
  }
  if (completion.evidence.length === 0) {
    throw new ChannelMaxContractError(
      "Every mutation completion requires immutable evidence metadata.",
    );
  }
  if (operation === "UPLOAD_MANUAL_ASSIGNMENT" && completion.status === "SUCCEEDED") {
    if (
      typeof completion.result.upload_task_id !== "string" ||
      !completion.result.upload_task_id.trim() ||
      completion.result.upload_status !== "COMPLETED"
    ) {
      throw new ChannelMaxContractError(
        "Successful upload requires result.upload_task_id and upload_status=COMPLETED.",
      );
    }
  }
  return {
    status: completion.status,
    mutationOutcome: completion.mutation_outcome,
  };
}

export function classifyExpiredChannelMaxLease(input: {
  mutation: boolean;
  mutationStarted: boolean;
  attempts: number;
  maxAttempts: number;
}): ExpiredLeaseDecision {
  if (input.mutation && input.mutationStarted) return "AMBIGUOUS";
  return input.attempts < input.maxAttempts ? "REQUEUE" : "FAILED";
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ChannelMaxContractError("JSON contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const raw = value as Record<string, unknown>;
  return `{${Object.keys(raw)
    .sort()
    .filter((key) => raw[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(raw[key])}`)
    .join(",")}}`;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
