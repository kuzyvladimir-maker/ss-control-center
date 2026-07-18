import { createHash } from "node:crypto";

import type {
  ChannelMaxEvidenceKind,
  ChannelMaxEvidenceRef,
  ChannelMaxWorkerEventInput,
  CompleteChannelMaxAgentJobInput,
  CreateChannelMaxAgentJobInput,
} from "./contracts";
import { sha256Json, stableJson } from "./contracts";

export const CHANNELMAX_VC_CANARY_SCHEMA =
  "channelmax-vc-same-model-canary/v1" as const;
export const CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA =
  "channelmax-vc-same-model-canary-snapshot/v1" as const;

export const CHANNELMAX_VC_CANARY_PRODUCTION_READY = false;
export const CHANNELMAX_VC_CANARY_ARTIFACT_MEDIA_TYPE =
  "text/tab-separated-values" as const;
export const CHANNELMAX_VC_CANARY_ARTIFACT_ROUTE_PREFIX =
  "/api/openclaw/channelmax/canary-artifacts" as const;

export const CHANNELMAX_VC_CANARY = {
  account_id: "channelmax:amznus:salutem-solutions",
  host: "selling.channelmax.net",
  selected_site_id: "300",
  selected_site_name: "AmznUS [Salutem Solutions]",
  sku: "VC-ASV1-378P",
  asin: "B0H786L5MW",
  selling_venue: "AmazonUS",
  manual_model: { id: "59021", name: "Manual min/max" },
  prewrite_snapshot_sha256:
    "1f5f43122d35b2c422c6d1c92b6b0fc12cec8b1b4518536059250d89c1860427",
  forward: {
    minimum_price: 219.57,
    maximum_price: 252.99,
    assignment_sha256:
      "b3bb356eedc232bca2cd3d92f095e1b31606f3780ec93f6e9af1004b8a9c495a",
  },
  rollback: {
    minimum_price: 251.32,
    maximum_price: 289.28,
    assignment_sha256:
      "0a7f74822194fd8f4bd0f5aaec70b549875ba922dd618834aba5117cc4a9d932",
  },
  assignment_byte_size: 103,
  artifact_origin: "https://ss-control-center.vercel.app",
  worker_id: "imac-channelmax-canary-primary",
} as const;

export type ChannelMaxVcCanaryDirection = "FORWARD" | "ROLLBACK";

const HEADER =
  "SKU\tASIN\tSellingVenue\tMinSellingPrice\tMaxSellingPrice\r\n";

export const CHANNELMAX_VC_FORWARD_TSV =
  `${HEADER}VC-ASV1-378P\tB0H786L5MW\tAmazonUS\t219.57\t252.99\r\n`;
export const CHANNELMAX_VC_ROLLBACK_TSV =
  `${HEADER}VC-ASV1-378P\tB0H786L5MW\tAmazonUS\t251.32\t289.28\r\n`;

type JsonRecord = Record<string, unknown>;

export class ChannelMaxVcCanaryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly externalWriteMayHaveStarted = false,
  ) {
    super(message);
    this.name = "ChannelMaxVcCanaryError";
  }
}

function fail(code: string, message: string, mayHaveStarted = false): never {
  throw new ChannelMaxVcCanaryError(code, message, mayHaveStarted);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactArtifact(direction: ChannelMaxVcCanaryDirection) {
  const spec = direction === "FORWARD" ? CHANNELMAX_VC_CANARY.forward : CHANNELMAX_VC_CANARY.rollback;
  const text = direction === "FORWARD" ? CHANNELMAX_VC_FORWARD_TSV : CHANNELMAX_VC_ROLLBACK_TSV;
  const sha = sha256(text);
  if (
    sha !== spec.assignment_sha256 ||
    Buffer.byteLength(text, "utf8") !== CHANNELMAX_VC_CANARY.assignment_byte_size
  ) {
    return fail("SEALED_ARTIFACT_INVALID", "Compiled canary artifact bytes do not match their pinned digest.");
  }
  return {
    text,
    bytes: Buffer.from(text, "utf8"),
    sha256: sha,
    byteSize: CHANNELMAX_VC_CANARY.assignment_byte_size,
    url:
      `${CHANNELMAX_VC_CANARY.artifact_origin}${CHANNELMAX_VC_CANARY_ARTIFACT_ROUTE_PREFIX}/${sha}.txt`,
  };
}

export function channelMaxVcCanaryArtifact(direction: ChannelMaxVcCanaryDirection) {
  return exactArtifact(direction);
}

export function buildChannelMaxVcCanaryJobRequest(
  direction: ChannelMaxVcCanaryDirection,
): CreateChannelMaxAgentJobInput {
  const artifact = exactArtifact(direction);
  return {
    operation: "UPLOAD_MANUAL_ASSIGNMENT",
    idempotency_key:
      `channelmax:vc-canary:${direction.toLowerCase()}:${artifact.sha256.slice(0, 16)}`,
    priority: 100,
    max_attempts: 1,
    payload: {
      account_id: CHANNELMAX_VC_CANARY.account_id,
      expected_active_rows: 1,
      assignment_artifact: {
        download_url: artifact.url,
        sha256: artifact.sha256,
        byte_size: artifact.byteSize,
        media_type: CHANNELMAX_VC_CANARY_ARTIFACT_MEDIA_TYPE,
      },
      manual_model_id: CHANNELMAX_VC_CANARY.manual_model.id,
      manual_model_name: CHANNELMAX_VC_CANARY.manual_model.name,
      selling_venue: "AmazonUS",
      required_skip_rules: ["44a", "44b"],
    },
  };
}

export function buildChannelMaxVcVerifyTaskRequest(
  direction: ChannelMaxVcCanaryDirection,
  uploadTaskId: string,
): CreateChannelMaxAgentJobInput {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(uploadTaskId)) {
    return fail("UPLOAD_TASK_ID_INVALID", "ChannelMAX upload task ID is invalid.");
  }
  const artifact = exactArtifact(direction);
  return {
    operation: "VERIFY_UPLOAD_TASK",
    idempotency_key:
      `channelmax:vc-canary:verify:${direction.toLowerCase()}:${uploadTaskId}`,
    priority: 100,
    max_attempts: 1,
    payload: {
      account_id: CHANNELMAX_VC_CANARY.account_id,
      expected_active_rows: 1,
      upload_task_id: uploadTaskId,
      expected_assignment_sha256: artifact.sha256,
    },
  };
}

export function buildChannelMaxVcHoldRequest(
  direction: ChannelMaxVcCanaryDirection,
  uploadTaskId: string,
  notBefore: string,
): CreateChannelMaxAgentJobInput {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(uploadTaskId)) {
    return fail("UPLOAD_TASK_ID_INVALID", "ChannelMAX upload task ID is invalid.");
  }
  if (
    !Number.isFinite(Date.parse(notBefore)) ||
    new Date(Date.parse(notBefore)).toISOString() !== notBefore
  ) {
    return fail("HOLD_TIME_INVALID", "Post-upload hold time must be canonical UTC.");
  }
  const artifact = exactArtifact(direction);
  return {
    operation: "OBSERVE_POST_UPLOAD_HOLD",
    idempotency_key:
      `channelmax:vc-canary:hold:${direction.toLowerCase()}:${uploadTaskId}`,
    priority: 100,
    max_attempts: 1,
    payload: {
      account_id: CHANNELMAX_VC_CANARY.account_id,
      expected_active_rows: 1,
      upload_task_id: uploadTaskId,
      not_before: notBefore,
      expected_assignment_sha256: artifact.sha256,
    },
  };
}

export interface ChannelMaxVcClaim {
  leaseToken: string;
  leaseExpiresAt: string;
  job: {
    id: string;
    attempts: 1;
    maxAttempts: 1;
    payloadSha256: string;
    requestSha256: string;
    mutationPlanSha256: string;
    direction: ChannelMaxVcCanaryDirection;
    request: CreateChannelMaxAgentJobInput;
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_CLAIM", `${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactDirectionForPayload(payload: unknown): ChannelMaxVcCanaryDirection {
  const serialized = stableJson(payload);
  for (const direction of ["FORWARD", "ROLLBACK"] as const) {
    if (serialized === stableJson(buildChannelMaxVcCanaryJobRequest(direction).payload)) {
      return direction;
    }
  }
  return fail(
    "CANARY_PAYLOAD_MISMATCH",
    "Claim payload is not the exact forward or rollback VC same-model artifact.",
  );
}

export function parseChannelMaxVcCanaryClaim(
  raw: unknown,
  now = new Date(),
): ChannelMaxVcClaim {
  const claim = record(raw, "claim");
  if (claim.claimed !== true) return fail("INVALID_CLAIM", "Claim must declare claimed=true.");
  const leaseToken = String(claim.lease_token ?? "");
  const leaseExpiresAt = String(claim.lease_expires_at ?? "");
  if (
    !/^[a-f0-9]{64}$/.test(leaseToken) ||
    !Number.isFinite(Date.parse(leaseExpiresAt)) ||
    Date.parse(leaseExpiresAt) <= now.getTime()
  ) {
    return fail("INVALID_CLAIM", "Claim lease token/expiry is invalid.");
  }
  const job = record(claim.job, "claim.job");
  const payload = record(job.payload, "claim.job.payload");
  const direction = exactDirectionForPayload(payload);
  const request = buildChannelMaxVcCanaryJobRequest(direction);
  const id = String(job.id ?? "");
  const payloadSha256 = sha256Json(request.payload);
  const requestSha256 = sha256Json(request);
  const mutationPlanSha256 = sha256Json({
    operation: request.operation,
    payload: request.payload,
  });
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(id) ||
    job.operation !== request.operation ||
    job.mutation !== true ||
    job.account_id !== CHANNELMAX_VC_CANARY.account_id ||
    job.idempotency_key !== request.idempotency_key ||
    job.priority !== request.priority ||
    job.attempts !== 1 ||
    job.max_attempts !== 1 ||
    job.payload_sha256 !== payloadSha256 ||
    job.request_sha256 !== requestSha256 ||
    job.mutation_plan_sha256 !== mutationPlanSha256
  ) {
    return fail("CANARY_JOB_BINDING_MISMATCH", "Claim job/digests are not the exact single-attempt VC plan.");
  }
  const approval = record(job.owner_approval, "claim.job.owner_approval");
  if (
    approval.approved !== true ||
    typeof approval.approved_by_id !== "string" ||
    !approval.approved_by_id ||
    approval.approved_by_id.startsWith("system:") ||
    approval.assignment_sha256 !== exactArtifact(direction).sha256 ||
    typeof approval.approval_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(approval.approval_sha256) ||
    !["PASSWORD_REAUTH", "WEBAUTHN", "TOTP"].includes(
      String(approval.step_up_method),
    ) ||
    !Number.isFinite(Date.parse(String(approval.expires_at))) ||
    Date.parse(String(approval.expires_at)) <= now.getTime()
  ) {
    return fail("OWNER_APPROVAL_INVALID", "Claim lacks a current real-admin step-up approval.");
  }
  const plan = record(job.approval_plan, "claim.job.approval_plan");
  const expectedPlan = {
    schema_version: "channelmax-owner-approval/v1",
    job_id: id,
    operation: request.operation,
    account_id: CHANNELMAX_VC_CANARY.account_id,
    manual_model_id: CHANNELMAX_VC_CANARY.manual_model.id,
    manual_model_name: CHANNELMAX_VC_CANARY.manual_model.name,
    expected_active_rows: 1,
    assignment_sha256: exactArtifact(direction).sha256,
    payload_sha256: payloadSha256,
    request_sha256: requestSha256,
    mutation_plan_sha256: mutationPlanSha256,
  };
  if (stableJson(plan) !== stableJson(expectedPlan)) {
    return fail("OWNER_APPROVAL_INVALID", "Approval plan does not bind the exact VC request.");
  }
  const protocol = record(claim.protocol, "claim.protocol");
  if (
    protocol.before_external_write !==
      "POST MUTATION_STARTED and wait for its successful acknowledgement; otherwise DO NOT click Upload/Submit." ||
    protocol.after_external_write !==
      "Report CONFIRMED_APPLIED, CONFIRMED_NOT_APPLIED, or AMBIGUOUS with evidence; never guess and never retry an ambiguous mutation."
  ) {
    return fail("INVALID_CLAIM_PROTOCOL", "Control plane did not issue the exact mutation protocol.");
  }
  return {
    leaseToken,
    leaseExpiresAt,
    job: {
      id,
      attempts: 1,
      maxAttempts: 1,
      payloadSha256,
      requestSha256,
      mutationPlanSha256,
      direction,
      request,
    },
  };
}

export interface ChannelMaxVcRowSnapshot {
  schema_version: typeof CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA;
  captured_at: string;
  phase: "PREWRITE" | "POSTWRITE";
  direction: ChannelMaxVcCanaryDirection;
  account_id: typeof CHANNELMAX_VC_CANARY.account_id;
  selected_site_id: typeof CHANNELMAX_VC_CANARY.selected_site_id;
  selected_site_name: typeof CHANNELMAX_VC_CANARY.selected_site_name;
  assignment_sha256: string;
  baseline_inventory_snapshot_sha256: typeof CHANNELMAX_VC_CANARY.prewrite_snapshot_sha256;
  upload_task_id: string | null;
  row: {
    sku: typeof CHANNELMAX_VC_CANARY.sku;
    asin: typeof CHANNELMAX_VC_CANARY.asin;
    repricing_model_id: typeof CHANNELMAX_VC_CANARY.manual_model.id;
    repricing_model_name: typeof CHANNELMAX_VC_CANARY.manual_model.name;
    minimum_price: number;
    maximum_price: number;
  };
}

function stateFor(
  direction: ChannelMaxVcCanaryDirection,
  phase: "PREWRITE" | "POSTWRITE",
) {
  if (direction === "FORWARD") {
    return phase === "PREWRITE" ? CHANNELMAX_VC_CANARY.rollback : CHANNELMAX_VC_CANARY.forward;
  }
  return phase === "PREWRITE" ? CHANNELMAX_VC_CANARY.forward : CHANNELMAX_VC_CANARY.rollback;
}

export function assertChannelMaxVcRowSnapshot(
  snapshot: ChannelMaxVcRowSnapshot,
  direction: ChannelMaxVcCanaryDirection,
  phase: "PREWRITE" | "POSTWRITE",
): void {
  const expected = stateFor(direction, phase);
  if (
    snapshot.schema_version !== CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA ||
    snapshot.phase !== phase ||
    snapshot.direction !== direction ||
    snapshot.account_id !== CHANNELMAX_VC_CANARY.account_id ||
    snapshot.selected_site_id !== CHANNELMAX_VC_CANARY.selected_site_id ||
    snapshot.selected_site_name !== CHANNELMAX_VC_CANARY.selected_site_name ||
    snapshot.assignment_sha256 !== exactArtifact(direction).sha256 ||
    snapshot.baseline_inventory_snapshot_sha256 !==
      CHANNELMAX_VC_CANARY.prewrite_snapshot_sha256 ||
    snapshot.row.sku !== CHANNELMAX_VC_CANARY.sku ||
    snapshot.row.asin !== CHANNELMAX_VC_CANARY.asin ||
    snapshot.row.repricing_model_id !== CHANNELMAX_VC_CANARY.manual_model.id ||
    snapshot.row.repricing_model_name !== CHANNELMAX_VC_CANARY.manual_model.name ||
    snapshot.row.minimum_price !== expected.minimum_price ||
    snapshot.row.maximum_price !== expected.maximum_price ||
    !Number.isFinite(Date.parse(snapshot.captured_at)) ||
    new Date(Date.parse(snapshot.captured_at)).toISOString() !== snapshot.captured_at ||
    (phase === "PREWRITE" && snapshot.upload_task_id !== null) ||
    (phase === "POSTWRITE" &&
      (typeof snapshot.upload_task_id !== "string" || !snapshot.upload_task_id))
  ) {
    return fail("CANARY_SNAPSHOT_MISMATCH", `${phase} snapshot is not the exact expected VC state.`);
  }
}

export interface ChannelMaxVcAnalysisPreview {
  columns: ["SKU", "ASIN", "SellingVenue", "MinSellingPrice", "MaxSellingPrice"];
  rows: 1;
  sku: typeof CHANNELMAX_VC_CANARY.sku;
  asin: typeof CHANNELMAX_VC_CANARY.asin;
  sellingVenue: "AmazonUS";
  minimumPrice: number;
  maximumPrice: number;
  validateOnly: false;
  dontTouchExistingSkus: false;
  unmatchedColumns: 0;
  errors: 0;
}

function assertAnalysisPreview(
  preview: ChannelMaxVcAnalysisPreview,
  direction: ChannelMaxVcCanaryDirection,
): void {
  const expected = direction === "FORWARD" ? CHANNELMAX_VC_CANARY.forward : CHANNELMAX_VC_CANARY.rollback;
  if (
    stableJson(preview.columns) !==
      stableJson(["SKU", "ASIN", "SellingVenue", "MinSellingPrice", "MaxSellingPrice"]) ||
    preview.rows !== 1 ||
    preview.sku !== CHANNELMAX_VC_CANARY.sku ||
    preview.asin !== CHANNELMAX_VC_CANARY.asin ||
    preview.sellingVenue !== "AmazonUS" ||
    preview.minimumPrice !== expected.minimum_price ||
    preview.maximumPrice !== expected.maximum_price ||
    preview.validateOnly !== false ||
    preview.dontTouchExistingSkus !== false ||
    preview.unmatchedColumns !== 0 ||
    preview.errors !== 0
  ) {
    return fail("ANALYSIS_PREVIEW_MISMATCH", "ChannelMAX Analyze result does not match the one-row canary.");
  }
}

export interface ChannelMaxVcTaskReceipt {
  uploadTaskId: string;
  status: "COMPLETED" | "REJECTED";
  rowsProcessed: number;
  rowsSucceeded: number;
  rowsFailed: number;
}

export interface ChannelMaxVcLocalEvidence {
  kind: ChannelMaxEvidenceKind;
  mediaType: string;
  capturedAt: string;
  bytes: Uint8Array;
}

export interface ChannelMaxVcBrowserPort {
  assertExactContext(): Promise<{
    protocol: "https:";
    host: typeof CHANNELMAX_VC_CANARY.host;
    selectedSiteId: typeof CHANNELMAX_VC_CANARY.selected_site_id;
    selectedSiteName: typeof CHANNELMAX_VC_CANARY.selected_site_name;
  }>;
  snapshot(
    direction: ChannelMaxVcCanaryDirection,
    phase: "PREWRITE" | "POSTWRITE",
    uploadTaskId: string | null,
  ): Promise<ChannelMaxVcRowSnapshot>;
  captureScreenshot(label: "ANALYZED" | "POSTWRITE" | "AMBIGUOUS"): Promise<ChannelMaxVcLocalEvidence>;
  analyzeExactArtifact(input: {
    bytes: Uint8Array;
    sha256: string;
    direction: ChannelMaxVcCanaryDirection;
  }): Promise<ChannelMaxVcAnalysisPreview>;
  submitAnalyzedFileOnce(): Promise<{ uploadTaskId: string }>;
  verifyUploadTask(uploadTaskId: string): Promise<ChannelMaxVcTaskReceipt>;
}

export interface ChannelMaxVcControlPlanePort {
  downloadArtifact(url: string): Promise<Uint8Array>;
  uploadEvidence(
    claim: ChannelMaxVcClaim,
    evidence: ChannelMaxVcLocalEvidence,
  ): Promise<ChannelMaxEvidenceRef>;
  heartbeat(
    jobId: string,
    leaseToken: string,
    phase: string,
    progressPercent: number,
  ): Promise<void>;
  appendEvent(jobId: string, input: ChannelMaxWorkerEventInput): Promise<void>;
  complete(jobId: string, input: CompleteChannelMaxAgentJobInput): Promise<void>;
}

export interface ChannelMaxVcExecutionResult {
  direction: ChannelMaxVcCanaryDirection;
  outcome: "CONFIRMED_APPLIED" | "CONFIRMED_NOT_APPLIED" | "AMBIGUOUS";
  uploadTaskId: string | null;
  submitCalls: 1;
  rollbackJob: CreateChannelMaxAgentJobInput;
  verifyTaskJob: CreateChannelMaxAgentJobInput | null;
  holdJob: CreateChannelMaxAgentJobInput | null;
}

function localJsonEvidence(
  snapshot: ChannelMaxVcRowSnapshot,
): ChannelMaxVcLocalEvidence {
  return {
    kind: "DOM_SNAPSHOT",
    mediaType: "application/json",
    capturedAt: snapshot.captured_at,
    bytes: Buffer.from(JSON.stringify(snapshot), "utf8"),
  };
}

function eventKey(jobId: string, direction: string, type: string): string {
  return `vc-canary:${sha256(`${jobId}:${direction}:${type}`).slice(0, 40)}`;
}

async function executeStateMachine(input: {
  rawClaim: unknown;
  browser: ChannelMaxVcBrowserPort;
  controlPlane: ChannelMaxVcControlPlanePort;
  now?: () => Date;
}): Promise<ChannelMaxVcExecutionResult> {
  const clock = input.now ?? (() => new Date());
  const claim = parseChannelMaxVcCanaryClaim(input.rawClaim, clock());
  const { direction } = claim.job;
  const artifact = exactArtifact(direction);
  const downloaded = Buffer.from(
    await input.controlPlane.downloadArtifact(artifact.url),
  );
  if (
    downloaded.byteLength !== artifact.byteSize ||
    sha256(downloaded) !== artifact.sha256 ||
    !downloaded.equals(artifact.bytes)
  ) {
    return fail("UPLOAD_SOURCE_MISMATCH", "Downloaded upload source is not the exact compiled canary bytes.");
  }
  const context = await input.browser.assertExactContext();
  if (
    context.protocol !== "https:" ||
    context.host !== CHANNELMAX_VC_CANARY.host ||
    context.selectedSiteId !== CHANNELMAX_VC_CANARY.selected_site_id ||
    context.selectedSiteName !== CHANNELMAX_VC_CANARY.selected_site_name
  ) {
    return fail("CHANNELMAX_CONTEXT_MISMATCH", "Browser is not on the exact ChannelMAX account/site.");
  }
  await input.controlPlane.heartbeat(claim.job.id, claim.leaseToken, "prewrite_snapshot", 10);
  const before = await input.browser.snapshot(direction, "PREWRITE", null);
  assertChannelMaxVcRowSnapshot(before, direction, "PREWRITE");
  const beforeEvidence = await input.controlPlane.uploadEvidence(
    claim,
    localJsonEvidence(before),
  );
  const preview = await input.browser.analyzeExactArtifact({
    bytes: downloaded,
    sha256: artifact.sha256,
    direction,
  });
  assertAnalysisPreview(preview, direction);
  const previewScreenshot = await input.browser.captureScreenshot("ANALYZED");
  const previewEvidence = await input.controlPlane.uploadEvidence(
    claim,
    previewScreenshot,
  );
  const uploadSourceEvidence = await input.controlPlane.uploadEvidence(claim, {
    kind: "UPLOAD_SOURCE",
    mediaType: "text/tab-separated-values",
    capturedAt: clock().toISOString(),
    bytes: downloaded,
  });
  await input.controlPlane.heartbeat(claim.job.id, claim.leaseToken, "awaiting_mutation_fence", 45);
  const mutationStarted: ChannelMaxWorkerEventInput = {
    event_key: eventKey(claim.job.id, direction, "MUTATION_STARTED"),
    lease_token: claim.leaseToken,
    type: "MUTATION_STARTED",
    occurred_at: clock().toISOString(),
    message: `Exact ${direction.toLowerCase()} VC canary analyzed; requesting one submit.`,
    step: "single_submit_fence",
    progress_percent: 50,
    evidence: [uploadSourceEvidence, beforeEvidence, previewEvidence],
  };
  await input.controlPlane.appendEvent(claim.job.id, mutationStarted);

  let uploadTaskId: string | null = null;
  let receipt: ChannelMaxVcTaskReceipt | null = null;
  let postSnapshot: ChannelMaxVcRowSnapshot | null = null;
  let postEvidence: ChannelMaxEvidenceRef[] = [];
  let caught: unknown = null;
  // This is the only external-write call. It is deliberately outside every
  // loop and is never re-entered after an exception or ambiguous response.
  try {
    const submitted = await input.browser.submitAnalyzedFileOnce();
    uploadTaskId = submitted.uploadTaskId;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(uploadTaskId)) {
      throw new ChannelMaxVcCanaryError(
        "UPLOAD_TASK_ID_INVALID",
        "Submit returned an invalid task ID.",
        true,
      );
    }
    receipt = await input.browser.verifyUploadTask(uploadTaskId);
    postSnapshot = await input.browser.snapshot(direction, "POSTWRITE", uploadTaskId);
    const postDom = await input.controlPlane.uploadEvidence(
      claim,
      localJsonEvidence(postSnapshot),
    );
    const postShot = await input.controlPlane.uploadEvidence(
      claim,
      await input.browser.captureScreenshot("POSTWRITE"),
    );
    postEvidence = [postDom, postShot];
  } catch (error) {
    caught = error;
    try {
      const ambiguousShot = await input.controlPlane.uploadEvidence(
        claim,
        await input.browser.captureScreenshot("AMBIGUOUS"),
      );
      postEvidence = [ambiguousShot];
    } catch {
      postEvidence = [previewEvidence];
    }
  }

  let outcome: ChannelMaxVcExecutionResult["outcome"] = "AMBIGUOUS";
  if (!caught && receipt && postSnapshot) {
    try {
      assertChannelMaxVcRowSnapshot(postSnapshot, direction, "POSTWRITE");
      if (
        receipt.uploadTaskId === uploadTaskId &&
        receipt.status === "COMPLETED" &&
        receipt.rowsProcessed === 1 &&
        receipt.rowsSucceeded === 1 &&
        receipt.rowsFailed === 0
      ) {
        outcome = "CONFIRMED_APPLIED";
      }
    } catch (error) {
      caught = error;
    }
  }
  const eventType =
    outcome === "CONFIRMED_APPLIED" ? "MUTATION_CONFIRMED" : "MUTATION_AMBIGUOUS";
  await input.controlPlane.appendEvent(claim.job.id, {
    event_key: eventKey(claim.job.id, direction, eventType),
    lease_token: claim.leaseToken,
    type: eventType,
    occurred_at: clock().toISOString(),
    message:
      outcome === "CONFIRMED_APPLIED"
        ? `Task ${uploadTaskId} and exact postwrite VC snapshot agree.`
        : "External outcome is ambiguous; do not retry and reconcile read-only.",
    step: outcome === "CONFIRMED_APPLIED" ? "task_and_snapshot_verified" : "terminal_ambiguity",
    progress_percent: 100,
    evidence: postEvidence,
  });

  const completionStatus = outcome === "CONFIRMED_APPLIED" ? "SUCCEEDED" : "AMBIGUOUS";
  const completion: CompleteChannelMaxAgentJobInput = {
    completion_key: eventKey(claim.job.id, direction, "COMPLETE"),
    lease_token: claim.leaseToken,
    status: completionStatus,
    mutation_outcome: outcome === "CONFIRMED_APPLIED" ? "CONFIRMED_APPLIED" : "AMBIGUOUS",
    message:
      outcome === "CONFIRMED_APPLIED"
        ? "Exact same-model VC canary applied and verified."
        : "Exact same-model VC canary outcome is ambiguous; no retry permitted.",
    result:
      outcome === "CONFIRMED_APPLIED" && receipt && uploadTaskId
        ? {
            upload_task_id: uploadTaskId,
            upload_status: "COMPLETED",
            assignment_sha256: artifact.sha256,
            payload_sha256: claim.job.payloadSha256,
            request_sha256: claim.job.requestSha256,
            manual_model_id: CHANNELMAX_VC_CANARY.manual_model.id,
            manual_model_name: CHANNELMAX_VC_CANARY.manual_model.name,
            rows_expected: 1,
            rows_submitted: 1,
            rows_processed: receipt.rowsProcessed,
            rows_succeeded: receipt.rowsSucceeded,
            rows_failed: receipt.rowsFailed,
            rollback_assignment_sha256:
              exactArtifact(direction === "FORWARD" ? "ROLLBACK" : "FORWARD").sha256,
          }
        : {
            blocker: "TERMINAL_AMBIGUITY_NO_RETRY",
            assignment_sha256: artifact.sha256,
            upload_task_id: uploadTaskId,
            error:
              caught instanceof Error ? caught.message : "Task/snapshot evidence did not converge.",
          },
    evidence: postEvidence,
  };
  await input.controlPlane.complete(claim.job.id, completion);

  const rollbackDirection: ChannelMaxVcCanaryDirection =
    direction === "FORWARD" ? "ROLLBACK" : "FORWARD";
  const verifyTaskJob = uploadTaskId
    ? buildChannelMaxVcVerifyTaskRequest(direction, uploadTaskId)
    : null;
  const holdJob = uploadTaskId
    ? buildChannelMaxVcHoldRequest(
        direction,
        uploadTaskId,
        new Date(clock().getTime() + 30 * 60_000).toISOString(),
      )
    : null;
  return {
    direction,
    outcome,
    uploadTaskId,
    submitCalls: 1,
    rollbackJob: buildChannelMaxVcCanaryJobRequest(rollbackDirection),
    verifyTaskJob,
    holdJob,
  };
}

export async function executeChannelMaxVcCanaryProduction(
  input: Parameters<typeof executeStateMachine>[0],
): Promise<never> {
  void input;
  return fail(
    "PRODUCTION_RELEASE_GATE_DISABLED",
    "VC canary production execution remains disabled until the finite CDP adapter and owner ceremony are reviewed.",
  );
}

export async function executeChannelMaxVcCanaryTestOnly(
  input: Parameters<typeof executeStateMachine>[0],
): Promise<ChannelMaxVcExecutionResult> {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.CHANNELMAX_VC_CANARY_TEST_ONLY !== "true"
  ) {
    return fail(
      "TEST_ONLY_EXECUTOR_DISABLED",
      "The VC canary state-machine harness is available only under the explicit non-production test flag.",
    );
  }
  return executeStateMachine(input);
}
