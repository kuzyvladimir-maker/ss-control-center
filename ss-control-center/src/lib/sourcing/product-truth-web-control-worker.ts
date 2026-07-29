import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

import {
  sealProductTruthControlArtifact,
  sealProductTruthControlEvent,
} from "./product-truth-control-plane";
import {
  admitProductTruthWalmartRunPlan,
} from "./product-truth-web-control-admission";
import {
  parseProductTruthWalmartCollectionJob,
} from "./product-truth-walmart-collection-contract";
import type {
  ProductTruthWebControlRuntimeActive,
} from "./product-truth-web-control-runtime";
import {
  ProductTruthWorkerContractError,
  parseProductTruthWorkerResult,
  renderProductTruthWorkerResult,
  verifiedProductTruthDoctorRequest,
  verifiedProductTruthRunPlan,
} from "./product-truth-web-control-worker-contract";

export const PRODUCT_TRUTH_WEB_WORKER_LEASE_MS = 15 * 60_000;

export interface ProductTruthWebWorkerClaim {
  command_id: string;
  command_kind: "DOCTOR" | "RUN_PLAN";
  lease_token: string;
  lease_expires_at: string;
  engine: {
    release_id: string;
    commit_sha: string;
    tree_sha: string;
    executable_tree_sha256: string;
  };
  target: {
    environment: string;
    database_target_fingerprint: string;
    manifest_sha256: string;
  };
  spec:
    | {
        kind: "DOCTOR";
        donor_product_id: string;
        query: string;
        run_id: string;
        expires_at: string;
        unwrangle_reserve_floor: number;
      }
    | {
        kind: "RUN_PLAN";
        run_id: string;
        request_sha256: string;
        request_content_base64: string;
      };
}

export class ProductTruthWebWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthWebWorkerError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthWebWorkerError(
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

function safeWorkerId(value: string): string {
  if (
    value.length < 8
    || value.length > 100
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(value)
  ) {
    fail("WORKER_ID_INVALID", "worker_id must be a safe 8-100 character token");
  }
  return value;
}

function exactRequestArtifact(
  row: {
    requestArtifactId: string | null;
    artifacts: readonly {
      artifactId: string;
      content: Uint8Array;
      sha256: string;
      byteSize: number;
    }[];
  },
): {
  artifactId: string;
  content: Uint8Array;
  sha256: string;
  byteSize: number;
} {
  const artifact = row.artifacts.find(
    (entry) => entry.artifactId === row.requestArtifactId,
  );
  if (
    !artifact
    || artifact.content.byteLength !== artifact.byteSize
    || sha256(artifact.content) !== artifact.sha256
  ) {
    fail(
      "WORKER_REQUEST_ARTIFACT_INVALID",
      "request artifact is missing or failed its immutable seal",
    );
  }
  return artifact;
}

function parseCanonicalJsonBytes(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("WORKER_REQUEST_ARTIFACT_INVALID", `${label} is not UTF-8`, error);
  }
  if (!text.endsWith("\n") || text.includes("\r")) {
    fail("WORKER_REQUEST_ARTIFACT_INVALID", `${label} bytes are not canonical`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("WORKER_REQUEST_ARTIFACT_INVALID", `${label} is not JSON`, error);
  }
}

async function appendWorkerEvent(
  tx: Prisma.TransactionClient,
  input: {
    commandId: string;
    eventType:
      | "CLAIMED"
      | "HEARTBEAT"
      | "EXECUTION_BOUNDARY"
      | "ARTIFACT_RECEIVED"
      | "SUCCEEDED"
      | "FAILED";
    occurredAt: string;
    payload: unknown;
  },
): Promise<void> {
  const previous = await tx.productTruthControlEvent.findFirst({
    where: { commandId: input.commandId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, eventHash: true },
  });
  if (!previous) {
    fail("WORKER_EVENT_CHAIN_MISSING", "command has no admission event chain");
  }
  const payload = canonicalBytes(input.payload);
  const sequence = previous.sequence + 1;
  const event = sealProductTruthControlEvent({
    eventId:
      `ptce-${input.commandId.slice(4)}-${sequence}-${sha256(payload).slice(0, 8)}`,
    commandId: input.commandId,
    sequence,
    eventType: input.eventType,
    source: "WORKER",
    occurredAt: input.occurredAt,
    payload,
    previousEventHash: previous.eventHash,
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

function buildClaimSpec(
  command: {
    commandId: string;
    commandKind: string;
    runId: string | null;
    requestArtifactId: string | null;
    artifacts: readonly {
      artifactId: string;
      content: Uint8Array;
      sha256: string;
      byteSize: number;
    }[];
  },
): ProductTruthWebWorkerClaim["spec"] {
  const artifact = exactRequestArtifact(command);
  if (command.commandKind === "DOCTOR") {
    const job = parseProductTruthWalmartCollectionJob(
      parseCanonicalJsonBytes(artifact.content, "doctor request"),
    );
    if (job.runId !== command.runId) {
      fail("WORKER_REQUEST_ARTIFACT_INVALID", "doctor run binding drifted");
    }
    return {
      kind: "DOCTOR",
      donor_product_id: job.target.donorProductId,
      query: job.target.query,
      run_id: job.runId,
      expires_at: job.expiresAt,
      unwrangle_reserve_floor:
        job.meteredStep.unwrangle.reserveFloor,
    };
  }
  if (command.commandKind === "RUN_PLAN") {
    const request = parseCanonicalJsonBytes(artifact.content, "run-plan request");
    if (
      !request
      || typeof request !== "object"
      || !("runId" in request)
      || request.runId !== command.runId
    ) {
      fail("WORKER_REQUEST_ARTIFACT_INVALID", "run-plan run binding drifted");
    }
    return {
      kind: "RUN_PLAN",
      run_id: command.runId ?? "",
      request_sha256: artifact.sha256,
      request_content_base64: Buffer.from(artifact.content).toString("base64"),
    };
  }
  fail("WORKER_COMMAND_FORBIDDEN", "worker command is not allowlisted");
}

export async function claimProductTruthNoSpendCommand(input: {
  runtime: ProductTruthWebControlRuntimeActive;
  workerId: string;
  now?: Date;
}): Promise<ProductTruthWebWorkerClaim | null> {
  if (!input.runtime.claims.workerClaims) {
    fail("WORKER_CLAIM_DISABLED", "runtime stage does not permit worker claims");
  }
  const workerId = safeWorkerId(input.workerId);
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + PRODUCT_TRUTH_WEB_WORKER_LEASE_MS);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await prisma.productTruthControlCommand.findFirst({
      where: {
        status: "ADMITTED",
        commandKind: { in: ["DOCTOR", "RUN_PLAN"] },
        gateClass: { in: ["READ_ONLY", "ARTIFACT_PLAN"] },
        environment: input.runtime.target.environment,
        databaseTargetFingerprint:
          input.runtime.target.databaseTargetFingerprint,
        manifestSha256: input.runtime.target.manifestSha256,
        engineReleaseId: input.runtime.engine.releaseId,
        engineCommitSha: input.runtime.engine.commitSha,
        engineTreeSha: input.runtime.engine.treeSha,
        executableTreeSha256:
          input.runtime.engine.executableTreeSha256,
      },
      include: {
        artifacts: {
          where: { role: "REQUEST" },
        },
      },
      orderBy: { requestedAt: "asc" },
    });
    if (!candidate) return null;
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseTokenSha256 = sha256(leaseToken);
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
          workerLeaseTokenSha256: leaseTokenSha256,
          workerLeaseExpiresAt: leaseExpiresAt,
          workerHeartbeatAt: now,
        },
      });
      if (updated.count !== 1) return false;
      await appendWorkerEvent(tx, {
        commandId: candidate.commandId,
        eventType: "CLAIMED",
        occurredAt: now.toISOString(),
        payload: {
          workerId,
          leaseTokenSha256,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          attempts: 0,
          providerCalls: 0,
        },
      });
      return true;
    });
    if (!claimed) continue;
    return {
      command_id: candidate.commandId,
      command_kind: candidate.commandKind as "DOCTOR" | "RUN_PLAN",
      lease_token: leaseToken,
      lease_expires_at: leaseExpiresAt.toISOString(),
      engine: {
        release_id: candidate.engineReleaseId,
        commit_sha: candidate.engineCommitSha,
        tree_sha: candidate.engineTreeSha,
        executable_tree_sha256: candidate.executableTreeSha256,
      },
      target: {
        environment: candidate.environment,
        database_target_fingerprint:
          candidate.databaseTargetFingerprint,
        manifest_sha256: candidate.manifestSha256,
      },
      spec: buildClaimSpec(candidate),
    };
  }
  fail("WORKER_CLAIM_CONTENTION", "could not claim a command after CAS contention");
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

function leaseTokenMatches(
  row: { workerLeaseTokenSha256: string | null },
  leaseToken: string,
): boolean {
  return row.workerLeaseTokenSha256 === sha256(leaseToken);
}

export async function startProductTruthNoSpendCommand(input: {
  commandId: string;
  leaseToken: string;
  now?: Date;
}): Promise<{ status: "RUNNING"; execution_boundary: string }> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const row = await tx.productTruthControlCommand.findUnique({
      where: { commandId: input.commandId },
    });
    const boundary = row ? `NO_SPEND:${row.requestSha256}` : "";
    if (
      row
      && row.status === "RUNNING"
      && row.executionBoundary === boundary
      && leaseMatches(row, input.leaseToken, now)
    ) {
      return { status: "RUNNING" as const, execution_boundary: boundary };
    }
    if (!row || row.status !== "CLAIMED" || !leaseMatches(row, input.leaseToken, now)) {
      fail("WORKER_LEASE_INVALID", "claim lease is absent, expired, or mismatched");
    }
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
    await appendWorkerEvent(tx, {
      commandId: row.commandId,
      eventType: "EXECUTION_BOUNDARY",
      occurredAt: now.toISOString(),
      payload: {
        executionBoundary: boundary,
        attempt: 1,
        shell: false,
        providerCalls: 0,
        marketplaceMutations: 0,
      },
    });
    return { status: "RUNNING", execution_boundary: boundary };
  });
}

export async function heartbeatProductTruthNoSpendCommand(input: {
  commandId: string;
  leaseToken: string;
  now?: Date;
}): Promise<{ status: "CLAIMED" | "RUNNING"; lease_expires_at: string }> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + PRODUCT_TRUTH_WEB_WORKER_LEASE_MS);
  return prisma.$transaction(async (tx) => {
    const row = await tx.productTruthControlCommand.findUnique({
      where: { commandId: input.commandId },
    });
    if (
      !row
      || (row.status !== "CLAIMED" && row.status !== "RUNNING")
      || !leaseMatches(row, input.leaseToken, now)
    ) {
      fail("WORKER_LEASE_INVALID", "heartbeat lease is invalid");
    }
    await tx.productTruthControlCommand.update({
      where: { commandId: row.commandId },
      data: {
        workerHeartbeatAt: now,
        workerLeaseExpiresAt: leaseExpiresAt,
      },
    });
    await appendWorkerEvent(tx, {
      commandId: row.commandId,
      eventType: "HEARTBEAT",
      occurredAt: now.toISOString(),
      payload: {
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        status: row.status,
      },
    });
    return {
      status: row.status,
      lease_expires_at: leaseExpiresAt.toISOString(),
    };
  });
}

function assertResultBoundToCommand(input: {
  command: {
    commandId: string;
    commandKind: string;
    runId: string | null;
    requestArtifactId: string | null;
    artifacts: readonly {
      artifactId: string;
      content: Uint8Array;
      sha256: string;
      byteSize: number;
    }[];
  };
  result: ReturnType<typeof parseProductTruthWorkerResult>;
}): unknown {
  if (
    input.result.commandId !== input.command.commandId
    || input.result.commandKind !== input.command.commandKind
  ) {
    fail("WORKER_RESULT_COMMAND_MISMATCH", "result belongs to another command");
  }
  if (input.result.exitCode !== 0) return null;
  if (input.result.commandKind === "DOCTOR") {
    const request = verifiedProductTruthDoctorRequest(input.result);
    const original = parseProductTruthWalmartCollectionJob(
      parseCanonicalJsonBytes(
        exactRequestArtifact(input.command).content,
        "doctor request",
      ),
    );
    if (
      request.runId !== original.runId
      || request.runId !== input.command.runId
      || request.query !== original.target.query
      || request.donorSnapshot.donorProductId
        !== original.target.donorProductId
    ) {
      fail("WORKER_RESULT_COMMAND_MISMATCH", "doctor result target drifted");
    }
    return request;
  }
  const plan = verifiedProductTruthRunPlan(input.result);
  if (plan.runId !== input.command.runId) {
    fail("WORKER_RESULT_COMMAND_MISMATCH", "run-plan result target drifted");
  }
  return plan;
}

export async function completeProductTruthNoSpendCommand(input: {
  runtime: ProductTruthWebControlRuntimeActive;
  commandId: string;
  leaseToken: string;
  result: unknown;
  now?: Date;
}): Promise<{
  status: "SUCCEEDED" | "FAILED";
  next: "RUN_PLAN_ADMITTED" | "AWAITING_OWNER" | null;
}> {
  let result;
  try {
    result = parseProductTruthWorkerResult(input.result);
  } catch (error) {
    if (error instanceof ProductTruthWorkerContractError) {
      fail(error.code, error.message, error);
    }
    throw error;
  }
  const now = input.now ?? new Date();
  const command = await prisma.productTruthControlCommand.findUnique({
    where: { commandId: input.commandId },
    include: {
      artifacts: { where: { role: { in: ["REQUEST", "RESULT"] } } },
    },
  });
  if (
    !command
  ) {
    fail("WORKER_RESULT_COMMAND_MISMATCH", "completion command is absent");
  }
  const verifiedOutput = assertResultBoundToCommand({ command, result });
  const resultBytes = Buffer.from(renderProductTruthWorkerResult(result), "utf8");
  const terminalStatus = result.exitCode === 0 ? "SUCCEEDED" : "FAILED";
  if (
    (command.status === "SUCCEEDED" || command.status === "FAILED")
    && command.status === terminalStatus
    && command.resultArtifactId !== null
    && leaseTokenMatches(command, input.leaseToken)
  ) {
    const existing = command.artifacts.find(
      (candidate) => candidate.artifactId === command.resultArtifactId,
    );
    if (
      !existing
      || existing.byteSize !== resultBytes.byteLength
      || existing.sha256 !== sha256(resultBytes)
      || !Buffer.from(existing.content).equals(resultBytes)
    ) {
      fail(
        "WORKER_RESULT_COMMAND_MISMATCH",
        "terminal result differs from the durable artifact",
      );
    }
    if (terminalStatus === "FAILED") {
      return { status: "FAILED", next: null };
    }
    if (command.commandKind === "DOCTOR") {
      await admitProductTruthWalmartRunPlan({
        targetedRequest: verifiedOutput,
        runtime: input.runtime,
        requestedByUserId: command.requestedByUserId,
        requestedAt: now.toISOString(),
      });
      return { status: "SUCCEEDED", next: "RUN_PLAN_ADMITTED" };
    }
    return { status: "SUCCEEDED", next: "AWAITING_OWNER" };
  }
  if (
    command.status !== "RUNNING"
    || !leaseMatches(command, input.leaseToken, now)
  ) {
    fail("WORKER_LEASE_INVALID", "completion lease is invalid");
  }
  const artifact = sealProductTruthControlArtifact({
    artifactId: `pta-${command.commandId.slice(4)}-result-${sha256(resultBytes).slice(0, 8)}`,
    commandId: command.commandId,
    role: "RESULT",
    mediaType: "application/json",
    content: resultBytes,
    createdAt: now.toISOString(),
    createdByPrincipal: command.workerLeaseOwner ?? "worker-unknown",
  });
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
    await appendWorkerEvent(tx, {
      commandId: command.commandId,
      eventType: "ARTIFACT_RECEIVED",
      occurredAt: now.toISOString(),
      payload: {
        role: artifact.role,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
      },
    });
    await tx.productTruthControlCommand.update({
      where: { commandId: command.commandId },
      data: {
        status: terminalStatus,
        resultArtifactId: artifact.artifactId,
        exitCode: result.exitCode,
        outcome:
          result.exitCode === 0
            ? "NO_SPEND_ARTIFACT_CREATED"
            : "NO_SPEND_COMMAND_FAILED",
        errorCode:
          result.exitCode === 0
            ? null
            : `CLI_EXIT_${result.exitCode}`,
      },
    });
    await appendWorkerEvent(tx, {
      commandId: command.commandId,
      eventType: terminalStatus,
      occurredAt: now.toISOString(),
      payload: {
        exitCode: result.exitCode,
        resultArtifactSha256: artifact.sha256,
        providerCalls: 0,
        marketplaceMutations: 0,
      },
    });
  });
  if (terminalStatus === "FAILED") {
    return { status: "FAILED", next: null };
  }
  if (command.commandKind === "DOCTOR") {
    await admitProductTruthWalmartRunPlan({
      targetedRequest: verifiedOutput,
      runtime: input.runtime,
      requestedByUserId: command.requestedByUserId,
      requestedAt: now.toISOString(),
    });
    return { status: "SUCCEEDED", next: "RUN_PLAN_ADMITTED" };
  }
  return { status: "SUCCEEDED", next: "AWAITING_OWNER" };
}
