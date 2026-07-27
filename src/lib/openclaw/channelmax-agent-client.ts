import { createHash, randomUUID } from "node:crypto";

export const OPENCLAW_CHANNELMAX_TASK_SCHEMA =
  "ss-openclaw-channelmax-task/v1" as const;
export const OPENCLAW_CHANNELMAX_RESULT_SCHEMA =
  "ss-openclaw-channelmax-client-result/v1" as const;
export const DEFAULT_OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
export const DEFAULT_OPENCLAW_CHANNELMAX_AGENT_ID = "channelmax";
export const DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY =
  "codex-channelmax-control-v1";
export const DEFAULT_OPENCLAW_CHANNELMAX_TIMEOUT_MS = 600_000;

export type ChannelMaxAgentAction = "audit" | "prepare" | "commit" | "status";
export type ChannelMaxAgentMode = "READ_ONLY" | "COMMIT_EXACT_PLAN";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ChannelMaxTaskEnvelope {
  schema: typeof OPENCLAW_CHANNELMAX_TASK_SCHEMA;
  job_id: string;
  idempotency_key: string;
  action: ChannelMaxAgentAction;
  requested_at: string;
  mode: ChannelMaxAgentMode;
  mutation_authorized: boolean;
  request: JsonObject;
  authorization:
    | null
    | {
        plan_sha256: string;
        approval_token_sha256: string;
        one_time_approval: true;
      };
  constraints: {
    system: "CHANNELMAX";
    read_only: boolean;
    no_blind_retry: true;
    require_before_after_evidence: true;
    require_exact_plan_hash_for_mutation: true;
    stop_for_login_2fa_or_captcha: true;
  };
}

export interface OpenClawSseEvent {
  event: string;
  data: unknown;
  id?: string;
}

export interface ChannelMaxAgentResult {
  schema: typeof OPENCLAW_CHANNELMAX_RESULT_SCHEMA;
  job_id: string;
  idempotency_key: string;
  action: ChannelMaxAgentAction;
  mode: ChannelMaxAgentMode;
  session_key: string;
  agent_id: string;
  transport: "json" | "sse";
  response_id: string | null;
  text: string;
  response: unknown;
  events: OpenClawSseEvent[];
}

export interface ChannelMaxReadOnlyInput {
  jobId?: string;
  request?: JsonObject;
  stream?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: OpenClawSseEvent) => void | Promise<void>;
}

export interface ChannelMaxStatusInput
  extends Omit<ChannelMaxReadOnlyInput, "jobId"> {
  jobId: string;
}

export interface ChannelMaxCommitInput
  extends Omit<ChannelMaxReadOnlyInput, "jobId"> {
  jobId: string;
  planSha256: string;
  approvalToken: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenClawChannelMaxAgentClientOptions {
  gatewayUrl: string;
  gatewayToken: string;
  agentId?: string;
  sessionKey?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => Date;
  newJobId?: () => string;
}

export type OpenClawChannelMaxClientErrorCode =
  | "INVALID_INPUT"
  | "DIRECT_DISPATCH_DISABLED"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "REMOTE_FAILURE"
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK_ERROR";

export class OpenClawChannelMaxClientError extends Error {
  readonly code: OpenClawChannelMaxClientErrorCode;
  readonly httpStatus: number | null;
  readonly jobId: string | null;

  constructor(input: {
    code: OpenClawChannelMaxClientErrorCode;
    message: string;
    httpStatus?: number | null;
    jobId?: string | null;
  }) {
    super(input.message);
    this.name = "OpenClawChannelMaxClientError";
    this.code = input.code;
    this.httpStatus = input.httpStatus ?? null;
    this.jobId = input.jobId ?? null;
  }
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const RESERVED_SESSION_PREFIXES = ["subagent:", "cron:", "acp:"];

function clientError(
  message: string,
  jobId: string | null = null,
): OpenClawChannelMaxClientError {
  return new OpenClawChannelMaxClientError({
    code: "INVALID_INPUT",
    message,
    jobId,
  });
}

function requireNonEmpty(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw clientError(`${name} must not be empty.`);
  return normalized;
}

export function validateChannelMaxJobId(jobId: string): string {
  const normalized = requireNonEmpty("jobId", jobId);
  if (!JOB_ID_PATTERN.test(normalized)) {
    throw clientError(
      "jobId must be 1-128 characters and contain only letters, numbers, '.', '_', ':', or '-'.",
      normalized,
    );
  }
  return normalized;
}

export function validatePlanSha256(planSha256: string): string {
  const normalized = requireNonEmpty("planSha256", planSha256);
  if (!SHA256_PATTERN.test(normalized)) {
    throw clientError("planSha256 must be exactly 64 hexadecimal characters.");
  }
  return normalized.toLowerCase();
}

export function validateChannelMaxSessionKey(sessionKey: string): string {
  const normalized = requireNonEmpty("sessionKey", sessionKey);
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw clientError("sessionKey contains invalid control characters or is too long.");
  }
  if (RESERVED_SESSION_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw clientError(
      `sessionKey must not use a reserved OpenClaw namespace (${RESERVED_SESSION_PREFIXES.join(
        ", ",
      )}).`,
    );
  }
  return normalized;
}

function validateTimeoutMs(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1_800_000) {
    throw clientError("timeoutMs must be an integer between 100 and 1800000.");
  }
  return timeoutMs;
}

function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(requireNonEmpty("gatewayUrl", value));
  } catch {
    throw clientError("gatewayUrl must be a valid http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw clientError("gatewayUrl must use http:// or https://.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    throw clientError(
      "gatewayUrl may use plain HTTP only for a loopback host; remote gateways require HTTPS.",
    );
  }
  if (url.username || url.password) {
    throw clientError("gatewayUrl must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw clientError("gatewayUrl must not contain a query string or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function idempotencyKey(input: {
  action: ChannelMaxAgentAction;
  jobId: string;
  planSha256?: string;
}): string {
  const suffix = input.planSha256 ? `:${input.planSha256}` : "";
  return `channelmax:${input.action}:${input.jobId}${suffix}`;
}

export function buildChannelMaxTaskEnvelope(input: {
  action: ChannelMaxAgentAction;
  jobId: string;
  request?: JsonObject;
  requestedAt: string;
  planSha256?: string;
  approvalToken?: string;
}): ChannelMaxTaskEnvelope {
  const jobId = validateChannelMaxJobId(input.jobId);
  const isCommit = input.action === "commit";
  let authorization: ChannelMaxTaskEnvelope["authorization"] = null;

  if (isCommit) {
    if (input.planSha256 == null) {
      throw clientError("commit requires planSha256.", jobId);
    }
    if (input.approvalToken == null || !input.approvalToken.trim()) {
      throw clientError("commit requires a non-empty approvalToken.", jobId);
    }
    const planSha256 = validatePlanSha256(input.planSha256);
    authorization = {
      plan_sha256: planSha256,
      // The raw one-time proof is never serialized into the agent transcript.
      // OpenClaw-side policy should compare this digest with its expected digest.
      approval_token_sha256: sha256(input.approvalToken),
      one_time_approval: true,
    };
  } else if (input.planSha256 != null || input.approvalToken != null) {
    throw clientError(
      `${input.action} is read-only and must not carry commit authorization.`,
      jobId,
    );
  }

  const planSha = authorization?.plan_sha256;
  const readOnly = !isCommit;
  return {
    schema: OPENCLAW_CHANNELMAX_TASK_SCHEMA,
    job_id: jobId,
    idempotency_key: idempotencyKey({
      action: input.action,
      jobId,
      planSha256: planSha,
    }),
    action: input.action,
    requested_at: input.requestedAt,
    mode: readOnly ? "READ_ONLY" : "COMMIT_EXACT_PLAN",
    mutation_authorized: isCommit,
    request: input.request ?? {},
    authorization,
    constraints: {
      system: "CHANNELMAX",
      read_only: readOnly,
      no_blind_retry: true,
      require_before_after_evidence: true,
      require_exact_plan_hash_for_mutation: true,
      stop_for_login_2fa_or_captcha: true,
    },
  };
}

function secretKey(key: string): boolean {
  return /^(authorization|password|secret|gateway_token|approval_token|access_token|refresh_token)$/i.test(
    key,
  );
}

function replaceKnownSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function redactChannelMaxSecrets(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "string") return replaceKnownSecrets(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => redactChannelMaxSecrets(entry, secrets));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = secretKey(key)
        ? "[REDACTED]"
        : redactChannelMaxSecrets(entry, secrets);
    }
    return redacted;
  }
  return value;
}

function parseEventData(value: string): unknown {
  if (value === "[DONE]") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

interface MutableSseEvent {
  event: string;
  dataLines: string[];
  id?: string;
}

function createMutableSseEvent(): MutableSseEvent {
  return { event: "message", dataLines: [] };
}

function consumeSseLine(
  rawLine: string,
  current: MutableSseEvent,
  output: OpenClawSseEvent[],
): MutableSseEvent {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line === "") {
    if (current.dataLines.length > 0) {
      output.push({
        event: current.event,
        data: parseEventData(current.dataLines.join("\n")),
        ...(current.id == null ? {} : { id: current.id }),
      });
    }
    return createMutableSseEvent();
  }
  if (line.startsWith(":")) return current;
  const separator = line.indexOf(":");
  const field = separator === -1 ? line : line.slice(0, separator);
  let fieldValue = separator === -1 ? "" : line.slice(separator + 1);
  if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
  if (field === "event") current.event = fieldValue || "message";
  else if (field === "data") current.dataLines.push(fieldValue);
  else if (field === "id") current.id = fieldValue;
  return current;
}

export function parseOpenClawSseText(text: string): OpenClawSseEvent[] {
  const output: OpenClawSseEvent[] = [];
  let current = createMutableSseEvent();
  for (const line of text.split("\n")) {
    current = consumeSseLine(line, current, output);
  }
  if (current.dataLines.length > 0) {
    consumeSseLine("", current, output);
  }
  return output;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractOpenClawResponseText(response: unknown): string {
  const root = recordOf(response);
  if (!root) return typeof response === "string" ? response : "";
  if (typeof root.output_text === "string") return root.output_text;

  const parts: string[] = [];
  const output = Array.isArray(root.output) ? root.output : [];
  for (const item of output) {
    const itemRecord = recordOf(item);
    if (!itemRecord) continue;
    if (typeof itemRecord.text === "string") parts.push(itemRecord.text);
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const contentItem of content) {
      const contentRecord = recordOf(contentItem);
      if (typeof contentRecord?.text === "string") {
        parts.push(contentRecord.text);
      }
    }
  }
  return parts.join("");
}

function directDispatchDisabled(
  action: ChannelMaxAgentAction,
  jobId: string,
): OpenClawChannelMaxClientError {
  return new OpenClawChannelMaxClientError({
    code: "DIRECT_DISPATCH_DISABLED",
    message:
      `Direct OpenClaw ChannelMAX ${action} dispatch is disabled. ` +
      "Create a durable SS Command Center ChannelMAX queue job instead.",
    jobId,
  });
}

/**
 * Compatibility facade for the retired prompt-to-Gateway integration.
 *
 * Every action is deliberately fail-closed before `fetchImpl` can run. The
 * durable SSCC job queue is the only supported ChannelMAX dispatch path.
 */
export class OpenClawChannelMaxAgentClient {
  private readonly newJobId: () => string;

  constructor(options: OpenClawChannelMaxAgentClientOptions) {
    normalizeGatewayUrl(options.gatewayUrl);
    requireNonEmpty("gatewayToken", options.gatewayToken);
    requireNonEmpty(
      "agentId",
      options.agentId ?? DEFAULT_OPENCLAW_CHANNELMAX_AGENT_ID,
    );
    validateChannelMaxSessionKey(
      options.sessionKey ?? DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY,
    );
    validateTimeoutMs(options.timeoutMs ?? DEFAULT_OPENCLAW_CHANNELMAX_TIMEOUT_MS);
    this.newJobId = options.newJobId ?? randomUUID;
  }

  audit(input: ChannelMaxReadOnlyInput = {}): Promise<ChannelMaxAgentResult> {
    const jobId = validateChannelMaxJobId(input.jobId ?? this.newJobId());
    return Promise.reject(directDispatchDisabled("audit", jobId));
  }

  prepare(input: ChannelMaxReadOnlyInput = {}): Promise<ChannelMaxAgentResult> {
    const jobId = validateChannelMaxJobId(input.jobId ?? this.newJobId());
    return Promise.reject(directDispatchDisabled("prepare", jobId));
  }

  status(input: ChannelMaxStatusInput): Promise<ChannelMaxAgentResult> {
    const jobId = validateChannelMaxJobId(input.jobId);
    return Promise.reject(directDispatchDisabled("status", jobId));
  }

  commit(input: ChannelMaxCommitInput): Promise<ChannelMaxAgentResult> {
    const jobId = validateChannelMaxJobId(input.jobId);
    return Promise.reject(directDispatchDisabled("commit", jobId));
  }
}
