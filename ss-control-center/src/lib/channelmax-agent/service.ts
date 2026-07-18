import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CHANNELMAX_AGENT_OPERATIONS,
  CHANNELMAX_OWNER_APPROVAL_SCHEMA,
  type ApproveChannelMaxAgentJobInput,
  type ChannelMaxAgentOperation,
  type ChannelMaxEvidenceRef,
  type ChannelMaxManagedEvidenceUploadInput,
  type ChannelMaxWorkerEventInput,
  type ClaimChannelMaxAgentJobInput,
  type CancelChannelMaxAgentJobInput,
  type CompleteChannelMaxAgentJobInput,
  type CreateChannelMaxAgentJobInput,
  type CreateChannelMaxReconciliationInput,
  type ChannelMaxHeartbeatInput,
  classifyExpiredChannelMaxLease,
  deriveTerminalDecision,
  isMutationOperation,
  sha256Json,
  stableJson,
} from "./contracts";
import {
  assertChannelMaxManagedEvidenceContent,
  ChannelMaxEvidenceContentError,
} from "./evidence-content";

const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "AMBIGUOUS",
  "CANCELLED",
]);
const CHANNELMAX_BROWSER_LEASE_KEY = "channelmax:imac-primary";
export const CHANNELMAX_MANAGED_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const CHANNELMAX_MANAGED_EVIDENCE_MAX_ITEMS_PER_JOB = 25;
export const CHANNELMAX_MANAGED_EVIDENCE_MAX_TOTAL_BYTES_PER_JOB =
  25 * 1024 * 1024;
const MANAGED_MUTATION_EVIDENCE_IMPLEMENTED = true;
// Deliberate release gate. Managed evidence now makes read-only work
// verifiable, but production mutation approval remains unavailable until the
// complete owner-approval ceremony is separately accepted for deployment.
const MUTATION_APPROVAL_PRODUCTION_READY = false;

export function channelMaxMutationApprovalEnabled(): boolean {
  // Production must remain fail-closed until SSCC owns immutable evidence
  // bytes and verifies their hashes itself. The explicit test-only bypass lets
  // the state machine be exercised without creating a production capability.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY === "true"
  ) {
    return true;
  }
  return (
    MUTATION_APPROVAL_PRODUCTION_READY &&
    MANAGED_MUTATION_EVIDENCE_IMPLEMENTED &&
    process.env.CHANNELMAX_MUTATION_APPROVAL_ENABLED === "true"
  );
}

function assertMutationExecutionReleaseGate(): void {
  if (!channelMaxMutationApprovalEnabled()) {
    throw new ChannelMaxAgentServiceError(
      "MUTATION_EXECUTION_DISABLED",
      "ChannelMAX mutation execution is disabled by the production release gate.",
      503,
    );
  }
}

export class ChannelMaxAgentServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "ChannelMaxAgentServiceError";
  }
}

interface StoredEventInput {
  eventKey: string;
  type: string;
  source: string;
  message?: string;
  metadata: Record<string, unknown>;
  evidence?: ChannelMaxEvidenceRef[];
  occurredAt: Date;
}

function tokenSha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeDigestEqual(left: string | null, right: string): boolean {
  if (!left || !/^[a-f0-9]{64}$/.test(left)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseStoredJson(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { storage_error: "invalid_json" };
  }
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

async function appendStoredEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  input: StoredEventInput,
) {
  const sequence = await tx.channelMaxAgentJob.update({
    where: { id: jobId },
    data: { eventSequence: { increment: 1 } },
    select: { eventSequence: true },
  });
  const metadataJson = stableJson(input.metadata);
  const evidence = input.evidence ?? [];
  const evidenceJson = stableJson(evidence);
  return tx.channelMaxAgentEvent.create({
    data: {
      jobId,
      sequence: sequence.eventSequence,
      eventKey: input.eventKey,
      type: input.type,
      source: input.source,
      message: input.message,
      metadataJson,
      metadataSha256: sha256Json(input.metadata),
      evidenceJson,
      evidenceSha256: sha256Json(evidence),
      occurredAt: input.occurredAt,
    },
  });
}

function publicEvent(event: {
  id: string;
  sequence: number;
  eventKey: string;
  type: string;
  source: string;
  message: string | null;
  metadataJson: string;
  metadataSha256: string;
  evidenceJson: string;
  evidenceSha256: string;
  occurredAt: Date;
  createdAt: Date;
}) {
  return {
    id: event.id,
    sequence: event.sequence,
    event_key: event.eventKey,
    type: event.type,
    source: event.source,
    message: event.message,
    metadata: parseStoredJson(event.metadataJson),
    metadata_sha256: event.metadataSha256,
    evidence: parseStoredJson(event.evidenceJson),
    evidence_sha256: event.evidenceSha256,
    occurred_at: event.occurredAt.toISOString(),
    created_at: event.createdAt.toISOString(),
  };
}

function publicJob(job: {
  id: string;
  operation: string;
  mutation: boolean;
  status: string;
  priority: number;
  accountId: string;
  payloadJson: string;
  payloadSha256: string;
  requestSha256: string;
  mutationPlanSha256: string | null;
  mutationPlanLock: string | null;
  idempotencyKey: string;
  requestedBy: string;
  ownerApproved: boolean;
  ownerApprovedBy: string | null;
  ownerApprovedById: string | null;
  ownerApprovedAt: Date | null;
  assignmentArtifactSha256: string | null;
  approvalSubjectJson: string | null;
  approvalSha256: string | null;
  approvalExpiresAt: Date | null;
  approvalNonce: string | null;
  approvalStepUpAssertionId: string | null;
  approvalStepUpMethod: string | null;
  approvalStepUpCeremonyId: string | null;
  approvalStepUpVerifiedAt: Date | null;
  workerId: string | null;
  workerActorId: string | null;
  accountLeaseKey: string | null;
  browserLeaseKey: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  attempts: number;
  maxAttempts: number;
  mutationStartedAt: Date | null;
  mutationOutcome: string | null;
  ambiguityReason: string | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  reconcilesJobId: string | null;
  reconciliationTargetLock: string | null;
  reconciledByJobId: string | null;
  resultJson: string | null;
  resultSha256: string | null;
  error: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  events?: Array<Parameters<typeof publicEvent>[0]>;
}) {
  return {
    id: job.id,
    operation: job.operation,
    mutation: job.mutation,
    status: job.status,
    priority: job.priority,
    account_id: job.accountId,
    payload: parseStoredJson(job.payloadJson),
    payload_sha256: job.payloadSha256,
    request_sha256: job.requestSha256,
    mutation_plan_sha256: job.mutationPlanSha256,
    idempotency_key: job.idempotencyKey,
    requested_by: job.requestedBy,
    owner_approval: job.ownerApproved
      ? {
          approved: true,
          approved_by: job.ownerApprovedBy,
          approved_by_id: job.ownerApprovedById,
          approved_at: iso(job.ownerApprovedAt),
          assignment_sha256: job.assignmentArtifactSha256,
          approval_sha256: job.approvalSha256,
          expires_at: iso(job.approvalExpiresAt),
          nonce: job.approvalNonce,
          step_up_assertion_id: job.approvalStepUpAssertionId,
          step_up_method: job.approvalStepUpMethod,
          step_up_ceremony_id: job.approvalStepUpCeremonyId,
          step_up_verified_at: iso(job.approvalStepUpVerifiedAt),
        }
      : null,
    approval_required: job.mutation && !job.ownerApproved,
    approval_plan: job.mutation ? uploadBindingFromJob(job) : null,
    worker_id: job.workerId,
    worker_actor_id: job.workerActorId,
    lease_expires_at: iso(job.leaseExpiresAt),
    last_heartbeat_at: iso(job.lastHeartbeatAt),
    attempts: job.attempts,
    max_attempts: job.maxAttempts,
    mutation_started_at: iso(job.mutationStartedAt),
    mutation_outcome: job.mutationOutcome,
    ambiguity_reason: job.ambiguityReason,
    cancelled_at: iso(job.cancelledAt),
    cancelled_by: job.cancelledBy,
    cancellation_reason: job.cancellationReason,
    reconciles_job_id: job.reconcilesJobId,
    reconciled_by_job_id: job.reconciledByJobId,
    result: parseStoredJson(job.resultJson),
    result_sha256: job.resultSha256,
    error: job.error,
    queued_at: job.queuedAt.toISOString(),
    started_at: iso(job.startedAt),
    completed_at: iso(job.completedAt),
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
    ...(job.events ? { events: job.events.map(publicEvent) } : {}),
  };
}

function requestDigest(input: CreateChannelMaxAgentJobInput): string {
  return sha256Json({
    operation: input.operation,
    idempotency_key: input.idempotency_key,
    priority: input.priority,
    max_attempts: input.max_attempts,
    payload: input.payload,
  });
}

function mutationPlanDigest(input: CreateChannelMaxAgentJobInput): string | null {
  if (!isMutationOperation(input.operation)) return null;
  return sha256Json({ operation: input.operation, payload: input.payload });
}

async function validateReconciliationRequest(
  input: CreateChannelMaxAgentJobInput,
) {
  if (input.operation !== "RECONCILE_MUTATION") return null;
  const payload = input.payload as {
    ambiguous_job_id: string;
    account_id: string;
    expected_active_rows: number;
    assignment_sha256: string;
    manual_model_id: string;
    manual_model_name: string;
  };
  const original = await prisma.channelMaxAgentJob.findUnique({
    where: { id: payload.ambiguous_job_id },
  });
  if (!original || !original.mutation || original.status !== "AMBIGUOUS") {
    throw new ChannelMaxAgentServiceError(
      "RECONCILIATION_TARGET_INVALID",
      "Reconciliation target must be an existing ambiguous mutation job.",
      409,
    );
  }
  const binding = uploadBindingFromJob(original);
  if (
    payload.account_id !== binding.account_id ||
    payload.expected_active_rows !== binding.expected_active_rows ||
    payload.assignment_sha256 !== binding.assignment_sha256 ||
    payload.manual_model_id !== binding.manual_model_id ||
    payload.manual_model_name !== binding.manual_model_name
  ) {
    throw new ChannelMaxAgentServiceError(
      "RECONCILIATION_BINDING_MISMATCH",
      "Reconciliation payload does not exactly match the ambiguous mutation.",
      409,
    );
  }
  return original;
}

interface ApprovalBoundJob {
  id: string;
  operation: string;
  priority: number;
  accountId: string;
  payloadJson: string;
  payloadSha256: string;
  requestSha256: string;
  mutationPlanSha256: string | null;
  mutationPlanLock: string | null;
  idempotencyKey: string;
  maxAttempts: number;
  ownerApproved: boolean;
  ownerApprovedBy: string | null;
  ownerApprovedById: string | null;
  ownerApprovedAt: Date | null;
  assignmentArtifactSha256: string | null;
  approvalSubjectJson: string | null;
  approvalSha256: string | null;
  approvalExpiresAt: Date | null;
  approvalNonce: string | null;
  approvalStepUpAssertionId: string | null;
  approvalStepUpMethod: string | null;
  approvalStepUpCeremonyId: string | null;
  approvalStepUpVerifiedAt: Date | null;
}

function canonicalStoredPayload(job: ApprovalBoundJob): Record<string, unknown> | null {
  const payload = parseStoredJson(job.payloadJson);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

function hasCanonicalStoredRequest(job: ApprovalBoundJob): boolean {
  try {
    const payload = canonicalStoredPayload(job);
    if (!payload || sha256Json(payload) !== job.payloadSha256) return false;
    const recalculatedRequest = sha256Json({
      operation: job.operation,
      idempotency_key: job.idempotencyKey,
      priority: job.priority,
      max_attempts: job.maxAttempts,
      payload,
    });
    if (recalculatedRequest !== job.requestSha256) return false;
    if (job.operation === "UPLOAD_MANUAL_ASSIGNMENT") {
      const plan = sha256Json({ operation: job.operation, payload });
      return (
        job.mutationPlanSha256 === plan &&
        job.mutationPlanLock === plan
      );
    }
    return job.mutationPlanSha256 == null && job.mutationPlanLock == null;
  } catch {
    return false;
  }
}

function uploadBindingFromJob(job: ApprovalBoundJob) {
  const payload = parseStoredJson(job.payloadJson) as {
    account_id?: unknown;
    expected_active_rows?: unknown;
    assignment_artifact?: { sha256?: unknown };
    manual_model_id?: unknown;
    manual_model_name?: unknown;
  } | null;
  if (
    job.operation !== "UPLOAD_MANUAL_ASSIGNMENT" ||
    !payload ||
    payload.account_id !== job.accountId ||
    !Number.isInteger(payload.expected_active_rows) ||
    typeof payload.assignment_artifact?.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.assignment_artifact.sha256) ||
    typeof payload.manual_model_id !== "string" ||
    !/^\d+$/.test(payload.manual_model_id) ||
    typeof payload.manual_model_name !== "string" ||
    !payload.manual_model_name.trim() ||
    typeof job.mutationPlanSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(job.mutationPlanSha256)
  ) {
    throw new ChannelMaxAgentServiceError(
      "MUTATION_BINDING_INVALID",
      "Stored mutation payload cannot be bound to an owner approval.",
      409,
    );
  }
  return {
    schema_version: CHANNELMAX_OWNER_APPROVAL_SCHEMA,
    job_id: job.id,
    operation: "UPLOAD_MANUAL_ASSIGNMENT" as const,
    account_id: payload.account_id,
    manual_model_id: payload.manual_model_id,
    manual_model_name: payload.manual_model_name.trim(),
    expected_active_rows: payload.expected_active_rows as number,
    assignment_sha256: payload.assignment_artifact.sha256,
    payload_sha256: job.payloadSha256,
    request_sha256: job.requestSha256,
    mutation_plan_sha256: job.mutationPlanSha256,
  };
}

function approvalSubject(
  job: ApprovalBoundJob,
  input: ApproveChannelMaxAgentJobInput,
  approvedBy: string,
    approvedById: string,
  stepUp: {
    id: string;
    method: string;
    ceremonyId: string;
    verifiedAt: Date;
  },
  approvedAt: Date,
) {
  return {
    ...uploadBindingFromJob(job),
    expires_at: input.expires_at,
    nonce: input.nonce,
    approved_by: approvedBy,
    approved_by_id: approvedById,
    approved_at: approvedAt.toISOString(),
    step_up_assertion_id: stepUp.id,
    step_up_method: stepUp.method,
    step_up_ceremony_id: stepUp.ceremonyId,
    step_up_verified_at: stepUp.verifiedAt.toISOString(),
  };
}

function approvalBindingForEvents(job: ApprovalBoundJob) {
  return {
    job_id: job.id,
    operation: job.operation,
    account_id: job.accountId,
    payload_sha256: job.payloadSha256,
    request_sha256: job.requestSha256,
    assignment_sha256: job.assignmentArtifactSha256,
    approval_sha256: job.approvalSha256,
  };
}

function hasExactCurrentApproval(job: ApprovalBoundJob, now: Date): boolean {
  if (
    !job.ownerApproved ||
    !job.ownerApprovedBy ||
    !job.ownerApprovedById ||
    !job.ownerApprovedAt ||
    !job.approvalSubjectJson ||
    !job.approvalSha256 ||
    !job.approvalExpiresAt ||
    !job.approvalNonce ||
    !job.approvalStepUpAssertionId ||
    !job.approvalStepUpMethod ||
    !job.approvalStepUpCeremonyId ||
    !job.approvalStepUpVerifiedAt ||
    !job.assignmentArtifactSha256 ||
    job.approvalExpiresAt.getTime() <= now.getTime()
  ) {
    return false;
  }
  try {
    if (!hasCanonicalStoredRequest(job)) return false;
    const stored = parseStoredJson(job.approvalSubjectJson) as Record<
      string,
      unknown
    >;
    const expected = {
      ...uploadBindingFromJob(job),
      expires_at: job.approvalExpiresAt.toISOString(),
      nonce: job.approvalNonce,
      approved_by: job.ownerApprovedBy,
      approved_by_id: job.ownerApprovedById,
      approved_at: job.ownerApprovedAt.toISOString(),
      step_up_assertion_id: job.approvalStepUpAssertionId,
      step_up_method: job.approvalStepUpMethod,
      step_up_ceremony_id: job.approvalStepUpCeremonyId,
      step_up_verified_at: job.approvalStepUpVerifiedAt.toISOString(),
    };
    return (
      stableJson(stored) === stableJson(expected) &&
      sha256Json(stored) === job.approvalSha256 &&
      job.assignmentArtifactSha256 === expected.assignment_sha256
    );
  } catch {
    return false;
  }
}

function hasExactApprovalEvent(
  job: ApprovalBoundJob,
  event: {
    eventKey: string;
    type: string;
    source: string;
    metadataJson: string;
    metadataSha256: string;
    evidenceJson: string;
    evidenceSha256: string;
    occurredAt: Date;
  } | null,
): boolean {
  if (
    !event ||
    !job.approvalNonce ||
    !job.approvalSubjectJson ||
    !job.approvalSha256 ||
    !job.ownerApprovedById ||
    !job.ownerApprovedAt
  ) {
    return false;
  }
  try {
    const metadata = parseStoredJson(event.metadataJson) as {
      approval_sha256?: unknown;
      approval_subject?: unknown;
    } | null;
    const evidence = parseStoredJson(event.evidenceJson);
    return (
      event.eventKey === `owner-approval:${job.approvalNonce}` &&
      event.type === "OWNER_APPROVED" &&
      event.source === job.ownerApprovedById &&
      event.occurredAt.getTime() === job.ownerApprovedAt.getTime() &&
      metadata != null &&
      metadata.approval_sha256 === job.approvalSha256 &&
      stableJson(metadata.approval_subject) === job.approvalSubjectJson &&
      sha256Json(metadata.approval_subject) === job.approvalSha256 &&
      sha256Json(metadata) === event.metadataSha256 &&
      Array.isArray(evidence) &&
      evidence.length === 0 &&
      sha256Json(evidence) === event.evidenceSha256
    );
  } catch {
    return false;
  }
}

async function hasSealedCurrentApproval(
  client: Pick<
    Prisma.TransactionClient,
    "channelMaxAgentEvent" | "channelMaxStepUpAssertion"
  >,
  job: ApprovalBoundJob,
  now: Date,
): Promise<boolean> {
  if (
    !hasExactCurrentApproval(job, now) ||
    !job.approvalNonce ||
    !job.approvalStepUpAssertionId ||
    !job.approvalStepUpVerifiedAt ||
    !job.ownerApprovedAt ||
    !job.ownerApprovedById
  ) {
    return false;
  }
  const [event, stepUp] = await Promise.all([
    client.channelMaxAgentEvent.findUnique({
      where: {
        jobId_eventKey: {
          jobId: job.id,
          eventKey: `owner-approval:${job.approvalNonce}`,
        },
      },
    }),
    client.channelMaxStepUpAssertion.findUnique({
      where: { id: job.approvalStepUpAssertionId },
    }),
  ]);
  return (
    hasExactApprovalEvent(job, event) &&
    stepUp != null &&
    stepUp.userId === job.ownerApprovedById &&
    stepUp.jobId === job.id &&
    stepUp.method === job.approvalStepUpMethod &&
    stepUp.ceremonyId === job.approvalStepUpCeremonyId &&
    stepUp.verifiedAt.getTime() === job.approvalStepUpVerifiedAt.getTime() &&
    stepUp.verifiedAt.getTime() <= job.ownerApprovedAt.getTime() &&
    job.ownerApprovedAt.getTime() - stepUp.verifiedAt.getTime() <= 5 * 60_000 &&
    stepUp.expiresAt.getTime() > job.ownerApprovedAt.getTime() &&
    stepUp.usedAt?.getTime() === job.ownerApprovedAt.getTime()
  );
}

export async function createChannelMaxAgentJob(
  input: CreateChannelMaxAgentJobInput,
  requestedBy: string,
) {
  const digest = requestDigest(input);
  const planDigest = mutationPlanDigest(input);
  const existing = await prisma.channelMaxAgentJob.findUnique({
    where: { idempotencyKey: input.idempotency_key },
  });
  if (existing) {
    if (existing.requestSha256 !== digest) {
      throw new ChannelMaxAgentServiceError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key already belongs to a different ChannelMAX request.",
        409,
      );
    }
    return { created: false, idempotent_replay: true, job: publicJob(existing) };
  }
  const reconciliationTarget = await validateReconciliationRequest(input);
  if (reconciliationTarget) {
    const existingReconciliation = await prisma.channelMaxAgentJob.findUnique({
      where: { reconciliationTargetLock: reconciliationTarget.id },
    });
    if (existingReconciliation) {
      throw new ChannelMaxAgentServiceError(
        "RECONCILIATION_ALREADY_ACTIVE",
        `Reconciliation job ${existingReconciliation.id} already owns this target.`,
        409,
      );
    }
  }
  if (planDigest) {
    const duplicatePlan = await prisma.channelMaxAgentJob.findUnique({
      where: { mutationPlanLock: planDigest },
    });
    if (duplicatePlan) {
      throw new ChannelMaxAgentServiceError(
        "DUPLICATE_MUTATION_PLAN",
        `The exact mutation plan is already protected by job ${duplicatePlan.id} (${duplicatePlan.status}).`,
        409,
      );
    }
  }

  const payloadJson = stableJson(input.payload);
  const mutation = isMutationOperation(input.operation);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const job = await tx.channelMaxAgentJob.create({
        data: {
          operation: input.operation,
          mutation,
          status: mutation ? "PENDING_APPROVAL" : "QUEUED",
          priority: input.priority,
          accountId: input.payload.account_id,
          payloadJson,
          payloadSha256: sha256Json(input.payload),
          requestSha256: digest,
          mutationPlanSha256: planDigest,
          mutationPlanLock: planDigest,
          idempotencyKey: input.idempotency_key,
          requestedBy,
          maxAttempts: input.max_attempts,
          reconcilesJobId: reconciliationTarget?.id ?? null,
          reconciliationTargetLock: reconciliationTarget?.id ?? null,
        },
      });
      if (reconciliationTarget) {
        const linked = await tx.channelMaxAgentJob.updateMany({
          where: {
            id: reconciliationTarget.id,
            status: "AMBIGUOUS",
            reconciledByJobId: null,
          },
          data: { reconciledByJobId: job.id },
        });
        if (linked.count !== 1) {
          throw new ChannelMaxAgentServiceError(
            "RECONCILIATION_LINK_RACE",
            "Ambiguous mutation changed while reconciliation was queued.",
            409,
          );
        }
      }
      await appendStoredEvent(tx, job.id, {
        eventKey: `system:queued:${job.id}`,
        type: mutation ? "JOB_PENDING_APPROVAL" : "JOB_QUEUED",
        source: requestedBy,
        message: mutation
          ? `Created ${input.operation}; independent owner approval is required before claim.`
          : `Queued high-level ChannelMAX operation ${input.operation}.`,
        metadata: {
          operation: input.operation,
          mutation,
          payload_sha256: job.payloadSha256,
          request_sha256: digest,
          mutation_plan_sha256: planDigest,
        },
        occurredAt: job.createdAt,
      });
      return job;
    });
    return { created: true, idempotent_replay: false, job: publicJob(created) };
  } catch (error) {
    // A concurrent identical create can win the unique-key race. Re-read and
    // reconcile by digest; never turn a conflicting request into a replay.
    const raced = await prisma.channelMaxAgentJob.findUnique({
      where: { idempotencyKey: input.idempotency_key },
    });
    if (raced?.requestSha256 === digest) {
      return { created: false, idempotent_replay: true, job: publicJob(raced) };
    }
    if (raced) {
      throw new ChannelMaxAgentServiceError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was concurrently used for a different request.",
        409,
      );
    }
    if (planDigest) {
      const duplicatePlan = await prisma.channelMaxAgentJob.findUnique({
        where: { mutationPlanLock: planDigest },
      });
      if (duplicatePlan) {
        throw new ChannelMaxAgentServiceError(
          "DUPLICATE_MUTATION_PLAN",
          `The exact mutation plan is already protected by job ${duplicatePlan.id} (${duplicatePlan.status}).`,
          409,
        );
      }
    }
    throw error;
  }
}

export async function getChannelMaxAgentJob(id: string) {
  const job = await prisma.channelMaxAgentJob.findUnique({
    where: { id },
    include: { events: { orderBy: { sequence: "asc" } } },
  });
  if (!job) {
    throw new ChannelMaxAgentServiceError(
      "JOB_NOT_FOUND",
      "ChannelMAX agent job was not found.",
      404,
    );
  }
  return publicJob(job);
}

export async function createChannelMaxReconciliationJob(
  ambiguousJobId: string,
  input: CreateChannelMaxReconciliationInput,
  requestedBy: string,
) {
  const original = await prisma.channelMaxAgentJob.findUnique({
    where: { id: ambiguousJobId },
  });
  if (!original) {
    throw new ChannelMaxAgentServiceError(
      "JOB_NOT_FOUND",
      "Ambiguous ChannelMAX mutation job was not found.",
      404,
    );
  }
  const binding = uploadBindingFromJob(original);
  return createChannelMaxAgentJob(
    {
      operation: "RECONCILE_MUTATION",
      idempotency_key: input.idempotency_key,
      priority: input.priority,
      max_attempts: input.max_attempts,
      payload: {
        account_id: binding.account_id,
        expected_active_rows: binding.expected_active_rows,
        ambiguous_job_id: ambiguousJobId,
        assignment_sha256: binding.assignment_sha256,
        manual_model_id: binding.manual_model_id,
        manual_model_name: binding.manual_model_name,
        strategy: "UPLOAD_TASK_HISTORY_AND_INVENTORY_EXPORT",
      },
    },
    requestedBy,
  );
}

export async function cancelChannelMaxAgentJob(
  id: string,
  input: CancelChannelMaxAgentJobInput,
  actorId: string,
  now = new Date(),
) {
  const metadata = {
    reason: input.reason,
    cancelled_by: actorId,
  };
  const metadataSha = sha256Json(metadata);
  const existing = await prisma.channelMaxAgentEvent.findUnique({
    where: { jobId_eventKey: { jobId: id, eventKey: input.cancellation_key } },
  });
  if (existing) {
    const job = await prisma.channelMaxAgentJob.findUnique({ where: { id } });
    if (
      !job ||
      existing.type !== "JOB_CANCELLED" ||
      existing.metadataSha256 !== metadataSha ||
      job.status !== "CANCELLED"
    ) {
      throw new ChannelMaxAgentServiceError(
        "CANCELLATION_IDEMPOTENCY_CONFLICT",
        "cancellation_key is already bound to a different or incomplete action.",
        409,
      );
    }
    return {
      ok: true,
      idempotent_replay: true,
      job: publicJob(job),
      event: publicEvent(existing),
    };
  }

  const cancelled = await prisma.$transaction(async (tx) => {
    const job = await tx.channelMaxAgentJob.findUnique({ where: { id } });
    if (!job) {
      throw new ChannelMaxAgentServiceError(
        "JOB_NOT_FOUND",
        "ChannelMAX agent job was not found.",
        404,
      );
    }
    if (job.mutationStartedAt) {
      throw new ChannelMaxAgentServiceError(
        "CANCEL_AFTER_MUTATION_FENCE_FORBIDDEN",
        "Mutation already crossed MUTATION_STARTED; cancel is forbidden and reconciliation is required.",
        409,
      );
    }
    if (!["PENDING_APPROVAL", "QUEUED", "RUNNING"].includes(job.status)) {
      throw new ChannelMaxAgentServiceError(
        "CANCELLATION_STATE_INVALID",
        `Job status ${job.status} cannot be cancelled.`,
        409,
      );
    }
    const won = await tx.channelMaxAgentJob.updateMany({
      where: {
        id,
        status: { in: ["PENDING_APPROVAL", "QUEUED", "RUNNING"] },
        mutationStartedAt: null,
        completedAt: null,
      },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        cancelledBy: actorId,
        cancellationReason: input.reason,
        completedAt: now,
        mutationPlanLock: null,
        workerId: null,
        workerActorId: null,
        accountLeaseKey: null,
        browserLeaseKey: null,
        leaseTokenSha256: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        reconciliationTargetLock: null,
      },
    });
    if (won.count !== 1) {
      const latest = await tx.channelMaxAgentJob.findUnique({ where: { id } });
      if (latest?.mutationStartedAt) {
        throw new ChannelMaxAgentServiceError(
          "CANCEL_AFTER_MUTATION_FENCE_FORBIDDEN",
          "Mutation already crossed MUTATION_STARTED; cancel is forbidden and reconciliation is required.",
          409,
        );
      }
      throw new ChannelMaxAgentServiceError(
        "CANCELLATION_STATE_INVALID",
        `Job status ${latest?.status ?? "UNKNOWN"} cannot be cancelled.`,
        409,
      );
    }
    const updated = await tx.channelMaxAgentJob.findUniqueOrThrow({
      where: { id },
    });
    if (job.reconcilesJobId) {
      await tx.channelMaxAgentJob.updateMany({
        where: { id: job.reconcilesJobId, reconciledByJobId: job.id },
        data: { reconciledByJobId: null },
      });
    }
    const event = await appendStoredEvent(tx, id, {
      eventKey: input.cancellation_key,
      type: "JOB_CANCELLED",
      source: actorId,
      message: input.reason,
      metadata,
      occurredAt: now,
    });
    return { updated, event };
  });
  return {
    ok: true,
    idempotent_replay: false,
    job: publicJob(cancelled.updated),
    event: publicEvent(cancelled.event),
  };
}

export async function createChannelMaxPasswordStepUp(
  jobId: string,
  actorId: string,
  now = new Date(),
) {
  if (!channelMaxMutationApprovalEnabled()) {
    throw new ChannelMaxAgentServiceError(
      "MUTATION_APPROVAL_DISABLED",
      "ChannelMAX mutation approval is disabled until managed immutable evidence verification is implemented.",
      503,
    );
  }
  const job = await prisma.channelMaxAgentJob.findUnique({
    where: { id: jobId },
  });
  if (!job) {
    throw new ChannelMaxAgentServiceError(
      "JOB_NOT_FOUND",
      "ChannelMAX agent job was not found.",
      404,
    );
  }
  if (!job.mutation || job.status !== "PENDING_APPROVAL" || job.ownerApproved) {
    throw new ChannelMaxAgentServiceError(
      "STEP_UP_STATE_INVALID",
      "Password re-auth can be minted only for a pending, unapproved mutation job.",
      409,
    );
  }
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const assertion = await prisma.channelMaxStepUpAssertion.create({
    data: {
      userId: actorId,
      method: "PASSWORD_REAUTH",
      ceremonyId: randomBytes(24).toString("hex"),
      verifiedAt: now,
      expiresAt,
      jobId,
    },
  });
  return {
    assertion_id: assertion.id,
    method: assertion.method,
    ceremony_id: assertion.ceremonyId,
    verified_at: assertion.verifiedAt.toISOString(),
    expires_at: assertion.expiresAt.toISOString(),
    job_id: jobId,
  };
}

export async function approveChannelMaxAgentJob(
  id: string,
  input: ApproveChannelMaxAgentJobInput,
  approver: { actor: string; actorId: string },
  now = new Date(),
) {
  if (!channelMaxMutationApprovalEnabled()) {
    throw new ChannelMaxAgentServiceError(
      "MUTATION_APPROVAL_DISABLED",
      "ChannelMAX mutation approval is disabled until managed immutable evidence verification is implemented.",
      503,
    );
  }
  const preflight = await prisma.channelMaxAgentJob.findUnique({
    where: { id },
  });
  if (!preflight) {
    throw new ChannelMaxAgentServiceError(
      "JOB_NOT_FOUND",
      "ChannelMAX agent job was not found.",
      404,
    );
  }
  if (!preflight.mutation) {
    throw new ChannelMaxAgentServiceError(
      "APPROVAL_NOT_APPLICABLE",
      "Read-only ChannelMAX jobs do not accept owner approval.",
      409,
    );
  }
  if (input.job_id !== id) {
    throw new ChannelMaxAgentServiceError(
      "APPROVAL_JOB_MISMATCH",
      "Approval job_id does not match the route job.",
      409,
    );
  }
  if (Date.parse(input.expires_at) <= now.getTime()) {
    throw new ChannelMaxAgentServiceError(
      "APPROVAL_EXPIRED",
      "Owner approval expiry has already passed.",
      409,
    );
  }
  if (approver.actorId.startsWith("system:")) {
    throw new ChannelMaxAgentServiceError(
      "OWNER_SESSION_REQUIRED",
      "Synthetic API identities cannot grant independent ChannelMAX owner approval.",
      403,
    );
  }
  if (!hasCanonicalStoredRequest(preflight)) {
    throw new ChannelMaxAgentServiceError(
      "STORED_REQUEST_DIGEST_INVALID",
      "Stored mutation payload/request digests do not match their canonical content.",
      409,
    );
  }
  const binding = uploadBindingFromJob(preflight);
  const suppliedBinding = {
    schema_version: input.schema_version,
    job_id: input.job_id,
    operation: input.operation,
    account_id: input.account_id,
    manual_model_id: input.manual_model_id,
    manual_model_name: input.manual_model_name,
    expected_active_rows: input.expected_active_rows,
    assignment_sha256: input.assignment_sha256,
    payload_sha256: input.payload_sha256,
    request_sha256: input.request_sha256,
    mutation_plan_sha256: input.mutation_plan_sha256,
  };
  if (stableJson(binding) !== stableJson(suppliedBinding)) {
    throw new ChannelMaxAgentServiceError(
      "APPROVAL_BINDING_MISMATCH",
      "Owner approval does not exactly match the stored canonical mutation plan.",
      409,
    );
  }

  const stepUp = await prisma.channelMaxStepUpAssertion.findUnique({
    where: { id: input.step_up_assertion_id },
  });
  const replayStepUpMatches =
    preflight.ownerApproved &&
    stepUp != null &&
    preflight.approvalStepUpAssertionId === stepUp.id &&
    stepUp.usedAt?.getTime() === preflight.ownerApprovedAt?.getTime();
  if (
    !stepUp ||
    stepUp.userId !== approver.actorId ||
    stepUp.jobId !== id ||
    (!replayStepUpMatches && stepUp.usedAt != null) ||
    (!replayStepUpMatches && stepUp.expiresAt.getTime() <= now.getTime()) ||
    (!replayStepUpMatches && stepUp.verifiedAt.getTime() > now.getTime()) ||
    (!replayStepUpMatches &&
      now.getTime() - stepUp.verifiedAt.getTime() > 5 * 60_000) ||
    !["PASSWORD_REAUTH", "WEBAUTHN", "TOTP"].includes(stepUp.method)
  ) {
    throw new ChannelMaxAgentServiceError(
      "STEP_UP_PROOF_INVALID",
      "Owner approval requires a fresh, unused step-up assertion bound to this user and job.",
      403,
    );
  }

  if (preflight.ownerApproved) {
    const stored = parseStoredJson(preflight.approvalSubjectJson) as Record<
      string,
      unknown
    >;
    const replayMatches =
      stored &&
      stableJson({
        ...suppliedBinding,
        expires_at: input.expires_at,
        nonce: input.nonce,
        step_up_assertion_id: input.step_up_assertion_id,
      }) ===
        stableJson({
          ...binding,
          expires_at: stored.expires_at,
          nonce: stored.nonce,
          step_up_assertion_id: stored.step_up_assertion_id,
        }) &&
      stored.approved_by === approver.actor &&
      stored.approved_by_id === approver.actorId;
    if (!replayMatches) {
      throw new ChannelMaxAgentServiceError(
        "APPROVAL_ALREADY_EXISTS",
        "This job already has a different sealed owner approval.",
        409,
      );
    }
    return {
      approved: true,
      idempotent_replay: true,
      job: publicJob(preflight),
    };
  }
  if (preflight.status !== "PENDING_APPROVAL") {
    throw new ChannelMaxAgentServiceError(
      "APPROVAL_STATE_INVALID",
      `Job status ${preflight.status} cannot be owner-approved.`,
      409,
    );
  }

  const approvedAt = now;
  const subject = approvalSubject(
    preflight,
    input,
    approver.actor,
    approver.actorId,
    stepUp,
    approvedAt,
  );
  const subjectJson = stableJson(subject);
  const subjectSha256 = sha256Json(subject);
  try {
    const approved = await prisma.$transaction(async (tx) => {
      const consumed = await tx.channelMaxStepUpAssertion.updateMany({
        where: {
          id: stepUp.id,
          userId: approver.actorId,
          jobId: id,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: approvedAt },
      });
      if (consumed.count !== 1) {
        throw new ChannelMaxAgentServiceError(
          "STEP_UP_PROOF_ALREADY_USED",
          "Step-up assertion was consumed or expired before approval committed.",
          409,
        );
      }
      const won = await tx.channelMaxAgentJob.updateMany({
        where: {
          id,
          status: "PENDING_APPROVAL",
          ownerApproved: false,
        },
        data: {
          status: "QUEUED",
          queuedAt: now,
          ownerApproved: true,
          ownerApprovedBy: approver.actor,
          ownerApprovedById: approver.actorId,
          ownerApprovedAt: approvedAt,
          assignmentArtifactSha256: input.assignment_sha256,
          approvalSubjectJson: subjectJson,
          approvalSha256: subjectSha256,
          approvalExpiresAt: new Date(input.expires_at),
          approvalNonce: input.nonce,
          approvalStepUpAssertionId: stepUp.id,
          approvalStepUpMethod: stepUp.method,
          approvalStepUpCeremonyId: stepUp.ceremonyId,
          approvalStepUpVerifiedAt: stepUp.verifiedAt,
          error: null,
        },
      });
      if (won.count !== 1) {
        throw new ChannelMaxAgentServiceError(
          "APPROVAL_RACE",
          "Job changed while owner approval was being sealed.",
          409,
        );
      }
      const job = await tx.channelMaxAgentJob.findUniqueOrThrow({
        where: { id },
      });
      await appendStoredEvent(tx, id, {
        eventKey: `owner-approval:${input.nonce}`,
        type: "OWNER_APPROVED",
        source: approver.actorId,
        message: "Owner approved the exact sealed ChannelMAX mutation plan.",
        metadata: {
          approval_sha256: subjectSha256,
          approval_subject: subject,
        },
        occurredAt: now,
      });
      return job;
    });
    return {
      approved: true,
      idempotent_replay: false,
      approval_sha256: subjectSha256,
      job: publicJob(approved),
    };
  } catch (error) {
    if (error instanceof ChannelMaxAgentServiceError) throw error;
    const nonceOwner = await prisma.channelMaxAgentJob.findFirst({
      where: { approvalNonce: input.nonce },
      select: { id: true },
    });
    if (nonceOwner && nonceOwner.id !== id) {
      throw new ChannelMaxAgentServiceError(
        "APPROVAL_NONCE_REUSED",
        "Owner approval nonce is already bound to another job.",
        409,
      );
    }
    throw error;
  }
}

async function expireOneJob(id: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.channelMaxAgentJob.findUnique({ where: { id } });
    if (
      !job ||
      job.status !== "RUNNING" ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt.getTime() > now.getTime()
    ) {
      return false;
    }

    const decision = classifyExpiredChannelMaxLease({
      mutation: job.mutation,
      mutationStarted: job.mutationStartedAt != null,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    });
    const common = {
      workerId: null,
      workerActorId: null,
      accountLeaseKey: null,
      browserLeaseKey: null,
      leaseTokenSha256: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
    };
    const updateData =
      decision === "AMBIGUOUS"
        ? {
            ...common,
            status: "AMBIGUOUS",
            mutationOutcome: "AMBIGUOUS",
            ambiguityReason:
              "Worker lease expired after MUTATION_STARTED; external state is unknown and automatic retry is forbidden.",
            error:
              "Mutation outcome is ambiguous. Read back ChannelMAX state before any new upload.",
            completedAt: now,
          }
        : decision === "REQUEUE"
          ? {
              ...common,
              status: "QUEUED",
              queuedAt: now,
              error:
                "Worker lease expired before a mutation fence; safely requeued.",
            }
          : {
              ...common,
              status: "FAILED",
              mutationOutcome: job.mutation
                ? "CONFIRMED_NOT_APPLIED"
                : null,
              error: "Worker lease expired and maximum attempts were exhausted.",
              completedAt: now,
              mutationPlanLock: job.mutation ? null : job.mutationPlanLock,
              reconciliationTargetLock: job.reconcilesJobId
                ? null
                : job.reconciliationTargetLock,
            };
    const won = await tx.channelMaxAgentJob.updateMany({
      where: {
        id: job.id,
        status: "RUNNING",
        leaseTokenSha256: job.leaseTokenSha256,
        leaseExpiresAt: job.leaseExpiresAt,
        attempts: job.attempts,
        mutationStartedAt: job.mutationStartedAt,
        mutationOutcome: job.mutationOutcome,
      },
      data: updateData,
    });
    if (won.count !== 1) return false;
    if (decision === "FAILED" && job.reconcilesJobId) {
      await tx.channelMaxAgentJob.updateMany({
        where: { id: job.reconcilesJobId, reconciledByJobId: job.id },
        data: { reconciledByJobId: null },
      });
    }
    await appendStoredEvent(tx, job.id, {
      eventKey: `system:lease-expired:${job.attempts}`,
      type: `LEASE_EXPIRED_${decision}`,
      source: "system:channelmax-queue",
      message:
        decision === "AMBIGUOUS"
          ? "Lease expired after the external-write fence; job stopped as ambiguous."
          : `Lease expired; queue decision: ${decision}.`,
      metadata: {
        decision,
        attempt: job.attempts,
        mutation_started: job.mutationStartedAt != null,
      },
      occurredAt: now,
    });
    return true;
  });
}

export async function reapExpiredChannelMaxAgentJobs(
  now = new Date(),
): Promise<number> {
  const expired = await prisma.channelMaxAgentJob.findMany({
    where: {
      status: "RUNNING",
      leaseExpiresAt: { lte: now },
    },
    select: { id: true },
    take: 100,
  });
  let settled = 0;
  for (const row of expired) {
    if (await expireOneJob(row.id, now)) settled += 1;
  }
  return settled;
}

async function failJobWithInvalidApproval(id: string, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await tx.channelMaxAgentJob.findUnique({ where: { id } });
    if (!job || job.status !== "QUEUED" || !job.mutation) return;
    await tx.channelMaxAgentJob.update({
      where: { id },
      data: {
        status: "FAILED",
        error:
          "Independent owner approval is missing, expired, or no longer exactly matches the canonical mutation plan.",
        completedAt: now,
        mutationPlanLock: null,
      },
    });
    await appendStoredEvent(tx, id, {
      eventKey: `system:approval-invalid:${now.getTime()}`,
      type: "APPROVAL_INVALID",
      source: "system:channelmax-queue",
      message:
        "Mutation claim was refused because its independent approval was not current and exact.",
      metadata: {
        payload_sha256: job.payloadSha256,
        request_sha256: job.requestSha256,
        approval_sha256: job.approvalSha256,
        approval_expires_at: iso(job.approvalExpiresAt),
      },
      occurredAt: now,
    });
  });
}

export async function claimChannelMaxAgentJob(
  input: ClaimChannelMaxAgentJobInput,
  actorId: string,
  now = new Date(),
) {
  const reaped = await reapExpiredChannelMaxAgentJobs(now);

  for (let race = 0; race < 8; race += 1) {
    const candidate = await prisma.channelMaxAgentJob.findFirst({
      where: {
        status: "QUEUED",
        operation: { in: input.supported_operations },
      },
      orderBy: [{ priority: "desc" }, { queuedAt: "asc" }],
    });
    if (!candidate) return { claimed: false, reaped, job: null };

    if (candidate.mutation) assertMutationExecutionReleaseGate();

    const accountBusy = await prisma.channelMaxAgentJob.findFirst({
      where: {
        status: "RUNNING",
        OR: [
          { accountLeaseKey: candidate.accountId },
          { browserLeaseKey: CHANNELMAX_BROWSER_LEASE_KEY },
        ],
      },
      select: { id: true },
    });
    if (accountBusy) {
      return {
        claimed: false,
        reaped,
        busy: true,
        busy_job_id: accountBusy.id,
        job: null,
      };
    }

    if (
      candidate.mutation &&
      (!(await hasSealedCurrentApproval(prisma, candidate, now)) ||
        !candidate.approvalExpiresAt ||
        candidate.approvalExpiresAt.getTime() - now.getTime() < 30_000)
    ) {
      await failJobWithInvalidApproval(candidate.id, now);
      continue;
    }

    const leaseToken = randomBytes(32).toString("hex");
    const requestedLeaseEnd = now.getTime() + input.lease_seconds * 1_000;
    const leaseExpiresAt = new Date(
      candidate.mutation && candidate.approvalExpiresAt
        ? Math.min(requestedLeaseEnd, candidate.approvalExpiresAt.getTime())
        : requestedLeaseEnd,
    );
    let claimed: typeof candidate | null = null;
    try {
      claimed = await prisma.$transaction(async (tx) => {
        if (candidate.mutation) assertMutationExecutionReleaseGate();
        const won = await tx.channelMaxAgentJob.updateMany({
          where: { id: candidate.id, status: "QUEUED" },
          data: {
            status: "RUNNING",
            workerId: input.worker_id,
            workerActorId: actorId,
            accountLeaseKey: candidate.accountId,
            browserLeaseKey: CHANNELMAX_BROWSER_LEASE_KEY,
            leaseTokenSha256: tokenSha256(leaseToken),
            leaseExpiresAt,
            lastHeartbeatAt: now,
            attempts: { increment: 1 },
            startedAt: candidate.startedAt ?? now,
            error: null,
          },
        });
        if (won.count !== 1) return null;
        const job = await tx.channelMaxAgentJob.findUniqueOrThrow({
          where: { id: candidate.id },
        });
        await appendStoredEvent(tx, job.id, {
          eventKey: `system:claimed:${job.attempts}`,
          type: "JOB_CLAIMED",
          source: actorId,
          message: `Claimed by ${input.worker_id}.`,
          metadata: {
            attempt: job.attempts,
            worker_id: input.worker_id,
            worker_actor_id: actorId,
            lease_expires_at: leaseExpiresAt.toISOString(),
          },
          occurredAt: now,
        });
        return job;
      });
    } catch (error) {
      const lockWinner = await prisma.channelMaxAgentJob.findFirst({
        where: {
          status: "RUNNING",
          OR: [
            { accountLeaseKey: candidate.accountId },
            { browserLeaseKey: CHANNELMAX_BROWSER_LEASE_KEY },
          ],
        },
        select: { id: true },
      });
      if (lockWinner && lockWinner.id !== candidate.id) continue;
      throw error;
    }
    if (!claimed) continue;

    return {
      claimed: true,
      reaped,
      lease_token: leaseToken,
      lease_expires_at: leaseExpiresAt.toISOString(),
      job: publicJob(claimed),
      protocol: claimed.mutation
        ? {
            before_external_write:
              "POST MUTATION_STARTED and wait for its successful acknowledgement; otherwise DO NOT click Upload/Submit.",
            after_external_write:
              "Report CONFIRMED_APPLIED, CONFIRMED_NOT_APPLIED, or AMBIGUOUS with evidence; never guess and never retry an ambiguous mutation.",
          }
        : {
            read_only: true,
            external_writes_forbidden: true,
          },
    };
  }

  throw new ChannelMaxAgentServiceError(
    "CLAIM_CONTENTION",
    "Could not claim a ChannelMAX job because of concurrent workers; retry.",
    409,
  );
}

async function requireActiveLease(
  id: string,
  leaseToken: string,
  actorId: string,
  now: Date,
) {
  const job = await prisma.channelMaxAgentJob.findUnique({ where: { id } });
  if (!job) {
    throw new ChannelMaxAgentServiceError(
      "JOB_NOT_FOUND",
      "ChannelMAX agent job was not found.",
      404,
    );
  }
  if (job.status !== "RUNNING") {
    throw new ChannelMaxAgentServiceError(
      "JOB_NOT_RUNNING",
      `Job is ${job.status}; its worker lease is no longer active.`,
      409,
    );
  }
  if (!safeDigestEqual(job.leaseTokenSha256, tokenSha256(leaseToken))) {
    throw new ChannelMaxAgentServiceError(
      "LEASE_TOKEN_INVALID",
      "Lease token is invalid.",
      403,
    );
  }
  if (!job.workerActorId || job.workerActorId !== actorId) {
    throw new ChannelMaxAgentServiceError(
      "WORKER_IDENTITY_MISMATCH",
      "The authenticated API identity does not own this worker lease.",
      403,
    );
  }
  if (!job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= now.getTime()) {
    await expireOneJob(job.id, now);
    const settled = await prisma.channelMaxAgentJob.findUnique({
      where: { id: job.id },
      select: { status: true },
    });
    throw new ChannelMaxAgentServiceError(
      settled?.status === "AMBIGUOUS" ? "MUTATION_AMBIGUOUS" : "LEASE_EXPIRED",
      settled?.status === "AMBIGUOUS"
        ? "Lease expired after MUTATION_STARTED; job is blocked as ambiguous."
        : "Lease expired; this worker must stop and claim again if the job is requeued.",
      409,
    );
  }
  return job;
}

function managedEvidencePublicRef(evidence: {
  kind: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  capturedAt: Date;
  uri: string;
}): ChannelMaxEvidenceRef {
  return {
    kind: evidence.kind as ChannelMaxEvidenceRef["kind"],
    sha256: evidence.sha256,
    byte_size: evidence.byteSize,
    media_type: evidence.mediaType,
    captured_at: evidence.capturedAt.toISOString(),
    uri: evidence.uri,
  };
}

async function assertManagedEvidenceRefs(
  client: Pick<Prisma.TransactionClient, "channelMaxAgentEvidence">,
  jobId: string,
  refs: ChannelMaxEvidenceRef[],
): Promise<void> {
  if (refs.length === 0) return;
  if (refs.some((ref) => !ref.uri)) {
    throw new ChannelMaxAgentServiceError(
      "MANAGED_EVIDENCE_REQUIRED",
      "Every evidence reference must use an SSCC-managed immutable HTTPS URI.",
      409,
    );
  }
  const uris = refs.map((ref) => ref.uri as string);
  const rows = await client.channelMaxAgentEvidence.findMany({
    where: { jobId, uri: { in: uris } },
  });
  const byUri = new Map(rows.map((row) => [row.uri, row]));
  for (const ref of refs) {
    const row = byUri.get(ref.uri as string);
    const computedSha = row
      ? createHash("sha256").update(row.content).digest("hex")
      : null;
    if (
      !row ||
      row.kind !== ref.kind ||
      row.sha256 !== ref.sha256 ||
      computedSha !== ref.sha256 ||
      row.byteSize !== ref.byte_size ||
      row.content.byteLength !== ref.byte_size ||
      row.mediaType !== ref.media_type.toLowerCase() ||
      row.capturedAt.toISOString() !== ref.captured_at
    ) {
      throw new ChannelMaxAgentServiceError(
        "MANAGED_EVIDENCE_MISMATCH",
        "Evidence metadata does not exactly match immutable bytes stored by SSCC for this job.",
        409,
      );
    }
  }
}

export async function storeChannelMaxAgentEvidence(
  id: string,
  input: ChannelMaxManagedEvidenceUploadInput,
  content: Uint8Array,
  actorId: string,
  evidenceBaseUrl: string,
  now = new Date(),
) {
  if (
    content.byteLength < 1 ||
    content.byteLength > CHANNELMAX_MANAGED_EVIDENCE_MAX_BYTES
  ) {
    throw new ChannelMaxAgentServiceError(
      "EVIDENCE_SIZE_INVALID",
      `Managed evidence must contain 1-${CHANNELMAX_MANAGED_EVIDENCE_MAX_BYTES} bytes.`,
      413,
    );
  }
  let base: URL;
  try {
    base = new URL(evidenceBaseUrl);
  } catch {
    throw new ChannelMaxAgentServiceError(
      "EVIDENCE_BASE_URL_INVALID",
      "Managed evidence storage requires a valid HTTPS SSCC base URL.",
      503,
    );
  }
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new ChannelMaxAgentServiceError(
      "EVIDENCE_BASE_URL_INVALID",
      "Managed evidence storage requires an HTTPS SSCC base URL without embedded credentials.",
      503,
    );
  }

  const active = await requireActiveLease(
    id,
    input.lease_token,
    actorId,
    now,
  );
  try {
    await assertChannelMaxManagedEvidenceContent(input, content, active);
  } catch (error) {
    if (error instanceof ChannelMaxEvidenceContentError) {
      throw new ChannelMaxAgentServiceError(error.code, error.message, 400);
    }
    throw error;
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const capturedAt = new Date(input.captured_at);
  const existing = await prisma.channelMaxAgentEvidence.findUnique({
    where: { jobId_kind_sha256: { jobId: id, kind: input.kind, sha256 } },
  });
  if (existing) {
    if (
      existing.uploadedBy !== actorId ||
      existing.mediaType !== input.media_type ||
      existing.byteSize !== content.byteLength ||
      existing.capturedAt.toISOString() !== input.captured_at ||
      createHash("sha256").update(existing.content).digest("hex") !== sha256
    ) {
      throw new ChannelMaxAgentServiceError(
        "EVIDENCE_IDEMPOTENCY_CONFLICT",
        "The same job/kind/digest evidence key already has different immutable metadata.",
        409,
      );
    }
    return {
      ok: true,
      idempotent_replay: true,
      job_id: id,
      evidence: managedEvidencePublicRef(existing),
    };
  }

  const evidenceId = randomUUID();
  const uri = new URL(
    `/api/openclaw/channelmax/jobs/${encodeURIComponent(id)}/evidence/${encodeURIComponent(evidenceId)}`,
    base.origin,
  ).toString();
  try {
    const stored = await prisma.$transaction(async (tx) => {
      const current = await tx.channelMaxAgentJob.findUnique({
        where: { id },
      });
      if (
        !current ||
        current.status !== "RUNNING" ||
        current.workerActorId !== actorId ||
        current.leaseTokenSha256 !== active.leaseTokenSha256 ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        throw new ChannelMaxAgentServiceError(
          "LEASE_LOST",
          "Worker lease changed before managed evidence could be stored.",
          409,
        );
      }
      const usage = await tx.channelMaxAgentEvidence.aggregate({
        where: { jobId: id },
        _count: { _all: true },
        _sum: { byteSize: true },
      });
      if (
        usage._count._all >=
          CHANNELMAX_MANAGED_EVIDENCE_MAX_ITEMS_PER_JOB ||
        (usage._sum.byteSize ?? 0) + content.byteLength >
          CHANNELMAX_MANAGED_EVIDENCE_MAX_TOTAL_BYTES_PER_JOB
      ) {
        throw new ChannelMaxAgentServiceError(
          "EVIDENCE_JOB_QUOTA_EXCEEDED",
          "Managed evidence exceeds the per-job item or byte quota.",
          413,
        );
      }
      return tx.channelMaxAgentEvidence.create({
        data: {
          id: evidenceId,
          jobId: id,
          kind: input.kind,
          sha256,
          byteSize: content.byteLength,
          mediaType: input.media_type,
          capturedAt,
          uri,
          content: Uint8Array.from(content),
          uploadedBy: actorId,
        },
      });
    });
    return {
      ok: true,
      idempotent_replay: false,
      job_id: id,
      evidence: managedEvidencePublicRef(stored),
    };
  } catch (error) {
    const winner = await prisma.channelMaxAgentEvidence.findUnique({
      where: { jobId_kind_sha256: { jobId: id, kind: input.kind, sha256 } },
    });
    if (
      winner &&
      winner.uploadedBy === actorId &&
      winner.mediaType === input.media_type &&
      winner.byteSize === content.byteLength &&
      winner.capturedAt.toISOString() === input.captured_at &&
      createHash("sha256").update(winner.content).digest("hex") === sha256
    ) {
      return {
        ok: true,
        idempotent_replay: true,
        job_id: id,
        evidence: managedEvidencePublicRef(winner),
      };
    }
    throw error;
  }
}

export async function getChannelMaxAgentEvidence(
  jobId: string,
  evidenceId: string,
) {
  const evidence = await prisma.channelMaxAgentEvidence.findFirst({
    where: { id: evidenceId, jobId },
  });
  if (!evidence) {
    throw new ChannelMaxAgentServiceError(
      "EVIDENCE_NOT_FOUND",
      "Managed ChannelMAX evidence was not found for this job.",
      404,
    );
  }
  const computedSha = createHash("sha256").update(evidence.content).digest("hex");
  if (
    computedSha !== evidence.sha256 ||
    evidence.content.byteLength !== evidence.byteSize
  ) {
    throw new ChannelMaxAgentServiceError(
      "EVIDENCE_INTEGRITY_FAILURE",
      "Stored ChannelMAX evidence failed its server-side integrity check.",
      500,
    );
  }
  return evidence;
}

export async function heartbeatChannelMaxAgentJob(
  id: string,
  input: ChannelMaxHeartbeatInput,
  actorId: string,
  now = new Date(),
) {
  const job = await requireActiveLease(id, input.lease_token, actorId, now);
  const leaseWindowMs = Math.max(
    30_000,
    Math.min(
      300_000,
      (job.leaseExpiresAt?.getTime() ?? now.getTime()) -
        (job.lastHeartbeatAt?.getTime() ?? now.getTime()),
    ),
  );
  const requestedLeaseEnd = now.getTime() + leaseWindowMs;
  const leaseExpiresAt = new Date(
    job.mutation && job.approvalExpiresAt
      ? Math.min(requestedLeaseEnd, job.approvalExpiresAt.getTime())
      : requestedLeaseEnd,
  );
  const updated = await prisma.channelMaxAgentJob.updateMany({
    where: {
      id,
      status: "RUNNING",
      leaseTokenSha256: job.leaseTokenSha256,
      leaseExpiresAt: { gt: now },
    },
    data: { lastHeartbeatAt: now, leaseExpiresAt },
  });
  if (updated.count !== 1) {
    throw new ChannelMaxAgentServiceError(
      "LEASE_LOST",
      "Worker lease changed while heartbeating; stop this execution.",
      409,
    );
  }
  return {
    ok: true,
    job_id: id,
    phase: input.phase,
    progress_percent: input.progress_percent ?? null,
    lease_expires_at: leaseExpiresAt.toISOString(),
  };
}

function workerEventMetadata(
  input: ChannelMaxWorkerEventInput,
  job: ApprovalBoundJob,
) {
  return {
    type: input.type,
    occurred_at: input.occurred_at,
    ...(input.message ? { message: input.message } : {}),
    ...(input.step ? { step: input.step } : {}),
    ...(input.progress_percent !== undefined
      ? { progress_percent: input.progress_percent }
      : {}),
    job_binding: approvalBindingForEvents(job),
  };
}

function mutationOutcomeForEvent(type: string): string | null {
  if (type === "MUTATION_CONFIRMED") return "CONFIRMED_APPLIED";
  if (type === "MUTATION_NOT_APPLIED") return "CONFIRMED_NOT_APPLIED";
  if (type === "MUTATION_AMBIGUOUS") return "AMBIGUOUS";
  return null;
}

function assertMutationEventEvidence(
  job: ApprovalBoundJob,
  input: ChannelMaxWorkerEventInput,
): void {
  if (input.type !== "MUTATION_STARTED") return;
  const payload = canonicalStoredPayload(job) as {
    assignment_artifact?: {
      sha256?: unknown;
      byte_size?: unknown;
    };
  } | null;
  const source = input.evidence.find(
    (item) => item.kind === "UPLOAD_SOURCE",
  );
  if (
    !source ||
    source.sha256 !== job.assignmentArtifactSha256 ||
    source.sha256 !== payload?.assignment_artifact?.sha256 ||
    source.byte_size !== payload.assignment_artifact.byte_size
  ) {
    throw new ChannelMaxAgentServiceError(
      "UPLOAD_SOURCE_EVIDENCE_MISMATCH",
      "MUTATION_STARTED requires UPLOAD_SOURCE evidence matching the exact approved artifact SHA and byte size.",
      409,
    );
  }
}

export async function appendChannelMaxAgentEvent(
  id: string,
  input: ChannelMaxWorkerEventInput,
  actorId: string,
  now = new Date(),
) {
  const preflight = await prisma.channelMaxAgentJob.findUnique({
    where: { id },
  });
  if (!preflight) {
    throw new ChannelMaxAgentServiceError(
      "JOB_NOT_FOUND",
      "ChannelMAX agent job was not found.",
      404,
    );
  }
  if (input.type === "MUTATION_STARTED") {
    assertMutationExecutionReleaseGate();
  }
  const metadata = workerEventMetadata(input, preflight);
  const metadataSha = sha256Json(metadata);
  const evidenceSha = sha256Json(input.evidence);
  const replay = await prisma.channelMaxAgentEvent.findUnique({
    where: { jobId_eventKey: { jobId: id, eventKey: input.event_key } },
  });
  if (replay) {
    if (
      replay.metadataSha256 !== metadataSha ||
      replay.evidenceSha256 !== evidenceSha
    ) {
      throw new ChannelMaxAgentServiceError(
        "EVENT_IDEMPOTENCY_CONFLICT",
        "event_key already exists with different metadata/evidence.",
        409,
      );
    }
    // A successful MUTATION_STARTED response is the worker's permission to
    // perform the external click. Never replay that acknowledgement after the
    // lease or exact approval has expired, even though ordinary audit-event
    // replays remain readable after a job becomes terminal.
    if (input.type === "MUTATION_STARTED") {
      assertMutationExecutionReleaseGate();
      const active = await requireActiveLease(
        id,
        input.lease_token,
        actorId,
        now,
      );
      if (!(await hasSealedCurrentApproval(prisma, active, now))) {
        throw new ChannelMaxAgentServiceError(
          "APPROVAL_INVALID",
          "MUTATION_STARTED replay refused because the exact owner approval is no longer current.",
          409,
        );
      }
    }
    return {
      ok: true,
      idempotent_replay: true,
      job_id: id,
      job_status: preflight.status,
      event: publicEvent(replay),
    };
  }
  await requireActiveLease(id, input.lease_token, actorId, now);

  const result = await prisma.$transaction(async (tx) => {
    const job = await tx.channelMaxAgentJob.findUnique({ where: { id } });
    if (!job || job.status !== "RUNNING") {
      throw new ChannelMaxAgentServiceError(
        "JOB_NOT_RUNNING",
        "Job is no longer running.",
        409,
      );
    }
    if (!safeDigestEqual(job.leaseTokenSha256, tokenSha256(input.lease_token))) {
      throw new ChannelMaxAgentServiceError(
        "LEASE_TOKEN_INVALID",
        "Lease token is invalid.",
        403,
      );
    }
    if (!job.workerActorId || job.workerActorId !== actorId) {
      throw new ChannelMaxAgentServiceError(
        "WORKER_IDENTITY_MISMATCH",
        "The authenticated API identity does not own this worker lease.",
        403,
      );
    }
    if (!job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= now.getTime()) {
      throw new ChannelMaxAgentServiceError(
        "LEASE_EXPIRED",
        "Lease expired before the event could be committed.",
        409,
      );
    }
    if (input.type === "MUTATION_STARTED") {
      assertMutationExecutionReleaseGate();
    }
    await assertManagedEvidenceRefs(tx, id, input.evidence);
    const prior = await tx.channelMaxAgentEvent.findUnique({
      where: { jobId_eventKey: { jobId: id, eventKey: input.event_key } },
    });
    if (prior) {
      if (
        prior.metadataSha256 !== metadataSha ||
        prior.evidenceSha256 !== evidenceSha
      ) {
        throw new ChannelMaxAgentServiceError(
          "EVENT_IDEMPOTENCY_CONFLICT",
          "event_key already exists with different metadata/evidence.",
          409,
        );
      }
      return { event: prior, idempotent: true, status: job.status };
    }

    const isMutationEvent = input.type.startsWith("MUTATION_");
    if (isMutationEvent && !job.mutation) {
      throw new ChannelMaxAgentServiceError(
        "MUTATION_EVENT_FORBIDDEN",
        "Read-only ChannelMAX jobs cannot emit mutation events.",
        409,
      );
    }
    if (
      isMutationEvent &&
      !(await hasSealedCurrentApproval(tx, job, now))
    ) {
      throw new ChannelMaxAgentServiceError(
        "APPROVAL_INVALID",
        "Mutation event refused because the independent owner approval is expired or no longer exactly matches the job.",
        409,
      );
    }
    if (isMutationEvent) assertMutationEventEvidence(job, input);
    if (
      (input.type === "MUTATION_CONFIRMED" ||
        input.type === "MUTATION_AMBIGUOUS") &&
      !job.mutationStartedAt
    ) {
      throw new ChannelMaxAgentServiceError(
        "MUTATION_FENCE_MISSING",
        `${input.type} requires a previously acknowledged MUTATION_STARTED event.`,
        409,
      );
    }
    if (input.type === "MUTATION_STARTED" && job.mutationStartedAt) {
      throw new ChannelMaxAgentServiceError(
        "MUTATION_ALREADY_STARTED",
        "A different MUTATION_STARTED event was already accepted; do not click twice.",
        409,
      );
    }
    if (input.type === "MUTATION_STARTED" && job.mutationOutcome) {
      throw new ChannelMaxAgentServiceError(
        "MUTATION_OUTCOME_ALREADY_REPORTED",
        "Cannot start a mutation after an external outcome was already reported.",
        409,
      );
    }

    const reportedOutcome = mutationOutcomeForEvent(input.type);
    const conflictingOutcome =
      reportedOutcome != null &&
      job.mutationOutcome != null &&
      reportedOutcome !== job.mutationOutcome;

    if (input.type === "MUTATION_STARTED") {
      const fenced = await tx.channelMaxAgentJob.updateMany({
        where: {
          id,
          status: "RUNNING",
          leaseTokenSha256: job.leaseTokenSha256,
          workerActorId: actorId,
          leaseExpiresAt: job.leaseExpiresAt,
          mutationStartedAt: null,
          mutationOutcome: null,
        },
        data: { mutationStartedAt: new Date(input.occurred_at) },
      });
      if (fenced.count !== 1) {
        throw new ChannelMaxAgentServiceError(
          "MUTATION_FENCE_RACE_LOST",
          "Job state changed before MUTATION_STARTED could be fenced; do not perform the external click.",
          409,
        );
      }
    }

    const event = await appendStoredEvent(tx, id, {
      eventKey: input.event_key,
      type: input.type,
      source: job.workerActorId ?? actorId,
      message: input.message,
      metadata,
      evidence: input.evidence,
      occurredAt: new Date(input.occurred_at),
    });

    let status = job.status;
    if (input.type === "MUTATION_AMBIGUOUS" || conflictingOutcome) {
      status = "AMBIGUOUS";
      await tx.channelMaxAgentJob.update({
        where: { id },
        data: {
          status,
          mutationOutcome: "AMBIGUOUS",
          ambiguityReason:
            conflictingOutcome
              ? `Conflicting mutation outcomes: ${job.mutationOutcome} then ${reportedOutcome}.`
              : (input.message ??
                "Worker reported an ambiguous external mutation."),
          error:
            "Mutation outcome is ambiguous. Read back ChannelMAX state before any new upload.",
          completedAt: now,
          workerId: null,
          workerActorId: null,
          accountLeaseKey: null,
          browserLeaseKey: null,
          leaseTokenSha256: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
        },
      });
    } else if (reportedOutcome) {
      await tx.channelMaxAgentJob.update({
        where: { id },
        data: { mutationOutcome: reportedOutcome },
      });
    }
    return { event, idempotent: false, status };
  });

  return {
    ok: true,
    idempotent_replay: result.idempotent,
    job_id: id,
    job_status: result.status,
    event: publicEvent(result.event),
  };
}

function completionMetadata(
  input: CompleteChannelMaxAgentJobInput,
  job: ApprovalBoundJob,
) {
  return {
    status: input.status,
    mutation_outcome: input.mutation_outcome ?? null,
    message: input.message,
    result: input.result,
    job_binding: approvalBindingForEvents(job),
  };
}

function hasExactMutationConfirmation(
  job: ApprovalBoundJob & { mutationStartedAt: Date | null },
  event: {
    metadataJson: string;
    metadataSha256: string;
    evidenceJson: string;
    evidenceSha256: string;
    occurredAt: Date;
  } | null,
): boolean {
  if (!event || !job.mutationStartedAt) return false;
  try {
    const metadata = parseStoredJson(event.metadataJson) as {
      job_binding?: unknown;
    } | null;
    const evidence = parseStoredJson(event.evidenceJson) as Array<{
      kind?: unknown;
      uri?: unknown;
      captured_at?: unknown;
    }> | null;
    const hasBoundVisualEvidence =
      Array.isArray(evidence) &&
      evidence.some(
        (item) =>
          (item.kind === "SCREENSHOT" || item.kind === "DOM_SNAPSHOT") &&
          typeof item.uri === "string" &&
          typeof item.captured_at === "string" &&
          Number.isFinite(Date.parse(item.captured_at)) &&
          Math.abs(Date.parse(item.captured_at) - event.occurredAt.getTime()) <=
            15 * 60_000,
      );
    return (
      metadata != null &&
      stableJson(metadata.job_binding) ===
        stableJson(approvalBindingForEvents(job)) &&
      sha256Json(metadata) === event.metadataSha256 &&
      Array.isArray(evidence) &&
      evidence.length > 0 &&
      hasBoundVisualEvidence &&
      sha256Json(evidence) === event.evidenceSha256 &&
      event.occurredAt.getTime() >= job.mutationStartedAt.getTime()
    );
  } catch {
    return false;
  }
}

function assertExactSuccessfulUploadResult(
  job: ApprovalBoundJob,
  input: CompleteChannelMaxAgentJobInput,
): void {
  const binding = uploadBindingFromJob(job);
  if (
    input.result.assignment_sha256 !== binding.assignment_sha256 ||
    input.result.payload_sha256 !== binding.payload_sha256 ||
    input.result.request_sha256 !== binding.request_sha256 ||
    input.result.manual_model_id !== binding.manual_model_id ||
    input.result.manual_model_name !== binding.manual_model_name ||
    input.result.rows_expected !== binding.expected_active_rows ||
    input.result.rows_submitted !== binding.expected_active_rows ||
    input.result.rows_processed !== binding.expected_active_rows ||
    input.result.rows_succeeded !== binding.expected_active_rows ||
    input.result.rows_failed !== 0
  ) {
    throw new ChannelMaxAgentServiceError(
      "MUTATION_RESULT_BINDING_MISMATCH",
      "Successful upload result does not exactly match the approved plan or reports failed rows.",
      409,
    );
  }
}

function validateReconciliationCompletion(
  job: {
    id: string;
    operation: string;
    reconcilesJobId: string | null;
    payloadJson: string;
  },
  input: CompleteChannelMaxAgentJobInput,
): "CONFIRMED_APPLIED" | "CONFIRMED_NOT_APPLIED" | "STILL_AMBIGUOUS" | null {
  if (job.operation !== "RECONCILE_MUTATION") return null;
  const payload = parseStoredJson(job.payloadJson) as {
    ambiguous_job_id?: unknown;
    assignment_sha256?: unknown;
    expected_active_rows?: unknown;
    manual_model_id?: unknown;
  } | null;
  const resolution = input.result.resolution;
  if (
    !job.reconcilesJobId ||
    !payload ||
    payload.ambiguous_job_id !== job.reconcilesJobId ||
    input.result.ambiguous_job_id !== job.reconcilesJobId ||
    input.result.assignment_sha256 !== payload.assignment_sha256 ||
    input.result.manual_model_id !== payload.manual_model_id ||
    input.result.rows_expected !== payload.expected_active_rows ||
    !Number.isInteger(input.result.rows_observed) ||
    (input.result.rows_observed as number) < 0 ||
    ![
      "CONFIRMED_APPLIED",
      "CONFIRMED_NOT_APPLIED",
      "STILL_AMBIGUOUS",
    ].includes(String(resolution))
  ) {
    throw new ChannelMaxAgentServiceError(
      "RECONCILIATION_RESULT_INVALID",
      "Reconciliation result is not exactly bound to the ambiguous mutation.",
      409,
    );
  }
  if (
    !input.evidence.some(
      (item) =>
        (item.kind === "SCREENSHOT" || item.kind === "DOM_SNAPSHOT") &&
        item.uri,
    ) ||
    !input.evidence.some(
      (item) => item.kind === "INVENTORY_EXPORT" && item.uri,
    )
  ) {
    throw new ChannelMaxAgentServiceError(
      "RECONCILIATION_EVIDENCE_INCOMPLETE",
      "Reconciliation requires visual and inventory-export evidence references.",
      409,
    );
  }
  if (
    resolution === "CONFIRMED_APPLIED" &&
    input.result.rows_observed !== payload.expected_active_rows
  ) {
    throw new ChannelMaxAgentServiceError(
      "RECONCILIATION_ROW_COUNT_MISMATCH",
      "Applied reconciliation must observe every approved row.",
      409,
    );
  }
  if (
    resolution !== "STILL_AMBIGUOUS" &&
    !MANAGED_MUTATION_EVIDENCE_IMPLEMENTED
  ) {
    throw new ChannelMaxAgentServiceError(
      "MANAGED_EVIDENCE_REQUIRED",
      "Metadata-only worker evidence cannot resolve an ambiguous mutation; managed SSCC evidence bytes are required.",
      409,
    );
  }
  return resolution as
    | "CONFIRMED_APPLIED"
    | "CONFIRMED_NOT_APPLIED"
    | "STILL_AMBIGUOUS";
}

function assertReadOnlySuccessEvidence(
  operation: string,
  input: CompleteChannelMaxAgentJobInput,
): void {
  if (input.status !== "SUCCEEDED") return;
  if (operation === "EXPORT_INVENTORY") {
    if (!input.evidence.some((item) => item.kind === "INVENTORY_EXPORT")) {
      throw new ChannelMaxAgentServiceError(
        "READ_ONLY_EVIDENCE_INCOMPLETE",
        "A successful inventory export requires managed INVENTORY_EXPORT evidence.",
        409,
      );
    }
    return;
  }
  if (operation === "RECONCILE_MUTATION") return;
  if (
    !input.evidence.some(
      (item) =>
        item.kind === "SCREENSHOT" ||
        item.kind === "DOM_SNAPSHOT" ||
        item.kind === "INVENTORY_EXPORT",
    )
  ) {
    throw new ChannelMaxAgentServiceError(
      "READ_ONLY_EVIDENCE_INCOMPLETE",
      "A successful read-only ChannelMAX job requires managed visual or inventory evidence.",
      409,
    );
  }
}

export async function completeChannelMaxAgentJob(
  id: string,
  input: CompleteChannelMaxAgentJobInput,
  actorId: string,
  now = new Date(),
) {
  const preflight = await prisma.channelMaxAgentJob.findUnique({
    where: { id },
  });
  if (!preflight) {
    throw new ChannelMaxAgentServiceError(
      "JOB_NOT_FOUND",
      "ChannelMAX agent job was not found.",
      404,
    );
  }
  const metadata = completionMetadata(input, preflight);
  const metadataSha = sha256Json(metadata);
  const evidenceSha = sha256Json(input.evidence);
  const existingCompletion = await prisma.channelMaxAgentEvent.findUnique({
    where: { jobId_eventKey: { jobId: id, eventKey: input.completion_key } },
  });
  if (existingCompletion) {
    if (
      existingCompletion.metadataSha256 !== metadataSha ||
      existingCompletion.evidenceSha256 !== evidenceSha
    ) {
      throw new ChannelMaxAgentServiceError(
        "COMPLETION_IDEMPOTENCY_CONFLICT",
        "completion_key already exists with different completion metadata.",
        409,
      );
    }
    if (!TERMINAL_STATUSES.has(preflight.status)) {
      throw new ChannelMaxAgentServiceError(
        "COMPLETION_INCOMPLETE",
        "Completion event exists but the job is not terminal; manual reconciliation is required.",
        409,
      );
    }
    return {
      ok: true,
      idempotent_replay: true,
      job: publicJob(preflight),
    };
  }

  await requireActiveLease(id, input.lease_token, actorId, now);
  const completed = await prisma.$transaction(async (tx) => {
    const job = await tx.channelMaxAgentJob.findUnique({ where: { id } });
    if (!job || job.status !== "RUNNING") {
      throw new ChannelMaxAgentServiceError(
        "JOB_NOT_RUNNING",
        "Job is no longer running.",
        409,
      );
    }
    if (!safeDigestEqual(job.leaseTokenSha256, tokenSha256(input.lease_token))) {
      throw new ChannelMaxAgentServiceError(
        "LEASE_TOKEN_INVALID",
        "Lease token is invalid.",
        403,
      );
    }
    if (!job.workerActorId || job.workerActorId !== actorId) {
      throw new ChannelMaxAgentServiceError(
        "WORKER_IDENTITY_MISMATCH",
        "The authenticated API identity does not own this worker lease.",
        403,
      );
    }
    if (!job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= now.getTime()) {
      throw new ChannelMaxAgentServiceError(
        "LEASE_EXPIRED",
        "Lease expired before completion could be committed.",
        409,
      );
    }

    await assertManagedEvidenceRefs(tx, id, input.evidence);
    if (!job.mutation) assertReadOnlySuccessEvidence(job.operation, input);

    const decision = deriveTerminalDecision({
      mutation: job.mutation,
      mutationStarted: job.mutationStartedAt != null,
      operation: job.operation as ChannelMaxAgentOperation,
      completion: input,
    });
    const reconciliationResolution =
      job.operation === "RECONCILE_MUTATION" &&
      decision.status === "SUCCEEDED"
        ? validateReconciliationCompletion(job, input)
        : null;
    if (job.mutation && decision.status === "SUCCEEDED") {
      if (!(await hasSealedCurrentApproval(tx, job, now))) {
        throw new ChannelMaxAgentServiceError(
          "APPROVAL_EXPIRED",
          "Mutation cannot succeed after its exact owner approval expired.",
          409,
        );
      }
      const confirmation = await tx.channelMaxAgentEvent.findFirst({
        where: { jobId: id, type: "MUTATION_CONFIRMED" },
        orderBy: { sequence: "desc" },
      });
      if (!hasExactMutationConfirmation(job, confirmation)) {
        throw new ChannelMaxAgentServiceError(
          "MUTATION_CONFIRMATION_MISSING",
          "Successful completion requires append-only MUTATION_CONFIRMED evidence bound to the exact approved payload.",
          409,
        );
      }
      assertExactSuccessfulUploadResult(job, input);
    }
    if (
      job.mutation &&
      decision.status !== "AMBIGUOUS" &&
      job.mutationOutcome !== decision.mutationOutcome &&
      (decision.status === "SUCCEEDED" || job.mutationStartedAt != null)
    ) {
      throw new ChannelMaxAgentServiceError(
        "MUTATION_OUTCOME_MISMATCH",
        "Completion outcome does not match the immutable external outcome event chain.",
        409,
      );
    }
    const resultJson = stableJson(input.result);
    const event = await appendStoredEvent(tx, id, {
      eventKey: input.completion_key,
      type: `JOB_${decision.status}`,
      source: job.workerActorId ?? actorId,
      message: input.message,
      metadata,
      evidence: input.evidence,
      occurredAt: now,
    });
    const won = await tx.channelMaxAgentJob.updateMany({
      where: {
        id,
        status: "RUNNING",
        leaseTokenSha256: job.leaseTokenSha256,
        workerActorId: actorId,
        leaseExpiresAt: job.leaseExpiresAt,
      },
      data: {
        status: decision.status,
        mutationOutcome: decision.mutationOutcome,
        ambiguityReason:
          decision.status === "AMBIGUOUS" ? input.message : null,
        resultJson,
        resultSha256: sha256Json(input.result),
        error: decision.status === "SUCCEEDED" ? null : input.message,
        completedAt: now,
        workerId: null,
        workerActorId: null,
        accountLeaseKey: null,
        browserLeaseKey: null,
        leaseTokenSha256: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        ...(job.mutation &&
        decision.mutationOutcome === "CONFIRMED_NOT_APPLIED"
          ? { mutationPlanLock: null }
          : {}),
        ...(job.reconcilesJobId ? { reconciliationTargetLock: null } : {}),
      },
    });
    if (won.count !== 1) {
      throw new ChannelMaxAgentServiceError(
        "COMPLETION_STATE_RACE_LOST",
        "Job state changed before completion could commit; reload the job before taking any further action.",
        409,
      );
    }
    const updated = await tx.channelMaxAgentJob.findUniqueOrThrow({
      where: { id },
    });
    if (job.reconcilesJobId) {
      const resolutionEventKey = `reconciliation:${job.id}:${input.completion_key}`;
      await appendStoredEvent(tx, job.reconcilesJobId, {
        eventKey: resolutionEventKey,
        type: `RECONCILIATION_${reconciliationResolution ?? "FAILED"}`,
        source: job.workerActorId ?? actorId,
        message: input.message,
        metadata: {
          reconciliation_job_id: job.id,
          resolution: reconciliationResolution,
          result: input.result,
        },
        evidence: input.evidence,
        occurredAt: now,
      });
      if (
        decision.status !== "SUCCEEDED" ||
        reconciliationResolution === "STILL_AMBIGUOUS"
      ) {
        await tx.channelMaxAgentJob.updateMany({
          where: { id: job.reconcilesJobId, reconciledByJobId: job.id },
          data: { reconciledByJobId: null },
        });
      } else if (reconciliationResolution) {
        const confirmedApplied =
          reconciliationResolution === "CONFIRMED_APPLIED";
        await tx.channelMaxAgentJob.update({
          where: { id: job.reconcilesJobId },
          data: {
            status: confirmedApplied ? "SUCCEEDED" : "FAILED",
            mutationOutcome: confirmedApplied
              ? "CONFIRMED_APPLIED"
              : "CONFIRMED_NOT_APPLIED",
            ambiguityReason: null,
            error: confirmedApplied
              ? null
              : "Durable reconciliation confirmed the mutation was not applied.",
            completedAt: now,
            mutationPlanLock: confirmedApplied ? undefined : null,
          },
        });
      }
    }
    return { updated, event };
  });
  return {
    ok: true,
    idempotent_replay: false,
    job: publicJob(completed.updated),
    event: publicEvent(completed.event),
  };
}

export function channelMaxAgentCapabilities() {
  return {
    operations: CHANNELMAX_AGENT_OPERATIONS,
    arbitrary_browser_commands: false,
    arbitrary_javascript: false,
    managed_evidence: {
      implemented: MANAGED_MUTATION_EVIDENCE_IMPLEMENTED,
      max_bytes: CHANNELMAX_MANAGED_EVIDENCE_MAX_BYTES,
      max_items_per_job: CHANNELMAX_MANAGED_EVIDENCE_MAX_ITEMS_PER_JOB,
      max_total_bytes_per_job:
        CHANNELMAX_MANAGED_EVIDENCE_MAX_TOTAL_BYTES_PER_JOB,
      immutable_server_computed_digest: true,
      active_worker_lease_required: true,
      protected_download: true,
    },
    mutation_approval: {
      enabled: channelMaxMutationApprovalEnabled(),
      production_release_gate: MUTATION_APPROVAL_PRODUCTION_READY,
      create_status: "PENDING_APPROVAL",
      approval_endpoint_requires_real_admin_session: true,
      bearer_tokens_can_approve: false,
      schema_version: CHANNELMAX_OWNER_APPROVAL_SCHEMA,
    },
    mutation_protocol: {
      required_pre_write_event: "MUTATION_STARTED",
      ambiguity_is_terminal: true,
      automatic_retry_after_mutation_started: false,
    },
  };
}
