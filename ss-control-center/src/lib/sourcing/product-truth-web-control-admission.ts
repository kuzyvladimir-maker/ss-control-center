import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

import {
  PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
  PRODUCT_TRUTH_CONTROL_ZERO_HASH,
  canonicalProductTruthControlEnvelope,
  productTruthControlRequestSha256,
  sealProductTruthControlArtifact,
  sealProductTruthControlEvent,
  type ProductTruthControlEnvelope,
  type ProductTruthControlGateClass,
  type ProductTruthControlSealedArtifact,
  type ProductTruthControlSealedEvent,
} from "./product-truth-control-plane";
import {
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  parseProductTruthTargetedWalmartEvidenceRequest,
} from "./product-truth-targeted-walmart-evidence-contract";
import {
  parseProductTruthWalmartCollectionBatch,
  parseProductTruthWalmartCollectionJob,
  type ProductTruthWalmartCollectionBatch,
  type ProductTruthWalmartCollectionJob,
} from "./product-truth-walmart-collection-contract";
import type {
  ProductTruthWebControlRuntimeActive,
} from "./product-truth-web-control-runtime";
import {
  readProductTruthWalmartEnrichmentCommand,
  readProductTruthWalmartEnrichmentQuote,
} from "./product-truth-walmart-enrichment-admission";
import {
  productTruthWalmartEnrichmentQuoteSha256,
} from "./product-truth-walmart-enrichment-quote";

export const PRODUCT_TRUTH_WEB_CONTROL_ADMISSION_VERSION =
  "product-truth-web-control-admission/1.1.0" as const;
const PRODUCT_TRUTH_WEB_CONTROL_TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: 120_000,
} as const;

export type ProductTruthNoSpendCommandKind = "DOCTOR" | "RUN_PLAN";

interface ProductTruthPreparedAdmission {
  commandId: string;
  commandKind: ProductTruthNoSpendCommandKind;
  gateClass: ProductTruthControlGateClass;
  idempotencyKey: string;
  requestedByUserId: string;
  requestedAt: string;
  runId: string;
  envelope: ProductTruthControlEnvelope;
  requestSha256: string;
  requestArtifact: ProductTruthControlSealedArtifact;
  events: readonly ProductTruthControlSealedEvent[];
}

export interface ProductTruthWalmartCollectionStatus {
  schemaVersion: typeof PRODUCT_TRUTH_WEB_CONTROL_ADMISSION_VERSION;
  batchId: string;
  status:
    | "QUEUED_NO_SPEND"
    | "RUNNING_NO_SPEND"
    | "AWAITING_OWNER"
    | "RUNNING_ENRICHMENT"
    | "DECLINED"
    | "FAILED"
    | "AMBIGUOUS"
    | "SUCCEEDED";
  jobs: readonly {
    run_id: string;
    donor_product_id: string;
    title: string;
    missing_fields: readonly string[];
    doctor_status: string;
    plan_status: string | null;
    phase:
      | "QUEUED_NO_SPEND"
      | "RUNNING_NO_SPEND"
      | "AWAITING_OWNER"
      | "FAILED"
      | "AMBIGUOUS"
      | "SUCCEEDED";
    error_code: string | null;
  }[];
  quote: null | {
    quote_id: string;
    quote_sha256: string;
    expires_at: string;
    cost_unit: "PREPAID_PROVIDER_CREDITS";
    usd_equivalent: null;
    balance_probe_maximum_units: number;
    job_maximum_units: number;
    maximum_provider_units: number;
    actions: readonly {
      ordinal: number;
      run_id: string;
      title: string;
      missing_fields: readonly string[];
      oxylabs_query_maximum_units: number;
      unwrangle_detail_maximum_units: number;
      maximum_provider_units: number;
    }[];
  };
  approval: null | {
    command_id: string;
    status: string;
    outcome: string | null;
    error_code: string | null;
    authorized_at: string | null;
    authorization_expires_at: string | null;
    execution_started_at: string | null;
    updated_at: string;
  };
  claims: {
    provider_calls_may_have_started: boolean;
    metered_execution_admitted: boolean;
    marketplace_mutations: false;
  };
}

export class ProductTruthWebControlAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthWebControlAdmissionError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthWebControlAdmissionError(
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

function commandSeed(input: {
  commandKind: ProductTruthNoSpendCommandKind;
  runtime: ProductTruthWebControlRuntimeActive;
  runId: string;
  logicalRequestSha256: string;
}): string {
  return sha256(
    canonicalBytes({
      commandKind: input.commandKind,
      engine: input.runtime.engine,
      target: input.runtime.target,
      runId: input.runId,
      logicalRequestSha256: input.logicalRequestSha256,
    }),
  );
}

function buildEvents(input: {
  commandId: string;
  occurredAt: string;
  commandKind: ProductTruthNoSpendCommandKind;
  runId: string;
  requestArtifact: ProductTruthControlSealedArtifact;
}): readonly ProductTruthControlSealedEvent[] {
  const payloads = [
    {
      eventType: "REQUESTED" as const,
      payload: {
        schemaVersion: PRODUCT_TRUTH_WEB_CONTROL_ADMISSION_VERSION,
        commandKind: input.commandKind,
        runId: input.runId,
      },
    },
    {
      eventType: "ARTIFACTS_VALIDATED" as const,
      payload: {
        schemaVersion: PRODUCT_TRUTH_WEB_CONTROL_ADMISSION_VERSION,
        requestArtifactSha256: input.requestArtifact.sha256,
        requestArtifactByteSize: input.requestArtifact.byteSize,
      },
    },
    {
      eventType: "ADMITTED" as const,
      payload: {
        schemaVersion: PRODUCT_TRUTH_WEB_CONTROL_ADMISSION_VERSION,
        authority: "CATALOG_RBAC_NO_SPEND",
        providerCalls: 0,
        marketplaceMutations: 0,
      },
    },
  ];
  const events: ProductTruthControlSealedEvent[] = [];
  let previousEventHash = PRODUCT_TRUTH_CONTROL_ZERO_HASH;
  for (const [index, event] of payloads.entries()) {
    const sealed = sealProductTruthControlEvent({
      eventId: `ptce-${input.commandId.slice(4)}-${index + 1}`,
      commandId: input.commandId,
      sequence: index + 1,
      eventType: event.eventType,
      source: "SERVER",
      occurredAt: input.occurredAt,
      payload: canonicalBytes(event.payload),
      previousEventHash,
    });
    events.push(sealed);
    previousEventHash = sealed.eventHash;
  }
  return events;
}

function prepareAdmission(input: {
  commandKind: ProductTruthNoSpendCommandKind;
  gateClass: "READ_ONLY" | "ARTIFACT_PLAN";
  runtime: ProductTruthWebControlRuntimeActive;
  requestedByUserId: string;
  requestedAt: string;
  runId: string;
  requestBytes: Uint8Array;
  idempotencyBytes?: Uint8Array;
}): ProductTruthPreparedAdmission {
  const logicalRequestSha256 = sha256(
    input.idempotencyBytes ?? input.requestBytes,
  );
  const seed = commandSeed({
    commandKind: input.commandKind,
    runtime: input.runtime,
    runId: input.runId,
    logicalRequestSha256,
  });
  const commandId = `ptc-${seed.slice(0, 32)}`;
  const requestArtifact = sealProductTruthControlArtifact({
    artifactId: `pta-${seed.slice(0, 32)}`,
    commandId,
    role: "REQUEST",
    mediaType: "application/json",
    content: input.requestBytes,
    createdAt: input.requestedAt,
    createdByPrincipal: input.requestedByUserId,
  });
  const envelope = JSON.parse(
    canonicalProductTruthControlEnvelope({
      schemaVersion: PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
      commandId,
      commandKind: input.commandKind,
      gateClass: input.gateClass,
      engine: {
        releaseId: input.runtime.engine.releaseId,
        commitSha: input.runtime.engine.commitSha,
        treeSha: input.runtime.engine.treeSha,
        executableTreeSha256: input.runtime.engine.executableTreeSha256,
      },
      target: {
        environment: input.runtime.target.environment,
        databaseTargetFingerprint:
          input.runtime.target.databaseTargetFingerprint,
        manifestSha256: input.runtime.target.manifestSha256,
      },
      artifacts: [
        {
          role: "REQUEST",
          sha256: requestArtifact.sha256,
          byteSize: requestArtifact.byteSize,
        },
      ],
      authority: {
        ownerKeyId: null,
        issuedAt: null,
        expiresAt: null,
        nonce: null,
      },
      claims: {
        noImplicitScope: true,
        noMarketplaceMutation: true,
        ambiguousNeverReplay: true,
        bjsForbidden: true,
        clubsRequireSeparateGate: true,
      },
    }),
  ) as ProductTruthControlEnvelope;
  return {
    commandId,
    commandKind: input.commandKind,
    gateClass: input.gateClass,
    idempotencyKey: `product-truth-control:${seed}`,
    requestedByUserId: input.requestedByUserId,
    requestedAt: input.requestedAt,
    runId: input.runId,
    envelope,
    requestSha256: productTruthControlRequestSha256(envelope),
    requestArtifact,
    events: buildEvents({
      commandId,
      occurredAt: input.requestedAt,
      commandKind: input.commandKind,
      runId: input.runId,
      requestArtifact,
    }),
  };
}

function exactJobBytes(job: ProductTruthWalmartCollectionJob): Buffer {
  const parsed = parseProductTruthWalmartCollectionJob(job);
  return canonicalBytes(parsed);
}

function exactJobIdentityBytes(job: ProductTruthWalmartCollectionJob): Buffer {
  const parsed = parseProductTruthWalmartCollectionJob(job);
  return canonicalBytes({
    schemaVersion: parsed.schemaVersion,
    batchId: parsed.batchId,
    runId: parsed.runId,
    ordinal: parsed.ordinal,
    target: parsed.target,
    noSpendSequence: parsed.noSpendSequence,
    meteredStep: parsed.meteredStep,
    policy: parsed.policy,
    claims: parsed.claims,
  });
}

function exactRunPlanIdentityBytes(targetedRequest: unknown): Buffer {
  const parsed = parseProductTruthTargetedWalmartEvidenceRequest(
    targetedRequest,
  );
  return canonicalBytes({
    ...parsed,
    createdAt: null,
    expiresAt: null,
  });
}

export function prepareProductTruthWalmartDoctorAdmissions(input: {
  batch: unknown;
  runtime: ProductTruthWebControlRuntimeActive;
}): readonly ProductTruthPreparedAdmission[] {
  const batch = parseProductTruthWalmartCollectionBatch(input.batch);
  return batch.jobs.map((job) =>
    prepareAdmission({
      commandKind: "DOCTOR",
      gateClass: "READ_ONLY",
      runtime: input.runtime,
      requestedByUserId: batch.requestedByUserId,
      requestedAt: batch.requestedAt,
      runId: job.runId,
      requestBytes: exactJobBytes(job),
      idempotencyBytes: exactJobIdentityBytes(job),
    }),
  );
}

export function prepareProductTruthWalmartRunPlanAdmission(input: {
  targetedRequest: unknown;
  runtime: ProductTruthWebControlRuntimeActive;
  requestedByUserId: string;
  requestedAt: string;
}): ProductTruthPreparedAdmission {
  const targetedRequest = parseProductTruthTargetedWalmartEvidenceRequest(
    input.targetedRequest,
  );
  return prepareAdmission({
    commandKind: "RUN_PLAN",
    gateClass: "ARTIFACT_PLAN",
    runtime: input.runtime,
    requestedByUserId: input.requestedByUserId,
    requestedAt: input.requestedAt,
    runId: targetedRequest.runId,
    requestBytes: Buffer.from(
      renderProductTruthOperationalJson(targetedRequest),
      "utf8",
    ),
    idempotencyBytes: exactRunPlanIdentityBytes(targetedRequest),
  });
}

async function persistPreparedAdmission(
  tx: Prisma.TransactionClient,
  admission: ProductTruthPreparedAdmission,
): Promise<void> {
  const existing = await tx.productTruthControlCommand.findUnique({
    where: { idempotencyKey: admission.idempotencyKey },
    select: {
      commandId: true,
      commandKind: true,
      gateClass: true,
      requestedByUserId: true,
      runId: true,
      engineReleaseId: true,
      engineCommitSha: true,
      engineTreeSha: true,
      executableTreeSha256: true,
      environment: true,
      databaseTargetFingerprint: true,
      manifestSha256: true,
    },
  });
  if (existing) {
    if (
      existing.commandId !== admission.commandId
      || existing.commandKind !== admission.commandKind
      || existing.gateClass !== admission.gateClass
      || existing.requestedByUserId !== admission.requestedByUserId
      || existing.runId !== admission.runId
      || existing.engineReleaseId !== admission.envelope.engine.releaseId
      || existing.engineCommitSha !== admission.envelope.engine.commitSha
      || existing.engineTreeSha !== admission.envelope.engine.treeSha
      || existing.executableTreeSha256
        !== admission.envelope.engine.executableTreeSha256
      || existing.environment !== admission.envelope.target.environment
      || existing.databaseTargetFingerprint
        !== admission.envelope.target.databaseTargetFingerprint
      || existing.manifestSha256 !== admission.envelope.target.manifestSha256
    ) {
      fail(
        "WEB_CONTROL_IDEMPOTENCY_COLLISION",
        "existing command differs from the exact logical request",
      );
    }
    return;
  }

  await tx.productTruthControlCommand.create({
    data: {
      commandId: admission.commandId,
      schemaVersion: PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
      commandKind: admission.commandKind,
      gateClass: admission.gateClass,
      status: "DRAFT",
      idempotencyKey: admission.idempotencyKey,
      requestSha256: admission.requestSha256,
      requestedByUserId: admission.requestedByUserId,
      requestedAt: new Date(admission.requestedAt),
      engineReleaseId: admission.envelope.engine.releaseId,
      engineCommitSha: admission.envelope.engine.commitSha,
      engineTreeSha: admission.envelope.engine.treeSha,
      executableTreeSha256:
        admission.envelope.engine.executableTreeSha256,
      environment: admission.envelope.target.environment,
      databaseTargetFingerprint:
        admission.envelope.target.databaseTargetFingerprint,
      manifestSha256: admission.envelope.target.manifestSha256,
      runId: admission.runId,
      requestArtifactId: admission.requestArtifact.artifactId,
      maxAttempts: 1,
    },
  });
  await tx.productTruthControlArtifact.create({
    data: {
      artifactId: admission.requestArtifact.artifactId,
      commandId: admission.commandId,
      schemaVersion: admission.requestArtifact.schemaVersion,
      role: admission.requestArtifact.role,
      mediaType: admission.requestArtifact.mediaType,
      content: prismaBytes(admission.requestArtifact.content),
      byteSize: admission.requestArtifact.byteSize,
      sha256: admission.requestArtifact.sha256,
      locator: admission.requestArtifact.locator,
      createdAt: new Date(admission.requestArtifact.createdAt),
      createdByPrincipal: admission.requestArtifact.createdByPrincipal,
    },
  });
  await tx.productTruthControlEvent.create({
    data: {
      eventId: admission.events[0].eventId,
      commandId: admission.commandId,
      schemaVersion: admission.events[0].schemaVersion,
      sequence: admission.events[0].sequence,
      eventType: admission.events[0].eventType,
      source: admission.events[0].source,
      occurredAt: new Date(admission.events[0].occurredAt),
      payload: prismaBytes(admission.events[0].payload),
      payloadSha256: admission.events[0].payloadSha256,
      previousEventHash: admission.events[0].previousEventHash,
      eventHash: admission.events[0].eventHash,
    },
  });
  await tx.productTruthControlCommand.update({
    where: { commandId: admission.commandId },
    data: { status: "VALIDATING" },
  });
  await tx.productTruthControlEvent.createMany({
    data: admission.events.slice(1, 2).map((event) => ({
      eventId: event.eventId,
      commandId: admission.commandId,
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      eventType: event.eventType,
      source: event.source,
      occurredAt: new Date(event.occurredAt),
      payload: prismaBytes(event.payload),
      payloadSha256: event.payloadSha256,
      previousEventHash: event.previousEventHash,
      eventHash: event.eventHash,
    })),
  });
  await tx.productTruthControlCommand.update({
    where: { commandId: admission.commandId },
    data: { status: "ADMITTED" },
  });
  await tx.productTruthControlEvent.create({
    data: {
      eventId: admission.events[2].eventId,
      commandId: admission.commandId,
      schemaVersion: admission.events[2].schemaVersion,
      sequence: admission.events[2].sequence,
      eventType: admission.events[2].eventType,
      source: admission.events[2].source,
      occurredAt: new Date(admission.events[2].occurredAt),
      payload: prismaBytes(admission.events[2].payload),
      payloadSha256: admission.events[2].payloadSha256,
      previousEventHash: admission.events[2].previousEventHash,
      eventHash: admission.events[2].eventHash,
    },
  });
}

export async function admitProductTruthWalmartCollectionBatch(input: {
  batch: ProductTruthWalmartCollectionBatch;
  runtime: ProductTruthWebControlRuntimeActive;
}): Promise<ProductTruthWalmartCollectionStatus> {
  const batch = parseProductTruthWalmartCollectionBatch(input.batch);
  const admissions = prepareProductTruthWalmartDoctorAdmissions({
    batch,
    runtime: input.runtime,
  });
  try {
    await prisma.$transaction(async (tx) => {
      for (const admission of admissions) {
        await persistPreparedAdmission(tx, admission);
      }
    }, PRODUCT_TRUTH_WEB_CONTROL_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof ProductTruthWebControlAdmissionError) throw error;
    fail(
      "WEB_CONTROL_ADMISSION_FAILED",
      "immutable no-spend commands were not admitted",
      error,
    );
  }
  return readProductTruthWalmartCollectionStatus({
    batchId: batch.batchId,
    requestedByUserId: batch.requestedByUserId,
    runtime: input.runtime,
  });
}

export async function admitProductTruthWalmartRunPlan(input: {
  targetedRequest: unknown;
  runtime: ProductTruthWebControlRuntimeActive;
  requestedByUserId: string;
  requestedAt: string;
}): Promise<string> {
  const admission = prepareProductTruthWalmartRunPlanAdmission(input);
  try {
    await prisma.$transaction(async (tx) => {
      await persistPreparedAdmission(tx, admission);
    }, PRODUCT_TRUTH_WEB_CONTROL_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof ProductTruthWebControlAdmissionError) throw error;
    fail(
      "WEB_CONTROL_PLAN_ADMISSION_FAILED",
      "immutable run-plan command was not admitted",
      error,
    );
  }
  return admission.commandId;
}

function decodeExactJobArtifact(content: Uint8Array): ProductTruthWalmartCollectionJob {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    fail("WEB_CONTROL_ARTIFACT_INVALID", "job artifact is not UTF-8", error);
  }
  if (!text.endsWith("\n") || text.includes("\r")) {
    fail("WEB_CONTROL_ARTIFACT_INVALID", "job artifact bytes are not canonical");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail("WEB_CONTROL_ARTIFACT_INVALID", "job artifact is not JSON", error);
  }
  const job = parseProductTruthWalmartCollectionJob(parsed);
  if (text !== `${JSON.stringify(job)}\n`) {
    fail("WEB_CONTROL_ARTIFACT_INVALID", "job artifact changed after sealing");
  }
  return job;
}

function jobPhase(input: {
  doctorStatus: string;
  planStatus: string | null;
}): ProductTruthWalmartCollectionStatus["jobs"][number]["phase"] {
  if (input.doctorStatus === "AMBIGUOUS" || input.planStatus === "AMBIGUOUS") {
    return "AMBIGUOUS";
  }
  if (
    ["BLOCKED", "FAILED", "CANCELLED"].includes(input.doctorStatus)
    || (
      input.planStatus !== null
      && ["BLOCKED", "FAILED", "CANCELLED"].includes(input.planStatus)
    )
  ) {
    return "FAILED";
  }
  if (input.planStatus === "SUCCEEDED") return "AWAITING_OWNER";
  if (
    ["CLAIMED", "RUNNING", "SUCCEEDED"].includes(input.doctorStatus)
    || (
      input.planStatus !== null
      && ["CLAIMED", "RUNNING"].includes(input.planStatus)
    )
  ) {
    return "RUNNING_NO_SPEND";
  }
  return "QUEUED_NO_SPEND";
}

export async function readProductTruthWalmartCollectionStatus(input: {
  batchId: string;
  requestedByUserId?: string;
  runtime: ProductTruthWebControlRuntimeActive;
}): Promise<ProductTruthWalmartCollectionStatus> {
  const rows = await prisma.productTruthControlCommand.findMany({
    where: {
      runId: { startsWith: `${input.batchId}-` },
      ...(input.requestedByUserId
        ? { requestedByUserId: input.requestedByUserId }
        : {}),
      engineReleaseId: input.runtime.engine.releaseId,
      engineCommitSha: input.runtime.engine.commitSha,
      engineTreeSha: input.runtime.engine.treeSha,
      executableTreeSha256:
        input.runtime.engine.executableTreeSha256,
      environment: input.runtime.target.environment,
      databaseTargetFingerprint:
        input.runtime.target.databaseTargetFingerprint,
      manifestSha256: input.runtime.target.manifestSha256,
    },
    include: {
      artifacts: {
        where: { role: "REQUEST" },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ requestedAt: "asc" }, { commandKind: "asc" }],
  });
  const doctorRows = rows.filter((row) => row.commandKind === "DOCTOR");
  if (doctorRows.length < 1) {
    fail("WEB_CONTROL_BATCH_NOT_FOUND", "collection batch does not exist");
  }
  const planByRun = new Map(
    rows
      .filter((row) => row.commandKind === "RUN_PLAN" && row.runId)
      .map((row) => [row.runId as string, row]),
  );
  const jobs = doctorRows.map((doctor) => {
    const artifact = doctor.artifacts[0];
    if (!artifact || sha256(artifact.content) !== artifact.sha256) {
      fail(
        "WEB_CONTROL_ARTIFACT_INTEGRITY_MISMATCH",
        "doctor request artifact is missing or corrupt",
      );
    }
    const job = decodeExactJobArtifact(artifact.content);
    const plan = planByRun.get(job.runId) ?? null;
    const phase = jobPhase({
      doctorStatus: doctor.status,
      planStatus: plan?.status ?? null,
    });
    return {
      run_id: job.runId,
      donor_product_id: job.target.donorProductId,
      title: job.target.title,
      missing_fields: job.target.missingFields,
      doctor_status: doctor.status,
      plan_status: plan?.status ?? null,
      phase,
      error_code: plan?.errorCode ?? doctor.errorCode,
    };
  });
  const phases = new Set(jobs.map((job) => job.phase));
  let status: ProductTruthWalmartCollectionStatus["status"] =
    phases.has("AMBIGUOUS")
      ? "AMBIGUOUS"
      : phases.has("FAILED")
        ? "FAILED"
        : [...phases].every((phase) => phase === "SUCCEEDED")
          ? "SUCCEEDED"
          : [...phases].every((phase) => phase === "AWAITING_OWNER")
            ? "AWAITING_OWNER"
            : phases.has("RUNNING_NO_SPEND")
              ? "RUNNING_NO_SPEND"
              : "QUEUED_NO_SPEND";
  let quote: ProductTruthWalmartCollectionStatus["quote"] = null;
  if ([...phases].every((phase) => phase === "AWAITING_OWNER")) {
    const exactQuote = await readProductTruthWalmartEnrichmentQuote({
      batchId: input.batchId,
      ...(input.requestedByUserId
        ? { requestedByUserId: input.requestedByUserId }
        : {}),
      runtime: input.runtime,
    });
    quote = {
      quote_id: exactQuote.quoteId,
      quote_sha256:
        productTruthWalmartEnrichmentQuoteSha256(exactQuote),
      expires_at: exactQuote.expiresAt,
      cost_unit: "PREPAID_PROVIDER_CREDITS",
      usd_equivalent: null,
      balance_probe_maximum_units:
        exactQuote.totals.balanceProbeMaximumUnits,
      job_maximum_units: 3.5,
      maximum_provider_units:
        exactQuote.totals.maximumProviderUnits,
      actions: exactQuote.actions.jobs.map((job) => ({
        ordinal: job.ordinal,
        run_id: job.runId,
        title: job.title,
        missing_fields: job.missingFields,
        oxylabs_query_maximum_units: job.oxylabs.maximumProviderUnits,
        unwrangle_detail_maximum_units:
          job.unwrangle.maximumProviderUnits,
        maximum_provider_units: job.maximumProviderUnits,
      })),
    };
  }
  const enrichment = await readProductTruthWalmartEnrichmentCommand({
    batchId: input.batchId,
    ...(input.requestedByUserId
      ? { requestedByUserId: input.requestedByUserId }
      : {}),
    runtime: input.runtime,
  });
  if (enrichment) {
    if (["ADMITTED", "CLAIMED", "RUNNING"].includes(enrichment.status)) {
      status = "RUNNING_ENRICHMENT";
    } else if (enrichment.status === "SUCCEEDED") {
      status = "SUCCEEDED";
    } else if (enrichment.status === "CANCELLED") {
      status = "DECLINED";
    } else if (enrichment.status === "AMBIGUOUS") {
      status = "AMBIGUOUS";
    } else if (["BLOCKED", "FAILED"].includes(enrichment.status)) {
      status = "FAILED";
    }
  }
  return {
    schemaVersion: PRODUCT_TRUTH_WEB_CONTROL_ADMISSION_VERSION,
    batchId: input.batchId,
    status,
    jobs,
    quote,
    approval: enrichment
      ? {
          command_id: enrichment.commandId,
          status: enrichment.status,
          outcome: enrichment.outcome,
          error_code: enrichment.errorCode,
          authorized_at:
            enrichment.ownerAuthorizedAt?.toISOString() ?? null,
          authorization_expires_at:
            enrichment.ownerAuthorizationExpiresAt?.toISOString() ?? null,
          execution_started_at:
            enrichment.executionStartedAt?.toISOString() ?? null,
          updated_at: enrichment.updatedAt.toISOString(),
        }
      : null,
    claims: {
      provider_calls_may_have_started:
        enrichment?.executionStartedAt !== null
        && enrichment?.executionStartedAt !== undefined,
      metered_execution_admitted:
        enrichment !== null
        && ["ADMITTED", "CLAIMED", "RUNNING", "SUCCEEDED"].includes(
          enrichment.status,
        ),
      marketplace_mutations: false,
    },
  };
}
