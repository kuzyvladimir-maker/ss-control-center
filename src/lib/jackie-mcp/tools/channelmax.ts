/**
 * Jackie MCP tools — durable ChannelMAX/OpenClaw bridge.
 *
 * This surface deliberately exposes only the bridge's finite high-level
 * operations. It never accepts URLs to navigate to, selectors, scripts, or
 * arbitrary browser instructions. UPLOAD_MANUAL_ASSIGNMENT creation is safe:
 * it creates a PENDING_APPROVAL job and does not grant owner approval.
 */

import {
  parseCancelChannelMaxAgentJob,
  parseCreateChannelMaxAgentJob,
  parseCreateChannelMaxReconciliation,
} from "@/lib/channelmax-agent/contracts";
import {
  cancelChannelMaxAgentJob,
  channelMaxAgentCapabilities,
  createChannelMaxAgentJob,
  createChannelMaxReconciliationJob,
  getChannelMaxAgentJob,
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
    if (!createOperationEnum.includes(input.operation)) {
      throw new Error(
        `${input.operation} is not directly creatable through Jackie MCP. Use channelmax_job_reconcile for a server-derived reconciliation job.`,
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

const channelMaxJobCancel: JackieTool = {
  name: "channelmax_job_cancel",
  description:
    "Cancel a pending, queued, or leased ChannelMAX job only while it is still before the external-write fence.",
  long_description:
    "The server refuses cancellation after MUTATION_STARTED. An ambiguous or fenced mutation must be reconciled instead of cancelled or retried.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      cancellation_key: { type: "string", minLength: 8, maxLength: 128 },
      reason: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    required: ["job_id", "cancellation_key", "reason"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const jobId = requireString(args, "job_id");
    return cancelChannelMaxAgentJob(
      jobId,
      parseCancelChannelMaxAgentJob(withoutJobId(args)),
      JACKIE_ACTOR_ID,
    );
  },
};

const channelMaxJobReconcile: JackieTool = {
  name: "channelmax_job_reconcile",
  description:
    "Derive one read-only reconciliation job from an ambiguous ChannelMAX upload job.",
  long_description:
    "The server binds the reconciliation to the ambiguous job's account, artifact SHA, row count, and manual model. The worker may inspect upload-task history and export inventory but may not repeat the upload.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "The terminal AMBIGUOUS upload job to reconcile.",
      },
      idempotency_key: { type: "string", minLength: 8, maxLength: 128 },
      priority: { type: "integer", minimum: -100, maximum: 100, default: 100 },
      max_attempts: { type: "integer", minimum: 1, maximum: 5, default: 3 },
    },
    required: ["job_id", "idempotency_key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const jobId = requireString(args, "job_id");
    return createChannelMaxReconciliationJob(
      jobId,
      parseCreateChannelMaxReconciliation(withoutJobId(args)),
      ctx.actor,
    );
  },
};

export const tools: JackieTool[] = [
  channelMaxCapabilities,
  channelMaxJobCreate,
  channelMaxJobGet,
  channelMaxJobCancel,
  channelMaxJobReconcile,
];
