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

const FIXED_AGENT_INSTRUCTIONS = [
  "You are the dedicated ChannelMAX browser operator for SS Command Center.",
  "Treat the JSON task envelope as the complete control contract.",
  "For READ_ONLY mode, do not click save/apply/upload/submit, do not change any field, and do not invoke any mutating tool.",
  "For COMMIT_EXACT_PLAN mode, mutate only the exact sealed plan identified by plan_sha256; fail closed if current state, scope, or evidence differs.",
  "Never retry a mutation after an ambiguous timeout. Reconcile current state by job_id and idempotency_key first.",
  "Collect before/after evidence for every committed action and stop for login, 2FA, CAPTCHA, or any unclear UI state.",
  "Never reveal or repeat credentials, bearer tokens, approval proofs, cookies, or secrets.",
  "Return a concise structured result containing job_id, action, status, summary, evidence, and blockers.",
].join("\n");

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

function findSecretPayloadPath(value: unknown, path = "request"): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecretPayloadPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (secretKey(key)) return childPath;
    const found = findSecretPayloadPath(entry, childPath);
    if (found) return found;
  }
  return null;
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

function eventDelta(event: OpenClawSseEvent): string {
  const data = recordOf(event.data);
  if (!data) return "";
  if (event.event === "response.output_text.delta" && typeof data.delta === "string") {
    return data.delta;
  }
  return "";
}

function responseFromCompletedEvent(event: OpenClawSseEvent): unknown | null {
  if (event.event !== "response.completed") return null;
  const data = recordOf(event.data);
  return data?.response ?? event.data;
}

function responseIdOf(value: unknown): string | null {
  const root = recordOf(value);
  return typeof root?.id === "string" ? root.id : null;
}

async function readSseEvents(
  response: Response,
  onEvent: ((event: OpenClawSseEvent) => void | Promise<void>) | undefined,
  secrets: readonly string[],
): Promise<OpenClawSseEvent[]> {
  if (!response.body) {
    throw new OpenClawChannelMaxClientError({
      code: "INVALID_RESPONSE",
      message: "OpenClaw returned an SSE response without a body.",
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: OpenClawSseEvent[] = [];
  let current = createMutableSseEvent();
  let lineBuffer = "";

  const emitNewEvents = async (before: number): Promise<void> => {
    if (!onEvent) return;
    for (let index = before; index < events.length; index += 1) {
      const safeEvent = redactChannelMaxSecrets(events[index], secrets) as OpenClawSseEvent;
      await onEvent(safeEvent);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    lineBuffer += decoder.decode(value, { stream: !done });
    const lines = lineBuffer.split("\n");
    lineBuffer = done ? "" : (lines.pop() ?? "");
    if (done && lineBuffer) lines.push(lineBuffer);

    for (const line of lines) {
      const before = events.length;
      current = consumeSseLine(line, current, events);
      await emitNewEvents(before);
    }
    if (done) break;
  }

  if (current.dataLines.length > 0) {
    const before = events.length;
    consumeSseLine("", current, events);
    await emitNewEvents(before);
  }
  return events;
}

function bounded(value: string, max = 4_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function abortBundle(input: {
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error("OpenClaw request timeout"));
  }, input.timeoutMs);

  const forwardExternalAbort = () => {
    controller.abort(input.externalSignal?.reason);
  };
  if (input.externalSignal) {
    if (input.externalSignal.aborted) forwardExternalAbort();
    else input.externalSignal.addEventListener("abort", forwardExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      input.externalSignal?.removeEventListener("abort", forwardExternalAbort);
    },
    timedOut: () => timeoutTriggered,
  };
}

export class OpenClawChannelMaxAgentClient {
  private readonly gatewayUrl: string;
  private readonly gatewayToken: string;
  private readonly agentId: string;
  private readonly sessionKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly newJobId: () => string;

  constructor(options: OpenClawChannelMaxAgentClientOptions) {
    this.gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
    this.gatewayToken = requireNonEmpty("gatewayToken", options.gatewayToken);
    this.agentId = requireNonEmpty(
      "agentId",
      options.agentId ?? DEFAULT_OPENCLAW_CHANNELMAX_AGENT_ID,
    );
    this.sessionKey = validateChannelMaxSessionKey(
      options.sessionKey ?? DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY,
    );
    this.timeoutMs = validateTimeoutMs(
      options.timeoutMs ?? DEFAULT_OPENCLAW_CHANNELMAX_TIMEOUT_MS,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.newJobId = options.newJobId ?? randomUUID;
  }

  audit(input: ChannelMaxReadOnlyInput = {}): Promise<ChannelMaxAgentResult> {
    return this.executeReadOnly("audit", input);
  }

  prepare(input: ChannelMaxReadOnlyInput = {}): Promise<ChannelMaxAgentResult> {
    return this.executeReadOnly("prepare", input);
  }

  status(input: ChannelMaxStatusInput): Promise<ChannelMaxAgentResult> {
    return this.execute({
      action: "status",
      jobId: input.jobId,
      request: {
        ...input.request,
        status_query_for_job_id: input.jobId,
      },
      stream: input.stream,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onEvent: input.onEvent,
    });
  }

  commit(input: ChannelMaxCommitInput): Promise<ChannelMaxAgentResult> {
    return this.execute({
      action: "commit",
      jobId: input.jobId,
      request: input.request,
      planSha256: input.planSha256,
      approvalToken: input.approvalToken,
      stream: input.stream,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onEvent: input.onEvent,
    });
  }

  private executeReadOnly(
    action: "audit" | "prepare",
    input: ChannelMaxReadOnlyInput,
  ): Promise<ChannelMaxAgentResult> {
    return this.execute({
      action,
      jobId: input.jobId ?? this.newJobId(),
      request: input.request,
      stream: input.stream,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onEvent: input.onEvent,
    });
  }

  private async execute(input: {
    action: ChannelMaxAgentAction;
    jobId: string;
    request?: JsonObject;
    planSha256?: string;
    approvalToken?: string;
    stream?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onEvent?: (event: OpenClawSseEvent) => void | Promise<void>;
  }): Promise<ChannelMaxAgentResult> {
    const jobId = validateChannelMaxJobId(input.jobId);
    const secretPayloadPath = findSecretPayloadPath(input.request);
    if (secretPayloadPath) {
      throw clientError(
        `Task request must not contain credential field ${secretPayloadPath}; use the dedicated authentication inputs.`,
        jobId,
      );
    }
    const serializedRequest = JSON.stringify(input.request ?? {});
    if (
      serializedRequest.includes(this.gatewayToken) ||
      (Boolean(input.approvalToken) && serializedRequest.includes(input.approvalToken!))
    ) {
      throw clientError(
        "Task request contains a credential value and was rejected before network dispatch.",
        jobId,
      );
    }
    const envelope = buildChannelMaxTaskEnvelope({
      action: input.action,
      jobId,
      request: input.request,
      requestedAt: this.now().toISOString(),
      planSha256: input.planSha256,
      approvalToken: input.approvalToken,
    });
    const timeoutMs = validateTimeoutMs(input.timeoutMs ?? this.timeoutMs);
    const stream = input.stream ?? false;
    const secrets = [this.gatewayToken, input.approvalToken ?? ""];
    const abort = abortBundle({ timeoutMs, externalSignal: input.signal });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.gatewayToken}`,
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
          "x-openclaw-agent-id": this.agentId,
          "x-openclaw-session-key": this.sessionKey,
        },
        body: JSON.stringify({
          model: `openclaw/${this.agentId}`,
          user: this.sessionKey,
          instructions: FIXED_AGENT_INSTRUCTIONS,
          input: JSON.stringify(envelope),
          stream,
          metadata: {
            integration: "ss-command-center",
            action: envelope.action,
            job_id: envelope.job_id,
            idempotency_key: envelope.idempotency_key,
          },
        }),
        signal: abort.signal,
      });
    } catch (error) {
      abort.cleanup();
      if (abort.timedOut()) {
        throw new OpenClawChannelMaxClientError({
          code: "TIMEOUT",
          message: `OpenClaw request timed out after ${timeoutMs}ms; mutation state is unknown and must be reconciled by job_id before retrying.`,
          jobId,
        });
      }
      if (input.signal?.aborted || abort.signal.aborted) {
        throw new OpenClawChannelMaxClientError({
          code: "ABORTED",
          message: "OpenClaw request was aborted.",
          jobId,
        });
      }
      const safeMessage = replaceKnownSecrets(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
      throw new OpenClawChannelMaxClientError({
        code: "NETWORK_ERROR",
        message: `OpenClaw network request failed: ${bounded(safeMessage)}.`,
        jobId,
      });
    }

    try {
      if (!response.ok) {
        const body = replaceKnownSecrets(bounded(await response.text()), secrets);
        throw new OpenClawChannelMaxClientError({
          code: "HTTP_ERROR",
          message: `OpenClaw HTTP ${response.status}${body ? `: ${body}` : ""}`,
          httpStatus: response.status,
          jobId,
        });
      }

      if (stream) {
        const events = await readSseEvents(response, input.onEvent, secrets);
        const failure = events.find((event) => event.event === "response.failed");
        if (failure) {
          throw new OpenClawChannelMaxClientError({
            code: "REMOTE_FAILURE",
            message: `OpenClaw response.failed: ${bounded(
              JSON.stringify(redactChannelMaxSecrets(failure.data, secrets)),
            )}`,
            jobId,
          });
        }

        let completedResponse: unknown = null;
        let responseId: string | null = null;
        let text = "";
        for (const event of events) {
          text += eventDelta(event);
          completedResponse = responseFromCompletedEvent(event) ?? completedResponse;
          if (event.event === "response.created") {
            responseId = responseIdOf(recordOf(event.data)?.response) ?? responseId;
          }
        }
        responseId = responseIdOf(completedResponse) ?? responseId;
        if (!text) text = extractOpenClawResponseText(completedResponse);

        return redactChannelMaxSecrets(
          {
            schema: OPENCLAW_CHANNELMAX_RESULT_SCHEMA,
            job_id: envelope.job_id,
            idempotency_key: envelope.idempotency_key,
            action: envelope.action,
            mode: envelope.mode,
            session_key: this.sessionKey,
            agent_id: this.agentId,
            transport: "sse",
            response_id: responseId,
            text,
            response: completedResponse,
            events,
          } satisfies ChannelMaxAgentResult,
          secrets,
        ) as ChannelMaxAgentResult;
      }

      const rawText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch {
        throw new OpenClawChannelMaxClientError({
          code: "INVALID_RESPONSE",
          message: `OpenClaw returned invalid JSON: ${bounded(
            replaceKnownSecrets(rawText, secrets),
          )}`,
          jobId,
        });
      }
      const safeResponse = redactChannelMaxSecrets(parsed, secrets);
      return {
        schema: OPENCLAW_CHANNELMAX_RESULT_SCHEMA,
        job_id: envelope.job_id,
        idempotency_key: envelope.idempotency_key,
        action: envelope.action,
        mode: envelope.mode,
        session_key: this.sessionKey,
        agent_id: this.agentId,
        transport: "json",
        response_id: responseIdOf(safeResponse),
        text: extractOpenClawResponseText(safeResponse),
        response: safeResponse,
        events: [],
      };
    } finally {
      abort.cleanup();
    }
  }
}
