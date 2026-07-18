/**
 * Jackie MCP tools — durable ChannelMAX/OpenClaw bridge.
 *
 * This surface deliberately exposes only the bridge's finite high-level
 * operations. It never accepts URLs to navigate to, selectors, scripts, or
 * arbitrary browser instructions. UPLOAD_MANUAL_ASSIGNMENT creation is safe:
 * it creates a PENDING_APPROVAL job and does not grant owner approval.
 */

import {
  parseChannelMaxHeartbeat,
  parseChannelMaxWorkerEvent,
  parseClaimChannelMaxAgentJob,
  parseCompleteChannelMaxAgentJob,
  parseCreateChannelMaxAgentJob,
} from "@/lib/channelmax-agent/contracts";
import {
  appendChannelMaxAgentEvent,
  channelMaxAgentCapabilities,
  claimChannelMaxAgentJob,
  completeChannelMaxAgentJob,
  createChannelMaxAgentJob,
  getChannelMaxAgentJob,
  heartbeatChannelMaxAgentJob,
} from "@/lib/channelmax-agent/service";
import { requireString } from "../channels";
import type { JackieTool } from "../registry";

const JACKIE_ACTOR_ID = "system:jackie";

const createOperationEnum = [
  "SNAPSHOT_INVENTORY",
  "DISCOVER_MANUAL_MODEL",
  "UPLOAD_MANUAL_ASSIGNMENT",
  "VERIFY_UPLOAD_TASK",
  "EXPORT_INVENTORY",
  "OBSERVE_POST_UPLOAD_HOLD",
];

const workerOperationEnum = [
  ...createOperationEnum,
  "RECONCILE_MUTATION",
];

const evidenceSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [
        "SCREENSHOT",
        "DOM_SNAPSHOT",
        "DOWNLOAD",
        "UPLOAD_SOURCE",
        "INVENTORY_EXPORT",
        "RUN_LOG",
      ],
    },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    byte_size: { type: "integer", minimum: 1 },
    media_type: { type: "string" },
    captured_at: { type: "string", format: "date-time" },
    uri: { type: "string", format: "uri" },
  },
  required: ["kind", "sha256", "byte_size", "media_type", "captured_at"],
  additionalProperties: false,
};

const basePayloadProperties = {
  account_id: { type: "string" },
  expected_active_rows: { type: "integer", minimum: 1, maximum: 10_000 },
};

const createPayloadSchema = {
  oneOf: [
    {
      title: "Snapshot inventory",
      type: "object",
      properties: {
        ...basePayloadProperties,
        include_inactive: { type: "boolean" },
      },
      required: ["account_id", "expected_active_rows", "include_inactive"],
      additionalProperties: false,
    },
    {
      title: "Discover manual model",
      type: "object",
      properties: basePayloadProperties,
      required: ["account_id", "expected_active_rows"],
      additionalProperties: false,
    },
    {
      title: "Upload sealed manual assignment (pending approval)",
      type: "object",
      properties: {
        ...basePayloadProperties,
        assignment_artifact: {
          type: "object",
          properties: {
            download_url: { type: "string", format: "uri" },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            byte_size: { type: "integer", minimum: 1 },
            media_type: { type: "string" },
          },
          required: ["download_url", "sha256", "byte_size", "media_type"],
          additionalProperties: false,
        },
        manual_model_id: { type: "string", pattern: "^\\d+$" },
        manual_model_name: { type: "string" },
        selling_venue: { type: "string", const: "AmazonUS" },
        required_skip_rules: {
          type: "array",
          items: [
            { type: "string", const: "44a" },
            { type: "string", const: "44b" },
          ],
          additionalItems: false,
          minItems: 2,
          maxItems: 2,
        },
      },
      required: [
        "account_id",
        "expected_active_rows",
        "assignment_artifact",
        "manual_model_id",
        "manual_model_name",
        "selling_venue",
        "required_skip_rules",
      ],
      additionalProperties: false,
    },
    {
      title: "Verify upload task",
      type: "object",
      properties: {
        ...basePayloadProperties,
        upload_task_id: { type: "string" },
        expected_assignment_sha256: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
        },
      },
      required: [
        "account_id",
        "expected_active_rows",
        "upload_task_id",
        "expected_assignment_sha256",
      ],
      additionalProperties: false,
    },
    {
      title: "Export inventory evidence",
      type: "object",
      properties: {
        ...basePayloadProperties,
        purpose: { type: "string", const: "POST_UPLOAD_EVIDENCE" },
      },
      required: ["account_id", "expected_active_rows", "purpose"],
      additionalProperties: false,
    },
    {
      title: "Observe post-upload hold",
      type: "object",
      properties: {
        ...basePayloadProperties,
        upload_task_id: { type: "string" },
        not_before: { type: "string", format: "date-time" },
        expected_assignment_sha256: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
        },
      },
      required: [
        "account_id",
        "expected_active_rows",
        "upload_task_id",
        "not_before",
        "expected_assignment_sha256",
      ],
      additionalProperties: false,
    },
  ],
};

function withoutJobId(args: Record<string, unknown>): Record<string, unknown> {
  const input = { ...args };
  delete input.job_id;
  return input;
}

const channelMaxCapabilities: JackieTool = {
  name: "channelmax_capabilities",
  description:
    "List the finite durable ChannelMAX job operations and safety protocol available to Jackie.",
  long_description:
    "Read this before queueing work. The bridge has no arbitrary browser-command capability and this MCP surface cannot approve a mutation.",
  write: false,
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async () => channelMaxAgentCapabilities(),
};

const channelMaxJobCreate: JackieTool = {
  name: "channelmax_job_create",
  description:
    "Create one durable high-level ChannelMAX job; upload jobs remain PENDING_APPROVAL until independently approved by a signed-in owner.",
  long_description:
    "This does not execute a browser action. Read-only jobs enter QUEUED. UPLOAD_MANUAL_ASSIGNMENT enters PENDING_APPROVAL; Jackie cannot approve it and must wait for an independent owner session.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: createOperationEnum },
      idempotency_key: { type: "string", minLength: 8, maxLength: 128 },
      priority: { type: "integer", minimum: -100, maximum: 100, default: 0 },
      max_attempts: { type: "integer", minimum: 1, maximum: 5, default: 3 },
      payload: createPayloadSchema,
    },
    required: ["operation", "idempotency_key", "payload"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const input = parseCreateChannelMaxAgentJob(args);
    if (input.operation === "RECONCILE_MUTATION") {
      throw new Error(
        "RECONCILE_MUTATION must be derived with channelmax_job_reconcile so it stays bound to one ambiguous mutation.",
      );
    }
    return createChannelMaxAgentJob(input, ctx.actor);
  },
};

const channelMaxJobGet: JackieTool = {
  name: "channelmax_job_get",
  description:
    "Get one durable ChannelMAX job with its append-only event/evidence history.",
  write: false,
  input_schema: {
    type: "object",
    properties: { job_id: { type: "string" } },
    required: ["job_id"],
    additionalProperties: false,
  },
  handler: async (args) => getChannelMaxAgentJob(requireString(args, "job_id")),
};

const channelMaxJobClaim: JackieTool = {
  name: "channelmax_job_claim",
  description:
    "Claim the next durable ChannelMAX job using an expiring worker lease.",
  long_description:
    "Omitting supported_operations claims read-only work only. Include UPLOAD_MANUAL_ASSIGNMENT only if this worker can follow the mutation fence; the server still refuses unapproved or expired mutation plans.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      worker_id: { type: "string" },
      supported_operations: {
        type: "array",
        items: { type: "string", enum: workerOperationEnum },
        minItems: 1,
        uniqueItems: true,
      },
      lease_seconds: {
        type: "integer",
        minimum: 30,
        maximum: 300,
        default: 120,
      },
    },
    required: ["worker_id"],
    additionalProperties: false,
  },
  handler: async (args) =>
    claimChannelMaxAgentJob(
      parseClaimChannelMaxAgentJob(args),
      JACKIE_ACTOR_ID,
    ),
};

const channelMaxJobEvent: JackieTool = {
  name: "channelmax_job_event",
  description:
    "Append an idempotent progress, evidence, or mutation-fence event to a leased ChannelMAX job.",
  long_description:
    "MUTATION_STARTED is the external-write fence and requires the exact approved upload-source evidence. Outcome events require immutable screenshot or DOM evidence. This records worker evidence; it is not an arbitrary browser command.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      event_key: { type: "string", minLength: 8, maxLength: 128 },
      lease_token: { type: "string", pattern: "^[a-f0-9]{64}$" },
      type: {
        type: "string",
        enum: [
          "PROGRESS",
          "AUTH_REQUIRED",
          "EVIDENCE_CAPTURED",
          "MUTATION_STARTED",
          "MUTATION_CONFIRMED",
          "MUTATION_NOT_APPLIED",
          "MUTATION_AMBIGUOUS",
        ],
      },
      occurred_at: { type: "string", format: "date-time" },
      message: { type: "string", maxLength: 2_000 },
      step: { type: "string" },
      progress_percent: { type: "integer", minimum: 0, maximum: 100 },
      evidence: { type: "array", items: evidenceSchema, maxItems: 25 },
    },
    required: ["job_id", "event_key", "lease_token", "type"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const jobId = requireString(args, "job_id");
    return appendChannelMaxAgentEvent(
      jobId,
      parseChannelMaxWorkerEvent(withoutJobId(args)),
      JACKIE_ACTOR_ID,
    );
  },
};

const channelMaxJobHeartbeat: JackieTool = {
  name: "channelmax_job_heartbeat",
  description:
    "Renew an active ChannelMAX worker lease and report its current phase.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      lease_token: { type: "string", pattern: "^[a-f0-9]{64}$" },
      phase: { type: "string" },
      progress_percent: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["job_id", "lease_token", "phase"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const jobId = requireString(args, "job_id");
    return heartbeatChannelMaxAgentJob(
      jobId,
      parseChannelMaxHeartbeat(withoutJobId(args)),
      JACKIE_ACTOR_ID,
    );
  },
};

const channelMaxJobComplete: JackieTool = {
  name: "channelmax_job_complete",
  description:
    "Finalize a leased ChannelMAX job with an idempotent terminal result and evidence.",
  long_description:
    "A successful mutation completion is accepted only after an exact MUTATION_CONFIRMED event and bound immutable evidence. Ambiguous results remain blocked from automatic retry.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      completion_key: { type: "string", minLength: 8, maxLength: 128 },
      lease_token: { type: "string", pattern: "^[a-f0-9]{64}$" },
      status: { type: "string", enum: ["SUCCEEDED", "FAILED", "AMBIGUOUS"] },
      mutation_outcome: {
        type: "string",
        enum: ["CONFIRMED_APPLIED", "CONFIRMED_NOT_APPLIED", "AMBIGUOUS"],
      },
      message: { type: "string", maxLength: 4_000 },
      result: { type: "object" },
      evidence: { type: "array", items: evidenceSchema, maxItems: 25 },
    },
    required: [
      "job_id",
      "completion_key",
      "lease_token",
      "status",
      "message",
      "result",
    ],
    additionalProperties: false,
  },
  handler: async (args) => {
    const jobId = requireString(args, "job_id");
    return completeChannelMaxAgentJob(
      jobId,
      parseCompleteChannelMaxAgentJob(withoutJobId(args)),
      JACKIE_ACTOR_ID,
    );
  },
};

export const tools: JackieTool[] = [
  channelMaxCapabilities,
  channelMaxJobCreate,
  channelMaxJobGet,
  channelMaxJobClaim,
  channelMaxJobEvent,
  channelMaxJobHeartbeat,
  channelMaxJobComplete,
];
