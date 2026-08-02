import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { createClient, type InStatement } from "@libsql/client";
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
import {
  parseProductTruthWalmartEnrichmentQuote,
  productTruthWalmartEnrichmentQuoteSha256,
} from "./product-truth-walmart-enrichment-quote";
import {
  assertProductTruthWalmartEnrichmentResult,
  parseProductTruthWalmartEnrichmentProgress,
  renderProductTruthWalmartEnrichmentResult,
  type ProductTruthWalmartEnrichmentProgress,
  type ProductTruthWalmartEnrichmentResult,
} from "./product-truth-walmart-enrichment-worker-contract";
import {
  parseProductTruthTargetedWalmartEvidencePlan,
} from "./product-truth-targeted-walmart-evidence-contract";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
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
const PRODUCT_TRUTH_WEB_WORKER_TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: 120_000,
} as const;

export interface ProductTruthWebWorkerClaim {
  command_id: string;
  command_kind: "DOCTOR" | "RUN_PLAN" | "EXECUTE";
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
      }
    | {
        kind: "EXECUTE";
        batch_id: string;
        quote_sha256: string;
        quote_content_base64: string;
        plans: readonly {
          run_id: string;
          plan_sha256: string;
          plan_content_base64: string;
        }[];
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
      role: string;
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
  tx: Pick<Prisma.TransactionClient, "productTruthControlEvent">,
  input: {
    commandId: string;
    eventType:
      | "CLAIMED"
      | "HEARTBEAT"
      | "EXECUTION_BOUNDARY"
      | "ARTIFACT_RECEIVED"
      | "SUCCEEDED"
      | "FAILED"
      | "AMBIGUOUS";
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

function sealWorkerEventAfter(input: {
  commandId: string;
  previous: { sequence: number; eventHash: string };
  eventType: "ARTIFACT_RECEIVED" | "SUCCEEDED" | "FAILED" | "AMBIGUOUS";
  occurredAt: string;
  payload: unknown;
}) {
  const payload = canonicalBytes(input.payload);
  const sequence = input.previous.sequence + 1;
  return sealProductTruthControlEvent({
    eventId:
      `ptce-${input.commandId.slice(4)}-${sequence}-${sha256(payload).slice(0, 8)}`,
    commandId: input.commandId,
    sequence,
    eventType: input.eventType,
    source: "WORKER",
    occurredAt: input.occurredAt,
    payload,
    previousEventHash: input.previous.eventHash,
  });
}

function workerEventCreateData(
  event: ReturnType<typeof sealWorkerEventAfter>,
) {
  return {
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
  };
}

type ProductTruthWorkerTerminalStatus = "SUCCEEDED" | "FAILED" | "AMBIGUOUS";

function exactBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function cleanDatabaseEnv(value: string | undefined): string | null {
  const cleaned = value?.trim().replace(/^['"]|['"]$/g, "") ?? "";
  return cleaned || null;
}

function productTruthControlClient() {
  const tursoUrl = cleanDatabaseEnv(process.env.TURSO_DATABASE_URL);
  const tursoToken = cleanDatabaseEnv(process.env.TURSO_AUTH_TOKEN);
  if (tursoUrl && tursoToken) {
    return createClient({ url: tursoUrl, authToken: tursoToken });
  }
  const databaseUrl = cleanDatabaseEnv(process.env.DATABASE_URL);
  return createClient({
    url: databaseUrl ?? `file:${resolve(process.cwd(), "dev.db")}`,
  });
}

async function verifyWorkerTerminalState(input: {
  commandId: string;
  artifact: ReturnType<typeof sealProductTruthControlArtifact>;
  terminalStatus: ProductTruthWorkerTerminalStatus;
  exitCode: number;
  outcome: string;
  errorCode: string | null;
  executionBoundary?: string;
  artifactPayload: unknown;
  terminalPayload: unknown;
}): Promise<boolean> {
  const command = await prisma.productTruthControlCommand.findUnique({
    where: { commandId: input.commandId },
  });
  if (
    !command
    || command.status !== input.terminalStatus
    || command.resultArtifactId !== input.artifact.artifactId
    || command.exitCode !== input.exitCode
    || command.outcome !== input.outcome
    || command.errorCode !== input.errorCode
    || (
      input.executionBoundary !== undefined
      && command.executionBoundary !== input.executionBoundary
    )
  ) {
    return false;
  }
  const artifact = await prisma.productTruthControlArtifact.findUnique({
    where: { artifactId: input.artifact.artifactId },
  });
  if (
    !artifact
    || artifact.commandId !== input.artifact.commandId
    || artifact.schemaVersion !== input.artifact.schemaVersion
    || artifact.role !== input.artifact.role
    || artifact.mediaType !== input.artifact.mediaType
    || artifact.byteSize !== input.artifact.byteSize
    || artifact.sha256 !== input.artifact.sha256
    || artifact.locator !== input.artifact.locator
    || artifact.createdByPrincipal !== input.artifact.createdByPrincipal
    || !exactBytesEqual(artifact.content, input.artifact.content)
  ) {
    fail("WORKER_RESULT_ARTIFACT_CONFLICT", "stored result artifact differs from the exact retry");
  }
  const artifactPayload = canonicalBytes(input.artifactPayload);
  const terminalPayload = canonicalBytes(input.terminalPayload);
  const artifactEvents = await prisma.productTruthControlEvent.findMany({
    where: {
      commandId: input.commandId,
      eventType: "ARTIFACT_RECEIVED",
      payloadSha256: sha256(artifactPayload),
    },
  });
  const terminalEvents = await prisma.productTruthControlEvent.findMany({
    where: {
      commandId: input.commandId,
      eventType: input.terminalStatus,
      payloadSha256: sha256(terminalPayload),
    },
  });
  if (artifactEvents.length !== 1 || terminalEvents.length !== 1) return false;
  const artifactEvent = artifactEvents[0]!;
  const terminalEvent = terminalEvents[0]!;
  if (
    !exactBytesEqual(artifactEvent.payload, artifactPayload)
    || !exactBytesEqual(terminalEvent.payload, terminalPayload)
    || terminalEvent.sequence !== artifactEvent.sequence + 1
    || terminalEvent.previousEventHash !== artifactEvent.eventHash
  ) {
    fail("WORKER_EVENT_CHAIN_CONFLICT", "terminal evidence differs from the exact retry");
  }
  return true;
}

/**
 * Persist an already-computed worker result in one direct libSQL write batch.
 * This avoids Prisma's remote transaction expiry while retaining an atomic
 * command/artifact/hash-chain transition. Unknown outcomes are verified from
 * immutable content; a retry can only resubmit this receipt, never a provider
 * operation.
 */
async function persistWorkerTerminalState(input: {
  commandId: string;
  leaseToken: string;
  artifact: ReturnType<typeof sealProductTruthControlArtifact>;
  terminalStatus: ProductTruthWorkerTerminalStatus;
  exitCode: number;
  outcome: string;
  errorCode: string | null;
  executionBoundary?: string;
  terminalPayload: unknown;
}): Promise<void> {
  const artifactPayload = {
    role: input.artifact.role,
    sha256: input.artifact.sha256,
    byteSize: input.artifact.byteSize,
  };
  const verification = {
    ...input,
    artifactPayload,
  };
  if (await verifyWorkerTerminalState(verification)) return;
  const command = await prisma.productTruthControlCommand.findUnique({
    where: { commandId: input.commandId },
  });
  if (
    !command
    || command.status !== "RUNNING"
    || command.workerLeaseTokenSha256 !== sha256(input.leaseToken)
  ) {
    fail("WORKER_TERMINAL_STATE_CONFLICT", "command is not the exact running execution");
  }
  const previous = await prisma.productTruthControlEvent.findFirst({
    where: { commandId: input.commandId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, eventHash: true },
  });
  if (!previous) {
    fail("WORKER_EVENT_CHAIN_MISSING", "command has no admission event chain");
  }
  const artifactEvent = sealWorkerEventAfter({
    commandId: input.commandId,
    previous,
    eventType: "ARTIFACT_RECEIVED",
    occurredAt: input.artifact.createdAt,
    payload: artifactPayload,
  });
  const terminalEvent = sealWorkerEventAfter({
    commandId: input.commandId,
    previous: artifactEvent,
    eventType: input.terminalStatus,
    occurredAt: input.artifact.createdAt,
    payload: input.terminalPayload,
  });
  const terminalBoundarySql = input.executionBoundary === undefined
    ? ""
    : `, "executionBoundary" = ?`;
  const commandArgs = [
    input.terminalStatus,
    input.artifact.artifactId,
    input.exitCode,
    input.outcome,
    input.errorCode,
    ...(input.executionBoundary === undefined ? [] : [input.executionBoundary]),
    input.artifact.createdAt,
    input.commandId,
    sha256(input.leaseToken),
  ];
  const statements: InStatement[] = [
    {
      sql: `UPDATE "ProductTruthControlCommand"
            SET "status" = ?, "resultArtifactId" = ?, "exitCode" = ?,
                "outcome" = ?, "errorCode" = ?${terminalBoundarySql},
                "updatedAt" = ?
            WHERE "commandId" = ? AND "status" = 'RUNNING'
              AND "workerLeaseTokenSha256" = ?`,
      args: commandArgs,
    },
    {
      sql: `INSERT INTO "ProductTruthControlArtifact" (
              "artifactId", "commandId", "schemaVersion", "role", "mediaType",
              "content", "byteSize", "sha256", "locator", "createdAt",
              "createdByPrincipal"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.artifact.artifactId,
        input.artifact.commandId,
        input.artifact.schemaVersion,
        input.artifact.role,
        input.artifact.mediaType,
        input.artifact.content,
        input.artifact.byteSize,
        input.artifact.sha256,
        input.artifact.locator,
        input.artifact.createdAt,
        input.artifact.createdByPrincipal,
      ],
    },
    {
      sql: `INSERT INTO "ProductTruthControlEvent" (
              "eventId", "commandId", "schemaVersion", "sequence", "eventType",
              "source", "occurredAt", "payload", "payloadSha256",
              "previousEventHash", "eventHash"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        artifactEvent.eventId,
        artifactEvent.commandId,
        artifactEvent.schemaVersion,
        artifactEvent.sequence,
        artifactEvent.eventType,
        artifactEvent.source,
        artifactEvent.occurredAt,
        artifactEvent.payload,
        artifactEvent.payloadSha256,
        artifactEvent.previousEventHash,
        artifactEvent.eventHash,
      ],
    },
    {
      sql: `INSERT INTO "ProductTruthControlEvent" (
              "eventId", "commandId", "schemaVersion", "sequence", "eventType",
              "source", "occurredAt", "payload", "payloadSha256",
              "previousEventHash", "eventHash"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        terminalEvent.eventId,
        terminalEvent.commandId,
        terminalEvent.schemaVersion,
        terminalEvent.sequence,
        terminalEvent.eventType,
        terminalEvent.source,
        terminalEvent.occurredAt,
        terminalEvent.payload,
        terminalEvent.payloadSha256,
        terminalEvent.previousEventHash,
        terminalEvent.eventHash,
      ],
    },
  ];
  const client = productTruthControlClient();
  let batchError: unknown = null;
  try {
    await client.batch(statements, "write");
  } catch (error) {
    batchError = error;
  } finally {
    client.close();
  }
  if (!await verifyWorkerTerminalState(verification)) {
    if (batchError) throw batchError;
    fail("WORKER_TERMINAL_STATE_CONFLICT", "atomic completion batch did not persist exact evidence");
  }
}

function buildClaimSpec(
  command: {
    commandId: string;
    commandKind: string;
    runId: string | null;
    requestArtifactId: string | null;
    artifacts: readonly {
      artifactId: string;
      role: string;
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
  if (command.commandKind === "EXECUTE") {
    const quote = parseProductTruthWalmartEnrichmentQuote(
      parseCanonicalJsonBytes(artifact.content, "enrichment quote"),
    );
    if (quote.batchId !== command.runId) {
      fail("WORKER_REQUEST_ARTIFACT_INVALID", "execute batch binding drifted");
    }
    const planArtifacts = command.artifacts
      .filter((entry) => entry.role === "RUN_PLAN")
      .sort((left, right) => left.sha256.localeCompare(right.sha256, "en-US"));
    if (planArtifacts.length !== quote.actions.jobs.length) {
      fail("WORKER_REQUEST_ARTIFACT_INVALID", "execute plan count drifted");
    }
    const plans = quote.actions.jobs.map((job) => {
      const planArtifact = planArtifacts.find(
        (entry) => entry.sha256 === job.planSha256,
      );
      if (
        !planArtifact
        || planArtifact.content.byteLength !== planArtifact.byteSize
        || sha256(planArtifact.content) !== planArtifact.sha256
      ) {
        fail("WORKER_REQUEST_ARTIFACT_INVALID", "execute plan seal is invalid");
      }
      const plan = parseProductTruthTargetedWalmartEvidencePlan(
        parseCanonicalJsonBytes(planArtifact.content, "execute plan"),
      );
      if (
        plan.runId !== job.runId
        || productTruthOperationalSha256(plan) !== job.planSha256
        || renderProductTruthOperationalJson(plan)
          !== Buffer.from(planArtifact.content).toString("utf8")
      ) {
        fail("WORKER_REQUEST_ARTIFACT_INVALID", "execute plan scope drifted");
      }
      return {
        run_id: job.runId,
        plan_sha256: job.planSha256,
        plan_content_base64:
          Buffer.from(planArtifact.content).toString("base64"),
      };
    });
    return {
      kind: "EXECUTE",
      batch_id: quote.batchId,
      quote_sha256: productTruthWalmartEnrichmentQuoteSha256(quote),
      quote_content_base64: Buffer.from(artifact.content).toString("base64"),
      plans,
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
        OR: [
          { commandKind: "DOCTOR", gateClass: "READ_ONLY" },
          { commandKind: "RUN_PLAN", gateClass: "ARTIFACT_PLAN" },
          ...(input.runtime.claims.meteredExecutionAdmission
            ? [{
                commandKind: "EXECUTE",
                gateClass: "METERED_EXECUTE",
                // An approval is deliberately short-lived. Never claim an
                // EXECUTE command after it expires: start would reject it and
                // the UI would otherwise look busy until the lease timed out.
                ownerAuthorizationExpiresAt: { gt: now },
              }]
            : []),
        ],
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
        artifacts: true,
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
    }, PRODUCT_TRUTH_WEB_WORKER_TRANSACTION_OPTIONS);
    if (!claimed) continue;
    return {
      command_id: candidate.commandId,
      command_kind: candidate.commandKind as "DOCTOR" | "RUN_PLAN" | "EXECUTE",
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

export async function startProductTruthNoSpendCommand(input: {
  commandId: string;
  leaseToken: string;
  now?: Date;
}): Promise<{ status: "RUNNING"; execution_boundary: string }> {
  const now = input.now ?? new Date();
  const row = await prisma.productTruthControlCommand.findUnique({
    where: { commandId: input.commandId },
  });
  const boundary = row
    ? row.commandKind === "EXECUTE"
      ? `METERED_EXECUTE:${row.requestSha256}`
      : `NO_SPEND:${row.requestSha256}`
    : "";
  if (
    row
    && row.status === "RUNNING"
    && row.executionBoundary === boundary
    && leaseMatches(row, input.leaseToken, now)
  ) {
    return { status: "RUNNING", execution_boundary: boundary };
  }
  if (!row || row.status !== "CLAIMED" || !leaseMatches(row, input.leaseToken, now)) {
    fail("WORKER_LEASE_INVALID", "claim lease is absent, expired, or mismatched");
  }
  if (
    row.commandKind === "EXECUTE"
    && (
      row.gateClass !== "METERED_EXECUTE"
      || !row.ownerKeyId
      || !row.ownerSignatureSha256
      || !row.ownerAuthorizationExpiresAt
      || row.ownerAuthorizationExpiresAt.getTime() <= now.getTime()
    )
  ) {
    fail(
      "WORKER_OWNER_AUTHORITY_INVALID",
      "metered execution lacks a current verified owner authority",
    );
  }
  const previous = await prisma.productTruthControlEvent.findFirst({
    where: { commandId: row.commandId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, eventHash: true },
  });
  if (!previous) {
    fail("WORKER_EVENT_CHAIN_MISSING", "command has no admission event chain");
  }
  const eventPayload = canonicalBytes({
    executionBoundary: boundary,
    attempt: 1,
    shell: false,
    providerCalls: row.commandKind === "EXECUTE" ? "OWNER_QUOTE_BOUND" : 0,
    marketplaceMutations: 0,
  });
  const sequence = previous.sequence + 1;
  const event = sealProductTruthControlEvent({
    eventId:
      `ptce-${row.commandId.slice(4)}-${sequence}-${sha256(eventPayload).slice(0, 8)}`,
    commandId: row.commandId,
    sequence,
    eventType: "EXECUTION_BOUNDARY",
    source: "WORKER",
    occurredAt: now.toISOString(),
    payload: eventPayload,
    previousEventHash: previous.eventHash,
  });
  // A sequential/batch transaction is used deliberately. Remote libSQL can
  // abort interactive callback transactions before their configured timeout;
  // the database transition and append-only event must nevertheless commit as
  // one atomic boundary before any provider call is allowed.
  await prisma.$transaction([
    prisma.productTruthControlCommand.update({
      where: { commandId: row.commandId },
      data: {
        status: "RUNNING",
        attempts: 1,
        executionBoundary: boundary,
        executionStartedAt: now,
        workerHeartbeatAt: now,
      },
    }),
    prisma.productTruthControlEvent.create({
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
    }),
  ]);
  return { status: "RUNNING", execution_boundary: boundary };
}

export async function heartbeatProductTruthNoSpendCommand(input: {
  commandId: string;
  leaseToken: string;
  progress?: ProductTruthWalmartEnrichmentProgress | null;
  now?: Date;
}): Promise<{ status: "CLAIMED" | "RUNNING"; lease_expires_at: string }> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + PRODUCT_TRUTH_WEB_WORKER_LEASE_MS);
  const row = await prisma.productTruthControlCommand.findUnique({
    where: { commandId: input.commandId },
  });
  if (
    !row
    || (row.status !== "CLAIMED" && row.status !== "RUNNING")
    || !leaseMatches(row, input.leaseToken, now)
  ) {
    fail("WORKER_LEASE_INVALID", "heartbeat lease is invalid");
  }
  const progress = input.progress === undefined || input.progress === null
    ? null
    : parseProductTruthWalmartEnrichmentProgress(input.progress);
  if (
    progress !== null
    && (
      row.commandKind !== "EXECUTE"
      || row.runId !== progress.batchId
    )
  ) {
    fail(
      "WORKER_PROGRESS_BINDING_INVALID",
      "enrichment progress differs from the exact execute command",
    );
  }
  // A heartbeat does not grant authority or cross an execution boundary. Keep
  // its mutable lease extension to one compare-and-swap statement: Prisma's
  // remote libSQL transaction API can expire intermittently (P2028) even for
  // a short array transaction, which used to turn successful doctor/plan work
  // into CLI_EXIT_1. Any following audit-append failure still fails closed and
  // the worker records a terminal failure through the normal completion path.
  const updated = await prisma.productTruthControlCommand.updateMany({
    where: {
      commandId: row.commandId,
      status: row.status,
      workerLeaseTokenSha256: row.workerLeaseTokenSha256,
      workerLeaseExpiresAt: row.workerLeaseExpiresAt,
    },
    data: {
      workerHeartbeatAt: now,
      workerLeaseExpiresAt: leaseExpiresAt,
    },
  });
  if (updated.count !== 1) {
    fail("WORKER_LEASE_INVALID", "heartbeat lease changed before extension");
  }
  await appendWorkerEvent(prisma, {
    commandId: row.commandId,
    eventType: "HEARTBEAT",
    occurredAt: now.toISOString(),
    payload: {
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      progress,
      status: row.status,
    },
  });
  return {
    status: row.status,
    lease_expires_at: leaseExpiresAt.toISOString(),
  };
}

function assertResultBoundToCommand(input: {
  command: {
    commandId: string;
    commandKind: string;
    runId: string | null;
    requestArtifactId: string | null;
    artifacts: readonly {
      artifactId: string;
      role: string;
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
  status: "SUCCEEDED" | "FAILED" | "AMBIGUOUS";
  next: "RUN_PLAN_ADMITTED" | "AWAITING_OWNER" | null;
}> {
  const now = input.now ?? new Date();
  const command = await prisma.productTruthControlCommand.findUnique({
    where: { commandId: input.commandId },
    include: {
      artifacts: true,
    },
  });
  if (
    !command
    || command.workerLeaseTokenSha256 !== sha256(input.leaseToken)
    || (
      command.status !== "RUNNING"
      && command.status !== "SUCCEEDED"
      && command.status !== "FAILED"
      && command.status !== "AMBIGUOUS"
    )
  ) {
    fail("WORKER_LEASE_INVALID", "completion lease is invalid");
  }
  if (command.commandKind === "EXECUTE") {
    const quoteArtifact = exactRequestArtifact(command);
    const quote = parseProductTruthWalmartEnrichmentQuote(
      parseCanonicalJsonBytes(quoteArtifact.content, "enrichment quote"),
    );
    const result = assertProductTruthWalmartEnrichmentResult({
      result: input.result as ProductTruthWalmartEnrichmentResult,
      quote,
      commandId: command.commandId,
    });
    const resultBytes = Buffer.from(
      renderProductTruthWalmartEnrichmentResult(result),
      "utf8",
    );
    const artifact = sealProductTruthControlArtifact({
      artifactId:
        `pta-${command.commandId.slice(4)}-result-${sha256(resultBytes).slice(0, 8)}`,
      commandId: command.commandId,
      role: "RESULT",
      mediaType: "application/json",
      content: resultBytes,
      createdAt: now.toISOString(),
      createdByPrincipal: command.workerLeaseOwner ?? "worker-unknown",
    });
    const terminalStatus =
      result.status === "COMPLETED"
        ? "SUCCEEDED"
        : result.status === "AMBIGUOUS"
          ? "AMBIGUOUS"
          : "FAILED";
    await persistWorkerTerminalState({
      commandId: command.commandId,
      leaseToken: input.leaseToken,
      artifact,
      terminalStatus,
      exitCode: terminalStatus === "SUCCEEDED" ? 0 : 2,
      outcome: result.status,
      errorCode:
        terminalStatus === "SUCCEEDED" ? null : result.reason.slice(0, 200),
      ...(terminalStatus === "AMBIGUOUS"
        ? { executionBoundary: "UNKNOWN" }
        : {}),
      terminalPayload: {
        outcome: result.status,
        reason: result.reason,
        providerCalls: result.providerCalls,
        providerUnits: result.providerUnits,
        marketplaceMutations: 0,
        resultArtifactSha256: artifact.sha256,
      },
    });
    return { status: terminalStatus, next: null };
  }
  let result;
  try {
    result = parseProductTruthWorkerResult(input.result);
  } catch (error) {
    if (error instanceof ProductTruthWorkerContractError) {
      fail(error.code, error.message, error);
    }
    throw error;
  }
  const verifiedOutput = assertResultBoundToCommand({ command, result });
  const resultBytes = Buffer.from(renderProductTruthWorkerResult(result), "utf8");
  const artifact = sealProductTruthControlArtifact({
    artifactId: `pta-${command.commandId.slice(4)}-result-${sha256(resultBytes).slice(0, 8)}`,
    commandId: command.commandId,
    role: "RESULT",
    mediaType: "application/json",
    content: resultBytes,
    createdAt: now.toISOString(),
    createdByPrincipal: command.workerLeaseOwner ?? "worker-unknown",
  });
  const terminalStatus = result.exitCode === 0 ? "SUCCEEDED" : "FAILED";
  await persistWorkerTerminalState({
    commandId: command.commandId,
    leaseToken: input.leaseToken,
    artifact,
    terminalStatus,
    exitCode: result.exitCode,
    outcome:
      result.exitCode === 0
        ? "NO_SPEND_ARTIFACT_CREATED"
        : "NO_SPEND_COMMAND_FAILED",
    errorCode:
      result.exitCode === 0
        ? null
        : `CLI_EXIT_${result.exitCode}`,
    terminalPayload: {
      exitCode: result.exitCode,
      resultArtifactSha256: artifact.sha256,
      providerCalls: 0,
      marketplaceMutations: 0,
    },
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
