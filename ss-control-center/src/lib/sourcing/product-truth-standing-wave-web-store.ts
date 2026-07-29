import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

import {
  PRODUCT_TRUTH_CONTROL_ZERO_HASH,
  sealProductTruthControlArtifact,
  sealProductTruthControlEvent,
} from "./product-truth-control-plane";
import {
  PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS,
} from "./product-truth-standing-wave";
import {
  PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND,
  PRODUCT_TRUTH_STANDING_WAVE_WEB_GATE_CLASS,
  PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS,
  PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION,
  parseProductTruthStandingWaveWebRequestBytes,
  parseProductTruthStandingWaveWebResult,
  renderProductTruthStandingWaveWebRequest,
  renderProductTruthStandingWaveWebResult,
  type ProductTruthStandingWaveWebOperation,
  type ProductTruthStandingWaveWebRequest,
  type ProductTruthStandingWaveWebResult,
} from "./product-truth-standing-wave-web-contract";
import type {
  ProductTruthStandingWaveWebRuntimeActive,
} from "./product-truth-standing-wave-web-runtime";

export const PRODUCT_TRUTH_STANDING_WAVE_WEB_STORE_VERSION =
  "product-truth-standing-wave-web-store/1.0.0" as const;
export const PRODUCT_TRUTH_STANDING_WAVE_WEB_LEASE_MS = 15 * 60_000;

const ACTIVE_STATUSES = ["ADMITTED", "CLAIMED", "RUNNING"] as const;

export interface ProductTruthStandingWaveWebClaim {
  schema_version: typeof PRODUCT_TRUTH_STANDING_WAVE_WEB_STORE_VERSION;
  command_id: string;
  operation: ProductTruthStandingWaveWebOperation;
  workspace_key: string;
  lease_token: string;
  lease_expires_at: string;
  engine: {
    release_id: string;
    commit_sha: string;
    tree_sha: string;
    executable_tree_sha256: string;
  };
  target: {
    environment: "PRODUCTION";
    database_target_fingerprint: string;
    manifest_sha256: string;
  };
  request: ProductTruthStandingWaveWebRequest;
}

export interface ProductTruthStandingWaveWebStatus {
  schemaVersion: typeof PRODUCT_TRUTH_STANDING_WAVE_WEB_STORE_VERSION;
  status: "ACTIVE";
  canStart: boolean;
  activeCommandId: string | null;
  resumableCommandId: string | null;
  commands: readonly {
    commandId: string;
    operation: ProductTruthStandingWaveWebOperation;
    workspaceKey: string;
    status: string;
    outcome: string | null;
    requestedByUserId: string;
    requestedAt: string;
    updatedAt: string;
    executionStartedAt: string | null;
    attempts: number;
    maxAttempts: number;
    errorCode: string | null;
    planSha256: string | null;
    result: {
      waveId: string | null;
      targetCount: number | null;
      completedTargetCount: number;
      ambiguousTargetCount: number;
      actualProviderUnits: number | null;
      reportSha256: string | null;
      readinessReportSha256: string | null;
    } | null;
  }[];
  limits: ProductTruthStandingWaveWebRuntimeActive["limits"];
  claims: {
    standingPolicyAuthority: true;
    ownerPromptRequired: false;
    automaticRetry: false;
    marketplaceMutations: false;
  };
}

export class ProductTruthStandingWaveWebStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthStandingWaveWebStoreError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthStandingWaveWebStoreError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function prismaBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.byteLength));
  bytes.set(value);
  return bytes;
}

function safeToken(value: string, label: string): string {
  if (
    value.length < 8
    || value.length > 200
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  ) {
    fail("STANDING_WAVE_WEB_VALUE_INVALID", `${label} must be a safe token`);
  }
  return value;
}

function requestFor(input: {
  runtime: ProductTruthStandingWaveWebRuntimeActive;
  requestId: string;
  operation: ProductTruthStandingWaveWebOperation;
  sourceCommandId: string | null;
  requestedAt: Date;
}): ProductTruthStandingWaveWebRequest {
  return JSON.parse(renderProductTruthStandingWaveWebRequest({
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION,
    requestId: safeToken(input.requestId, "requestId"),
    operation: input.operation,
    requestedAt: input.requestedAt.toISOString(),
    expiresAt: new Date(
      input.requestedAt.getTime() + PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS,
    ).toISOString(),
    sourceCommandId: input.sourceCommandId,
    bindings: {
      manifestSha256: input.runtime.base.target.manifestSha256,
      standingProviderPolicySha256:
        input.runtime.standingProviderPolicySha256,
      standingNoPaidPolicySha256:
        input.runtime.standingNoPaidPolicySha256,
    },
    limits: {
      maxTargets: 5,
      maxLinkedListings: 100,
      maxProviderUnits: PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS,
      maxLifetimeMs: PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS,
      targetConcurrency: 1,
      maxAttemptsPerTarget: 1,
      automaticRetry: false,
    },
    claims: {
      authority: "PINNED_STANDING_POLICY",
      authoritativePhase1Only: true,
      noImplicitScope: true,
      noParallelCatalog: true,
      ambiguousNeverReplay: true,
      noMarketplaceMutation: true,
      noPriceOrInventoryChange: true,
      noDelisting: true,
      noConsumerActivation: true,
      noProcurement: true,
      noClubs: true,
      noBjs: true,
    },
  })) as ProductTruthStandingWaveWebRequest;
}

async function appendEvent(
  tx: Prisma.TransactionClient,
  input: {
    commandId: string;
    eventType:
      | "REQUESTED"
      | "ARTIFACTS_VALIDATED"
      | "ADMITTED"
      | "CLAIMED"
      | "HEARTBEAT"
      | "EXECUTION_BOUNDARY"
      | "ARTIFACT_RECEIVED"
      | "SUCCEEDED"
      | "FAILED"
      | "AMBIGUOUS";
    source: "SERVER" | "WORKER";
    occurredAt: string;
    payload: unknown;
  },
): Promise<void> {
  const previous = await tx.productTruthControlEvent.findFirst({
    where: { commandId: input.commandId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, eventHash: true },
  });
  const payload = canonicalBytes(input.payload);
  const sequence = (previous?.sequence ?? 0) + 1;
  const event = sealProductTruthControlEvent({
    eventId: `ptce-${input.commandId.slice(6)}-${sequence}-${sha256(payload).slice(0, 8)}`,
    commandId: input.commandId,
    sequence,
    eventType: input.eventType,
    source: input.source,
    occurredAt: input.occurredAt,
    payload,
    previousEventHash: previous?.eventHash ?? PRODUCT_TRUTH_CONTROL_ZERO_HASH,
  });
  await tx.productTruthControlEvent.create({
    data: {
      eventId: event.eventId,
      commandId: event.commandId,
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      eventType: event.eventType,
      source: event.source,
      occurredAt: new Date(event.occurredAt),
      payload: prismaBytes(event.payload),
      payloadSha256: event.payloadSha256,
      previousEventHash: event.previousEventHash,
      eventHash: event.eventHash,
    },
  });
}

function requestArtifact(row: {
  requestArtifactId: string | null;
  artifacts: readonly {
    artifactId: string;
    content: Uint8Array;
    byteSize: number;
    sha256: string;
  }[];
}): ProductTruthStandingWaveWebRequest {
  const artifact = row.artifacts.find(
    (candidate) => candidate.artifactId === row.requestArtifactId,
  );
  if (
    !artifact
    || artifact.byteSize !== artifact.content.byteLength
    || sha256(artifact.content) !== artifact.sha256
  ) {
    fail(
      "STANDING_WAVE_WEB_ARTIFACT_INVALID",
      "request artifact is missing or corrupt",
    );
  }
  return parseProductTruthStandingWaveWebRequestBytes(artifact.content);
}

function resultArtifact(row: {
  resultArtifactId: string | null;
  artifacts: readonly {
    artifactId: string;
    content: Uint8Array;
    byteSize: number;
    sha256: string;
  }[];
}): ProductTruthStandingWaveWebResult | null {
  if (row.resultArtifactId === null) return null;
  const artifact = row.artifacts.find(
    (candidate) => candidate.artifactId === row.resultArtifactId,
  );
  if (
    !artifact
    || artifact.byteSize !== artifact.content.byteLength
    || sha256(artifact.content) !== artifact.sha256
  ) {
    fail(
      "STANDING_WAVE_WEB_ARTIFACT_INVALID",
      "result artifact is missing or corrupt",
    );
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(artifact.content);
    if (!text.endsWith("\n") || text.includes("\r")) throw new Error("bytes");
    parsed = JSON.parse(text);
  } catch (error) {
    fail(
      "STANDING_WAVE_WEB_ARTIFACT_INVALID",
      "result artifact is not canonical JSON",
      error,
    );
  }
  return parseProductTruthStandingWaveWebResult(parsed);
}

function runtimeMatchesRequest(
  runtime: ProductTruthStandingWaveWebRuntimeActive,
  request: ProductTruthStandingWaveWebRequest,
): boolean {
  return (
    request.bindings.manifestSha256 === runtime.base.target.manifestSha256
    && request.bindings.standingProviderPolicySha256
      === runtime.standingProviderPolicySha256
    && request.bindings.standingNoPaidPolicySha256
      === runtime.standingNoPaidPolicySha256
  );
}

export async function admitProductTruthStandingWaveWebCommand(input: {
  runtime: ProductTruthStandingWaveWebRuntimeActive;
  requestedByUserId: string;
  requestId: string;
  operation: ProductTruthStandingWaveWebOperation;
  sourceCommandId?: string | null;
  now?: Date;
}): Promise<string> {
  const requestId = safeToken(input.requestId, "requestId");
  const requestedByUserId = safeToken(
    input.requestedByUserId,
    "requestedByUserId",
  );
  const idempotencyKey = `product-truth-standing-wave:${requestId}`;
  const existing = await prisma.productTruthControlCommand.findUnique({
    where: { idempotencyKey },
    include: { artifacts: { where: { role: "REQUEST" } } },
  });
  if (existing) {
    const existingRequest = requestArtifact(existing);
    if (
      existing.commandKind !== PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND
      || existing.requestedByUserId !== requestedByUserId
      || existingRequest.requestId !== requestId
      || existingRequest.operation !== input.operation
      || existingRequest.sourceCommandId !== (input.sourceCommandId ?? null)
      || !runtimeMatchesRequest(input.runtime, existingRequest)
      || existing.engineReleaseId !== input.runtime.base.engine.releaseId
      || existing.engineCommitSha !== input.runtime.base.engine.commitSha
      || existing.engineTreeSha !== input.runtime.base.engine.treeSha
      || existing.executableTreeSha256
        !== input.runtime.base.engine.executableTreeSha256
      || existing.environment !== input.runtime.base.target.environment
      || existing.databaseTargetFingerprint
        !== input.runtime.base.target.databaseTargetFingerprint
      || existing.manifestSha256 !== input.runtime.base.target.manifestSha256
    ) {
      fail(
        "STANDING_WAVE_WEB_IDEMPOTENCY_COLLISION",
        "request id belongs to another command",
      );
    }
    return existing.commandId;
  }
  const sourceCommandId = input.sourceCommandId ?? null;
  if (
    (input.operation === "START" && sourceCommandId !== null)
    || (input.operation === "RESUME" && sourceCommandId === null)
  ) {
    fail(
      "STANDING_WAVE_WEB_SOURCE_INVALID",
      "operation and source command are inconsistent",
    );
  }
  if (sourceCommandId !== null) safeToken(sourceCommandId, "sourceCommandId");
  const seed = sha256(canonicalBytes({
    requestId,
    operation: input.operation,
    sourceCommandId,
    release: input.runtime.base.engine,
    target: input.runtime.base.target,
    policies: {
      provider: input.runtime.standingProviderPolicySha256,
      noPaid: input.runtime.standingNoPaidPolicySha256,
    },
  }));
  const commandId = `ptswc-${seed.slice(0, 32)}`;
  const now = input.now ?? new Date();
  const request = requestFor({
    runtime: input.runtime,
    requestId,
    operation: input.operation,
    sourceCommandId,
    requestedAt: now,
  });
  const requestBytes = Buffer.from(
    renderProductTruthStandingWaveWebRequest(request),
    "utf8",
  );
  const artifact = sealProductTruthControlArtifact({
    artifactId: `pta-${seed.slice(0, 32)}-request`,
    commandId,
    role: "REQUEST",
    mediaType: "application/json",
    content: requestBytes,
    createdAt: now.toISOString(),
    createdByPrincipal: requestedByUserId,
  });
  await prisma.$transaction(async (tx) => {
    const active = await tx.productTruthControlCommand.findFirst({
      where: {
        commandKind: PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND,
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { commandId: true },
    });
    if (active) {
      fail(
        "STANDING_WAVE_WEB_ALREADY_ACTIVE",
        `command ${active.commandId} is already active`,
      );
    }
    let workspaceKey = commandId;
    if (sourceCommandId !== null) {
      const source = await tx.productTruthControlCommand.findUnique({
        where: { commandId: sourceCommandId },
        include: {
          artifacts: { where: { role: "REQUEST" } },
        },
      });
      if (
        !source
        || source.commandKind !== PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND
        || !["AMBIGUOUS", "FAILED"].includes(source.status)
        || !source.runId
      ) {
        fail(
          "STANDING_WAVE_WEB_RESUME_FORBIDDEN",
          "source is not a terminal resumable standing wave",
        );
      }
      const sourceRequest = requestArtifact(source);
      if (
        !runtimeMatchesRequest(input.runtime, sourceRequest)
        || source.engineReleaseId !== input.runtime.base.engine.releaseId
        || source.engineCommitSha !== input.runtime.base.engine.commitSha
        || source.engineTreeSha !== input.runtime.base.engine.treeSha
        || source.executableTreeSha256
          !== input.runtime.base.engine.executableTreeSha256
        || source.environment !== input.runtime.base.target.environment
        || source.databaseTargetFingerprint
          !== input.runtime.base.target.databaseTargetFingerprint
        || source.manifestSha256 !== input.runtime.base.target.manifestSha256
      ) {
        fail(
          "STANDING_WAVE_WEB_RESUME_BINDING_DRIFT",
          "source differs from the active release, target, manifest, or policies",
        );
      }
      workspaceKey = safeToken(source.runId, "source.runId");
    }
    await tx.productTruthControlCommand.create({
      data: {
        commandId,
        schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION,
        commandKind: PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND,
        gateClass: PRODUCT_TRUTH_STANDING_WAVE_WEB_GATE_CLASS,
        status: "DRAFT",
        idempotencyKey,
        requestSha256: sha256(requestBytes),
        requestedByUserId,
        requestedAt: now,
        engineReleaseId: input.runtime.base.engine.releaseId,
        engineCommitSha: input.runtime.base.engine.commitSha,
        engineTreeSha: input.runtime.base.engine.treeSha,
        executableTreeSha256:
          input.runtime.base.engine.executableTreeSha256,
        environment: input.runtime.base.target.environment,
        databaseTargetFingerprint:
          input.runtime.base.target.databaseTargetFingerprint,
        manifestSha256: input.runtime.base.target.manifestSha256,
        runId: workspaceKey,
        approvalId:
          `standing:${input.runtime.standingProviderPolicySha256.slice(0, 24)}`,
        requestArtifactId: artifact.artifactId,
        maxAttempts: 1,
      },
    });
    await tx.productTruthControlArtifact.create({
      data: {
        artifactId: artifact.artifactId,
        commandId: artifact.commandId,
        schemaVersion: artifact.schemaVersion,
        role: artifact.role,
        mediaType: artifact.mediaType,
        content: prismaBytes(artifact.content),
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        locator: artifact.locator,
        createdAt: new Date(artifact.createdAt),
        createdByPrincipal: artifact.createdByPrincipal,
      },
    });
    await appendEvent(tx, {
      commandId,
      eventType: "REQUESTED",
      source: "SERVER",
      occurredAt: now.toISOString(),
      payload: {
        operation: request.operation,
        requestId,
        sourceCommandId,
      },
    });
    await tx.productTruthControlCommand.update({
      where: { commandId },
      data: { status: "VALIDATING" },
    });
    await appendEvent(tx, {
      commandId,
      eventType: "ARTIFACTS_VALIDATED",
      source: "SERVER",
      occurredAt: now.toISOString(),
      payload: {
        requestArtifactSha256: artifact.sha256,
        requestArtifactByteSize: artifact.byteSize,
        standingProviderPolicySha256:
          input.runtime.standingProviderPolicySha256,
        standingNoPaidPolicySha256:
          input.runtime.standingNoPaidPolicySha256,
      },
    });
    await tx.productTruthControlCommand.update({
      where: { commandId },
      data: { status: "ADMITTED" },
    });
    await appendEvent(tx, {
      commandId,
      eventType: "ADMITTED",
      source: "SERVER",
      occurredAt: now.toISOString(),
      payload: {
        authority: "PINNED_STANDING_POLICY",
        ownerPromptRequired: false,
        maximumProviderUnits:
          PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS,
        automaticRetry: false,
        marketplaceMutations: 0,
      },
    });
  });
  return commandId;
}

function leaseMatches(
  row: {
    workerLeaseTokenSha256: string | null;
    workerLeaseExpiresAt: Date | null;
  },
  leaseToken: string,
  now: Date,
): boolean {
  return (
    row.workerLeaseTokenSha256 === sha256(leaseToken)
    && row.workerLeaseExpiresAt !== null
    && row.workerLeaseExpiresAt.getTime() > now.getTime()
  );
}

export async function reconcileExpiredProductTruthStandingWaveWebCommands(
  now = new Date(),
): Promise<void> {
  const rows = await prisma.productTruthControlCommand.findMany({
    where: {
      commandKind: PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND,
      status: { in: ["CLAIMED", "RUNNING"] },
      workerLeaseExpiresAt: { lte: now },
    },
    select: {
      commandId: true,
      status: true,
      executionBoundary: true,
    },
  });
  for (const row of rows) {
    await prisma.$transaction(async (tx) => {
      if (row.status === "CLAIMED" && row.executionBoundary === null) {
        const evidenceBytes = canonicalBytes({
          schemaVersion:
            "product-truth-standing-wave-zero-attempt-evidence/1.0.0",
          commandId: row.commandId,
          observedAt: now.toISOString(),
          attempts: 0,
          executionBoundary: null,
          providerCalls: 0,
          automaticRetry: false,
        });
        const evidence = sealProductTruthControlArtifact({
          artifactId:
            `pta-${row.commandId.slice(6)}-zero-${sha256(evidenceBytes).slice(0, 8)}`,
          commandId: row.commandId,
          role: "RESULT",
          mediaType: "application/json",
          content: evidenceBytes,
          createdAt: now.toISOString(),
          createdByPrincipal: "standing-wave-lease-reconciler",
        });
        await tx.productTruthControlArtifact.create({
          data: {
            artifactId: evidence.artifactId,
            commandId: evidence.commandId,
            schemaVersion: evidence.schemaVersion,
            role: evidence.role,
            mediaType: evidence.mediaType,
            content: prismaBytes(evidence.content),
            byteSize: evidence.byteSize,
            sha256: evidence.sha256,
            locator: evidence.locator,
            createdAt: new Date(evidence.createdAt),
            createdByPrincipal: evidence.createdByPrincipal,
          },
        });
        const updated = await tx.productTruthControlCommand.updateMany({
          where: {
            commandId: row.commandId,
            status: "CLAIMED",
            executionBoundary: null,
            workerLeaseExpiresAt: { lte: now },
          },
          data: {
            status: "ADMITTED",
            workerLeaseOwner: null,
            workerLeaseTokenSha256: null,
            workerLeaseExpiresAt: null,
            workerHeartbeatAt: null,
            zeroAttemptEvidenceArtifactId: evidence.artifactId,
          },
        });
        if (updated.count !== 1) {
          fail(
            "STANDING_WAVE_WEB_RECONCILE_CONTENTION",
            "zero-attempt lease changed during reconciliation",
          );
        }
        await appendEvent(tx, {
          commandId: row.commandId,
          eventType: "ADMITTED",
          source: "SERVER",
          occurredAt: now.toISOString(),
          payload: {
            reason: "ZERO_ATTEMPT_LEASE_EXPIRED",
            zeroAttemptEvidenceArtifactId: evidence.artifactId,
            zeroAttemptEvidenceSha256: evidence.sha256,
            automaticRetry: false,
            providerCalls: 0,
          },
        });
        return;
      }
      const updated = await tx.productTruthControlCommand.updateMany({
        where: {
          commandId: row.commandId,
          status: "RUNNING",
          workerLeaseExpiresAt: { lte: now },
        },
        data: {
          status: "AMBIGUOUS",
          outcome: "WORKER_LEASE_EXPIRED_AFTER_BOUNDARY",
          errorCode: "STANDING_WAVE_WORKER_LEASE_EXPIRED",
        },
      });
      if (updated.count === 1) {
        await appendEvent(tx, {
          commandId: row.commandId,
          eventType: "AMBIGUOUS",
          source: "SERVER",
          occurredAt: now.toISOString(),
          payload: {
            reason: "WORKER_LEASE_EXPIRED_AFTER_BOUNDARY",
            automaticRetry: false,
            resumeRequiresNewCommand: true,
          },
        });
      }
    });
  }
}

export async function claimProductTruthStandingWaveWebCommand(input: {
  runtime: ProductTruthStandingWaveWebRuntimeActive;
  workerId: string;
  now?: Date;
}): Promise<ProductTruthStandingWaveWebClaim | null> {
  const workerId = safeToken(input.workerId, "workerId");
  const now = input.now ?? new Date();
  await reconcileExpiredProductTruthStandingWaveWebCommands(now);
  const leaseExpiresAt = new Date(
    now.getTime() + PRODUCT_TRUTH_STANDING_WAVE_WEB_LEASE_MS,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await prisma.productTruthControlCommand.findFirst({
      where: {
        commandKind: PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND,
        gateClass: PRODUCT_TRUTH_STANDING_WAVE_WEB_GATE_CLASS,
        status: "ADMITTED",
        environment: input.runtime.base.target.environment,
        databaseTargetFingerprint:
          input.runtime.base.target.databaseTargetFingerprint,
        manifestSha256: input.runtime.base.target.manifestSha256,
        engineReleaseId: input.runtime.base.engine.releaseId,
        engineCommitSha: input.runtime.base.engine.commitSha,
        engineTreeSha: input.runtime.base.engine.treeSha,
        executableTreeSha256:
          input.runtime.base.engine.executableTreeSha256,
      },
      include: {
        artifacts: { where: { role: "REQUEST" } },
      },
      orderBy: { requestedAt: "asc" },
    });
    if (!candidate) return null;
    const request = requestArtifact(candidate);
    if (
      !runtimeMatchesRequest(input.runtime, request)
      || Date.parse(request.expiresAt) <= now.getTime()
      || !candidate.runId
    ) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.productTruthControlCommand.updateMany({
          where: {
            commandId: candidate.commandId,
            status: "ADMITTED",
          },
          data: {
            status: "FAILED",
            outcome: "ADMISSION_BINDING_EXPIRED_OR_DRIFTED",
            errorCode: "STANDING_WAVE_WEB_ADMISSION_DRIFT",
          },
        });
        if (updated.count === 1) {
          await appendEvent(tx, {
            commandId: candidate.commandId,
            eventType: "FAILED",
            source: "SERVER",
            occurredAt: now.toISOString(),
            payload: {
              reason: "ADMISSION_BINDING_EXPIRED_OR_DRIFTED",
              providerCalls: 0,
              marketplaceMutations: 0,
            },
          });
        }
      });
      continue;
    }
    const leaseToken = randomBytes(32).toString("base64url");
    const claimed = await prisma.$transaction(async (tx) => {
      const updated = await tx.productTruthControlCommand.updateMany({
        where: {
          commandId: candidate.commandId,
          status: "ADMITTED",
          attempts: 0,
          executionBoundary: null,
        },
        data: {
          status: "CLAIMED",
          workerLeaseOwner: workerId,
          workerLeaseTokenSha256: sha256(leaseToken),
          workerLeaseExpiresAt: leaseExpiresAt,
          workerHeartbeatAt: now,
        },
      });
      if (updated.count !== 1) return false;
      await appendEvent(tx, {
        commandId: candidate.commandId,
        eventType: "CLAIMED",
        source: "WORKER",
        occurredAt: now.toISOString(),
        payload: {
          workerId,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          attempts: 0,
        },
      });
      return true;
    });
    if (!claimed) continue;
    return {
      schema_version: PRODUCT_TRUTH_STANDING_WAVE_WEB_STORE_VERSION,
      command_id: candidate.commandId,
      operation: request.operation,
      workspace_key: candidate.runId,
      lease_token: leaseToken,
      lease_expires_at: leaseExpiresAt.toISOString(),
      engine: {
        release_id: candidate.engineReleaseId,
        commit_sha: candidate.engineCommitSha,
        tree_sha: candidate.engineTreeSha,
        executable_tree_sha256: candidate.executableTreeSha256,
      },
      target: {
        environment: "PRODUCTION",
        database_target_fingerprint:
          candidate.databaseTargetFingerprint,
        manifest_sha256: candidate.manifestSha256,
      },
      request,
    };
  }
  fail("STANDING_WAVE_WEB_CLAIM_CONTENTION", "claim CAS contention persisted");
}

export async function startProductTruthStandingWaveWebCommand(input: {
  commandId: string;
  leaseToken: string;
  now?: Date;
}): Promise<{ status: "RUNNING"; execution_boundary: string }> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const row = await tx.productTruthControlCommand.findUnique({
      where: { commandId: input.commandId },
    });
    if (
      !row
      || row.commandKind !== PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND
      || row.status !== "CLAIMED"
      || !leaseMatches(row, input.leaseToken, now)
    ) {
      fail("STANDING_WAVE_WEB_LEASE_INVALID", "claim lease is invalid");
    }
    const boundary = `STANDING_WAVE:${row.requestSha256}`;
    await tx.productTruthControlCommand.update({
      where: { commandId: row.commandId },
      data: {
        status: "RUNNING",
        attempts: 1,
        executionBoundary: boundary,
        executionStartedAt: now,
        workerHeartbeatAt: now,
      },
    });
    await appendEvent(tx, {
      commandId: row.commandId,
      eventType: "EXECUTION_BOUNDARY",
      source: "WORKER",
      occurredAt: now.toISOString(),
      payload: {
        executionBoundary: boundary,
        attempt: 1,
        maximumProviderUnits:
          PRODUCT_TRUTH_STANDING_WAVE_WEB_MAX_PROVIDER_UNITS,
        automaticRetry: false,
        marketplaceMutations: 0,
      },
    });
    return { status: "RUNNING", execution_boundary: boundary };
  });
}

export async function heartbeatProductTruthStandingWaveWebCommand(input: {
  commandId: string;
  leaseToken: string;
  now?: Date;
}): Promise<{ status: "RUNNING"; lease_expires_at: string }> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(
    now.getTime() + PRODUCT_TRUTH_STANDING_WAVE_WEB_LEASE_MS,
  );
  return prisma.$transaction(async (tx) => {
    const row = await tx.productTruthControlCommand.findUnique({
      where: { commandId: input.commandId },
    });
    if (
      !row
      || row.commandKind !== PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND
      || row.status !== "RUNNING"
      || !leaseMatches(row, input.leaseToken, now)
    ) {
      fail("STANDING_WAVE_WEB_LEASE_INVALID", "heartbeat lease is invalid");
    }
    await tx.productTruthControlCommand.update({
      where: { commandId: row.commandId },
      data: {
        workerHeartbeatAt: now,
        workerLeaseExpiresAt: leaseExpiresAt,
      },
    });
    await appendEvent(tx, {
      commandId: row.commandId,
      eventType: "HEARTBEAT",
      source: "WORKER",
      occurredAt: now.toISOString(),
      payload: {
        status: "RUNNING",
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      },
    });
    return {
      status: "RUNNING",
      lease_expires_at: leaseExpiresAt.toISOString(),
    };
  });
}

export async function completeProductTruthStandingWaveWebCommand(input: {
  runtime: ProductTruthStandingWaveWebRuntimeActive;
  commandId: string;
  leaseToken: string;
  result: unknown;
  now?: Date;
}): Promise<{ status: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" }> {
  const result = parseProductTruthStandingWaveWebResult(input.result);
  const now = input.now ?? new Date();
  const command = await prisma.productTruthControlCommand.findUnique({
    where: { commandId: input.commandId },
    include: { artifacts: { where: { role: "REQUEST" } } },
  });
  if (
    !command
    || command.commandKind !== PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND
    || command.status !== "RUNNING"
    || !leaseMatches(command, input.leaseToken, now)
    || result.commandId !== command.commandId
  ) {
    fail("STANDING_WAVE_WEB_LEASE_INVALID", "completion lease is invalid");
  }
  const request = requestArtifact(command);
  if (
    request.operation !== result.operation
    || !runtimeMatchesRequest(input.runtime, request)
  ) {
    fail(
      "STANDING_WAVE_WEB_RESULT_MISMATCH",
      "result differs from request/runtime bindings",
    );
  }
  const resultBytes = Buffer.from(
    renderProductTruthStandingWaveWebResult(result),
    "utf8",
  );
  const artifact = sealProductTruthControlArtifact({
    artifactId:
      `pta-${command.commandId.slice(6)}-result-${sha256(resultBytes).slice(0, 8)}`,
    commandId: command.commandId,
    role: "RESULT",
    mediaType: "application/json",
    content: resultBytes,
    createdAt: now.toISOString(),
    createdByPrincipal: command.workerLeaseOwner ?? "standing-wave-worker",
  });
  const terminalStatus =
    result.outcome === "COMPLETED"
      ? "SUCCEEDED"
      : result.outcome;
  await prisma.$transaction(async (tx) => {
    await tx.productTruthControlArtifact.create({
      data: {
        artifactId: artifact.artifactId,
        commandId: artifact.commandId,
        schemaVersion: artifact.schemaVersion,
        role: artifact.role,
        mediaType: artifact.mediaType,
        content: prismaBytes(artifact.content),
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        locator: artifact.locator,
        createdAt: new Date(artifact.createdAt),
        createdByPrincipal: artifact.createdByPrincipal,
      },
    });
    await appendEvent(tx, {
      commandId: command.commandId,
      eventType: "ARTIFACT_RECEIVED",
      source: "WORKER",
      occurredAt: now.toISOString(),
      payload: {
        role: "RESULT",
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
      },
    });
    await tx.productTruthControlCommand.update({
      where: { commandId: command.commandId },
      data: {
        status: terminalStatus,
        resultArtifactId: artifact.artifactId,
        planSha256: result.planSha256,
        exitCode: result.exitCode,
        outcome: result.outcome,
        errorCode:
          result.outcome === "COMPLETED"
            ? null
            : `STANDING_WAVE_CLI_EXIT_${result.exitCode}`,
      },
    });
    await appendEvent(tx, {
      commandId: command.commandId,
      eventType: terminalStatus,
      source: "WORKER",
      occurredAt: now.toISOString(),
      payload: {
        outcome: result.outcome,
        exitCode: result.exitCode,
        actualProviderUnits: result.actualProviderUnits,
        targetCount: result.targetCount,
        completedTargetCount: result.completedTargetCount,
        ambiguousTargetCount: result.ambiguousTargetCount,
        reportSha256: result.reportSha256,
        readinessReportSha256: result.readinessReportSha256,
        automaticRetry: false,
        marketplaceMutations: 0,
      },
    });
  });
  return { status: terminalStatus };
}

export async function readProductTruthStandingWaveWebStatus(input: {
  runtime: ProductTruthStandingWaveWebRuntimeActive;
  limit?: number;
  now?: Date;
}): Promise<ProductTruthStandingWaveWebStatus> {
  await reconcileExpiredProductTruthStandingWaveWebCommands(
    input.now ?? new Date(),
  );
  const limit = input.limit ?? 12;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    fail("STANDING_WAVE_WEB_LIMIT_INVALID", "status limit must be 1-50");
  }
  const rows = await prisma.productTruthControlCommand.findMany({
    where: {
      commandKind: PRODUCT_TRUTH_STANDING_WAVE_WEB_COMMAND_KIND,
      environment: input.runtime.base.target.environment,
      databaseTargetFingerprint:
        input.runtime.base.target.databaseTargetFingerprint,
      manifestSha256: input.runtime.base.target.manifestSha256,
      engineReleaseId: input.runtime.base.engine.releaseId,
      engineCommitSha: input.runtime.base.engine.commitSha,
      engineTreeSha: input.runtime.base.engine.treeSha,
      executableTreeSha256:
        input.runtime.base.engine.executableTreeSha256,
    },
    include: {
      artifacts: { where: { role: { in: ["REQUEST", "RESULT"] } } },
    },
    orderBy: { requestedAt: "desc" },
    take: limit,
  });
  const commands = rows.map((row) => {
    const request = requestArtifact(row);
    if (!runtimeMatchesRequest(input.runtime, request) || !row.runId) {
      fail(
        "STANDING_WAVE_WEB_STATUS_DRIFT",
        "stored command differs from active runtime",
      );
    }
    const result = resultArtifact(row);
    return {
      commandId: row.commandId,
      operation: request.operation,
      workspaceKey: row.runId,
      status: row.status,
      outcome: row.outcome,
      requestedByUserId: row.requestedByUserId,
      requestedAt: row.requestedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      executionStartedAt: row.executionStartedAt?.toISOString() ?? null,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      errorCode: row.errorCode,
      planSha256: row.planSha256,
      result: result
        ? {
            waveId: result.waveId,
            targetCount: result.targetCount,
            completedTargetCount: result.completedTargetCount,
            ambiguousTargetCount: result.ambiguousTargetCount,
            actualProviderUnits: result.actualProviderUnits,
            reportSha256: result.reportSha256,
            readinessReportSha256: result.readinessReportSha256,
          }
        : null,
    };
  });
  const active = commands.find((row) =>
    (ACTIVE_STATUSES as readonly string[]).includes(row.status),
  ) ?? null;
  const resumable = commands.find((row) =>
    row.status === "AMBIGUOUS"
    || (
      row.status === "FAILED"
      && row.outcome === "FAILED"
    ),
  ) ?? null;
  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_STORE_VERSION,
    status: "ACTIVE",
    canStart: active === null,
    activeCommandId: active?.commandId ?? null,
    resumableCommandId: active === null ? resumable?.commandId ?? null : null,
    commands,
    limits: input.runtime.limits,
    claims: {
      standingPolicyAuthority: true,
      ownerPromptRequired: false,
      automaticRetry: false,
      marketplaceMutations: false,
    },
  };
}
