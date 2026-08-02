import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

import {
  PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
  canonicalProductTruthControlEnvelope,
  parseProductTruthControlEnvelopeBytes,
  productTruthControlRequestSha256,
  sealProductTruthControlArtifact,
  sealProductTruthControlEvent,
  verifyProductTruthControlAuthority,
  type ProductTruthControlEnvelope,
  type ProductTruthControlSealedArtifact,
} from "./product-truth-control-plane";
import {
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  parseProductTruthWalmartCollectionJob,
  type ProductTruthWalmartCollectionJob,
} from "./product-truth-walmart-collection-contract";
import {
  buildProductTruthWalmartEnrichmentQuote,
  parseProductTruthWalmartEnrichmentQuote,
  productTruthWalmartEnrichmentQuoteSha256,
  renderProductTruthWalmartEnrichmentQuote,
  type ProductTruthWalmartEnrichmentQuote,
} from "./product-truth-walmart-enrichment-quote";
import {
  parseProductTruthWorkerResult,
  productTruthWorkerResultFile,
  verifiedProductTruthRunPlan,
} from "./product-truth-web-control-worker-contract";
import type {
  ProductTruthWebControlRuntimeActive,
} from "./product-truth-web-control-runtime";

export const PRODUCT_TRUTH_WALMART_OWNER_APPROVAL_AGENT_URL =
  "http://127.0.0.1:47321/v1/sign" as const;
const OWNER_AUTHORITY_MS = 30 * 60_000;
const AUTHORIZATION_ARTIFACT_VERSION =
  "product-truth-walmart-enrichment-owner-authorization/1.0.0" as const;

export interface ProductTruthWalmartEnrichmentApprovalRequest {
  command_id: string;
  command_sha256: string;
  quote: ProductTruthWalmartEnrichmentQuote;
  quote_sha256: string;
  envelope: ProductTruthControlEnvelope;
  owner_agent_url: typeof PRODUCT_TRUTH_WALMART_OWNER_APPROVAL_AGENT_URL;
}

export class ProductTruthWalmartEnrichmentAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthWalmartEnrichmentAdmissionError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthWalmartEnrichmentAdmissionError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(value: Uint8Array | string): string {
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

/**
 * Reads are TARGET-scoped, not release-scoped.
 *
 * Every command row still records the exact engine release that admitted it
 * (audit truth, written once at admission). But an owner's batch must stay
 * visible across engine deployments: during the 2026-08-01 incident twelve
 * releases shipped in fourteen hours, and because reads filtered on all seven
 * release pins, each deploy orphaned the in-flight batch
 * (`WEB_CONTROL_BATCH_NOT_FOUND`), forcing the owner to restart the same
 * request from scratch. Only the environment and the database fingerprint are
 * identity-relevant for reading: they prevent mixing production with local
 * state. See docs/wiki/walmart-bundle-factory-independent-diagnostic-handoff.md.
 */
function exactRuntimeCommandWhere(
  runtime: ProductTruthWebControlRuntimeActive,
) {
  return {
    environment: runtime.target.environment,
    databaseTargetFingerprint:
      runtime.target.databaseTargetFingerprint,
  };
}

function decodeCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("ENRICHMENT_ARTIFACT_INVALID", `${label} is not UTF-8`, error);
  }
  if (!text.endsWith("\n") || text.includes("\r")) {
    fail("ENRICHMENT_ARTIFACT_INVALID", `${label} is not canonical JSON bytes`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("ENRICHMENT_ARTIFACT_INVALID", `${label} is not JSON`, error);
  }
}

function exactArtifact(
  artifacts: readonly {
    role: string;
    content: Uint8Array;
    sha256: string;
    byteSize: number;
  }[],
  role: string,
): {
  role: string;
  content: Uint8Array;
  sha256: string;
  byteSize: number;
} {
  const matches = artifacts.filter((artifact) => artifact.role === role);
  if (
    matches.length !== 1
    || matches[0]!.content.byteLength !== matches[0]!.byteSize
    || sha256(matches[0]!.content) !== matches[0]!.sha256
  ) {
    fail(
      "ENRICHMENT_ARTIFACT_INVALID",
      `expected one exact ${role} artifact`,
    );
  }
  return matches[0]!;
}

async function collectionEntries(input: {
  batchId: string;
  requestedByUserId?: string;
  runtime: ProductTruthWebControlRuntimeActive;
}): Promise<{
  requestedByUserId: string;
  createdAt: string;
  entries: {
    job: ProductTruthWalmartCollectionJob;
    plan: ReturnType<typeof verifiedProductTruthRunPlan>;
    planBytes: Buffer;
  }[];
}> {
  const rows = await prisma.productTruthControlCommand.findMany({
    where: {
      runId: { startsWith: `${input.batchId}-` },
      commandKind: { in: ["DOCTOR", "RUN_PLAN"] },
      ...(input.requestedByUserId
        ? { requestedByUserId: input.requestedByUserId }
        : {}),
      ...exactRuntimeCommandWhere(input.runtime),
    },
    include: { artifacts: true },
    orderBy: [{ requestedAt: "asc" }, { commandKind: "asc" }],
  });
  const doctors = rows.filter((row) => row.commandKind === "DOCTOR");
  const plans = rows.filter((row) => row.commandKind === "RUN_PLAN");
  if (
    doctors.length < 1
    || doctors.length !== plans.length
    || doctors.some((row) => row.status !== "SUCCEEDED")
    || plans.some((row) => row.status !== "SUCCEEDED")
  ) {
    fail(
      "ENRICHMENT_PLANS_NOT_READY",
      "every no-spend doctor and plan must succeed before a paid quote",
    );
  }
  const requestedBy = new Set(rows.map((row) => row.requestedByUserId));
  if (requestedBy.size !== 1) {
    fail("ENRICHMENT_SCOPE_MISMATCH", "batch ownership is ambiguous");
  }
  const planByRun = new Map(plans.map((row) => [row.runId, row]));
  const entries = doctors.map((doctor) => {
    const request = exactArtifact(doctor.artifacts, "REQUEST");
    const job = parseProductTruthWalmartCollectionJob(
      decodeCanonicalJson(request.content, "doctor request"),
    );
    const planRow = planByRun.get(job.runId);
    if (!planRow) {
      fail("ENRICHMENT_SCOPE_MISMATCH", "job has no exact successful plan");
    }
    const resultArtifact = exactArtifact(planRow.artifacts, "RESULT");
    const result = parseProductTruthWorkerResult(
      decodeCanonicalJson(resultArtifact.content, "run-plan result"),
    );
    const plan = verifiedProductTruthRunPlan(result);
    const planBytes = productTruthWorkerResultFile(result, "plan.json");
    if (
      planRow.runId !== job.runId
      || plan.runId !== job.runId
      || planBytes.toString("utf8")
        !== renderProductTruthOperationalJson(plan)
    ) {
      fail("ENRICHMENT_SCOPE_MISMATCH", "plan result differs from its job");
    }
    return { job, plan, planBytes };
  }).sort((left, right) => left.job.ordinal - right.job.ordinal);
  return {
    requestedByUserId: [...requestedBy][0]!,
    createdAt: plans
      .map((row) => row.updatedAt.toISOString())
      .sort()
      .at(-1)!,
    entries,
  };
}

export async function readProductTruthWalmartEnrichmentQuote(input: {
  batchId: string;
  requestedByUserId?: string;
  runtime: ProductTruthWebControlRuntimeActive;
}): Promise<ProductTruthWalmartEnrichmentQuote> {
  const collected = await collectionEntries(input);
  return buildProductTruthWalmartEnrichmentQuote({
    batchId: input.batchId,
    requestedByUserId: collected.requestedByUserId,
    createdAt: collected.createdAt,
    entries: collected.entries.map(({ job, plan }) => ({ job, plan })),
  });
}

function artifactReference(artifact: ProductTruthControlSealedArtifact) {
  return {
    role: artifact.role,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
  };
}

async function appendEvent(
  tx: Prisma.TransactionClient,
  input: {
    commandId: string;
    eventType:
      | "REQUESTED"
      | "ARTIFACTS_VALIDATED"
      | "AWAITING_OWNER"
      | "OWNER_VERIFIED"
      | "ADMITTED"
      | "CANCELLED_BEFORE_EXECUTION";
    source: "SERVER" | "OWNER_VERIFIER";
    occurredAt: string;
    payload: unknown;
  },
): Promise<void> {
  const previous = await tx.productTruthControlEvent.findFirst({
    where: { commandId: input.commandId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, eventHash: true },
  });
  const sequence = (previous?.sequence ?? 0) + 1;
  const payload = canonicalBytes(input.payload);
  const event = sealProductTruthControlEvent({
    eventId:
      `ptce-${input.commandId.slice(4)}-${sequence}-${sha256(payload).slice(0, 8)}`,
    commandId: input.commandId,
    sequence,
    eventType: input.eventType,
    source: input.source,
    occurredAt: input.occurredAt,
    payload,
    previousEventHash: previous?.eventHash ?? "0".repeat(64),
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

async function persistArtifact(
  tx: Prisma.TransactionClient,
  artifact: ProductTruthControlSealedArtifact,
): Promise<void> {
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
}

function approvalRequestFromRow(input: {
  command: {
    commandId: string;
    requestSha256: string;
    artifacts: readonly {
      role: string;
      content: Uint8Array;
      sha256: string;
      byteSize: number;
    }[];
  };
}): ProductTruthWalmartEnrichmentApprovalRequest {
  const quoteArtifact = exactArtifact(input.command.artifacts, "REQUEST");
  const envelopeArtifact = exactArtifact(
    input.command.artifacts,
    "OWNER_DISPOSITION",
  );
  const quote = parseProductTruthWalmartEnrichmentQuote(
    decodeCanonicalJson(quoteArtifact.content, "enrichment quote"),
  );
  const envelope = parseProductTruthControlEnvelopeBytes(
    envelopeArtifact.content,
  );
  const commandSha256 = productTruthControlRequestSha256(envelope);
  if (
    commandSha256 !== input.command.requestSha256
    || envelope.commandId !== input.command.commandId
    || !envelope.artifacts.some((reference) =>
      reference.role === "REQUEST"
      && reference.sha256 === quoteArtifact.sha256
      && reference.byteSize === quoteArtifact.byteSize)
  ) {
    fail(
      "ENRICHMENT_AUTHORITY_REQUEST_INVALID",
      "stored owner request differs from its immutable command",
    );
  }
  return {
    command_id: input.command.commandId,
    command_sha256: commandSha256,
    quote,
    quote_sha256: productTruthWalmartEnrichmentQuoteSha256(quote),
    envelope,
    owner_agent_url: PRODUCT_TRUTH_WALMART_OWNER_APPROVAL_AGENT_URL,
  };
}

export async function prepareProductTruthWalmartEnrichmentApproval(input: {
  batchId: string;
  requestedByUserId: string;
  expectedQuoteSha256: string;
  runtime: ProductTruthWebControlRuntimeActive;
  now?: Date;
}): Promise<ProductTruthWalmartEnrichmentApprovalRequest> {
  if (
    !input.runtime.claims.meteredExecutionAdmission
    || !input.runtime.ownerTrustedKey
  ) {
    fail(
      "ENRICHMENT_METERED_STAGE_OFF",
      "owner-gated metered execution is not activated",
    );
  }
  const now = input.now ?? new Date();
  const collected = await collectionEntries({
    batchId: input.batchId,
    requestedByUserId: input.requestedByUserId,
    runtime: input.runtime,
  });
  const quote = buildProductTruthWalmartEnrichmentQuote({
    batchId: input.batchId,
    requestedByUserId: collected.requestedByUserId,
    createdAt: collected.createdAt,
    entries: collected.entries.map(({ job, plan }) => ({ job, plan })),
  });
  const quoteSha256 = productTruthWalmartEnrichmentQuoteSha256(quote);
  if (quoteSha256 !== input.expectedQuoteSha256) {
    fail("ENRICHMENT_QUOTE_CHANGED", "displayed quote is no longer current");
  }
  const reusable = await prisma.productTruthControlCommand.findFirst({
    where: {
      commandKind: "EXECUTE",
      runId: input.batchId,
      requestedByUserId: input.requestedByUserId,
      status: { in: ["AWAITING_OWNER", "ADMITTED", "CLAIMED", "RUNNING"] },
      ...exactRuntimeCommandWhere(input.runtime),
    },
    include: { artifacts: true },
    orderBy: { requestedAt: "desc" },
  });
  if (reusable) {
    const request = approvalRequestFromRow({ command: reusable });
    if (
      Date.parse(request.envelope.authority.expiresAt ?? "") > now.getTime()
    ) {
      return request;
    }
  }

  const issuedAt = now.toISOString();
  const expiresAt = new Date(Math.min(
    now.getTime() + OWNER_AUTHORITY_MS,
    Date.parse(quote.expiresAt),
  )).toISOString();
  if (Date.parse(expiresAt) <= now.getTime()) {
    fail("ENRICHMENT_QUOTE_EXPIRED", "the exact plans have expired");
  }
  const nonce = `ptn-${randomBytes(24).toString("hex")}`;
  const seed = sha256(canonicalBytes({
    quoteSha256,
    nonce,
    engine: input.runtime.engine,
    target: input.runtime.target,
  }));
  const commandId = `ptc-${seed.slice(0, 32)}`;
  const quoteArtifact = sealProductTruthControlArtifact({
    artifactId: `pta-${seed.slice(0, 32)}-quote`,
    commandId,
    role: "REQUEST",
    mediaType: "application/json",
    content: Buffer.from(renderProductTruthWalmartEnrichmentQuote(quote), "utf8"),
    createdAt: issuedAt,
    createdByPrincipal: input.requestedByUserId,
  });
  const planArtifacts = collected.entries.map(({ planBytes }, index) =>
    sealProductTruthControlArtifact({
      artifactId: `pta-${seed.slice(0, 32)}-plan-${index + 1}`,
      commandId,
      role: "RUN_PLAN",
      mediaType: "application/json",
      content: planBytes,
      createdAt: issuedAt,
      createdByPrincipal: input.requestedByUserId,
    }));
  const references = [quoteArtifact, ...planArtifacts]
    .map(artifactReference)
    .sort((left, right) =>
      `${left.role}:${left.sha256}`.localeCompare(
        `${right.role}:${right.sha256}`,
        "en-US",
      ));
  const envelope = JSON.parse(canonicalProductTruthControlEnvelope({
    schemaVersion: PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
    commandId,
    commandKind: "EXECUTE",
    gateClass: "METERED_EXECUTE",
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
    artifacts: references,
    authority: {
      ownerKeyId: input.runtime.ownerTrustedKey.keyId,
      issuedAt,
      expiresAt,
      nonce,
    },
    claims: {
      noImplicitScope: true,
      noMarketplaceMutation: true,
      ambiguousNeverReplay: true,
      bjsForbidden: true,
      clubsRequireSeparateGate: true,
    },
  })) as ProductTruthControlEnvelope;
  const envelopeBytes = Buffer.from(
    canonicalProductTruthControlEnvelope(envelope),
    "utf8",
  );
  const envelopeArtifact = sealProductTruthControlArtifact({
    artifactId: `pta-${seed.slice(0, 32)}-owner-request`,
    commandId,
    role: "OWNER_DISPOSITION",
    mediaType: "application/json",
    content: envelopeBytes,
    createdAt: issuedAt,
    createdByPrincipal: input.requestedByUserId,
  });
  const requestSha256 = productTruthControlRequestSha256(envelope);
  await prisma.$transaction(async (tx) => {
    await tx.productTruthControlCommand.create({
      data: {
        commandId,
        schemaVersion: PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
        commandKind: "EXECUTE",
        gateClass: "METERED_EXECUTE",
        status: "DRAFT",
        idempotencyKey: `product-truth-enrichment:${seed}`,
        requestSha256,
        requestedByUserId: input.requestedByUserId,
        requestedAt: now,
        engineReleaseId: input.runtime.engine.releaseId,
        engineCommitSha: input.runtime.engine.commitSha,
        engineTreeSha: input.runtime.engine.treeSha,
        executableTreeSha256:
          input.runtime.engine.executableTreeSha256,
        environment: input.runtime.target.environment,
        databaseTargetFingerprint:
          input.runtime.target.databaseTargetFingerprint,
        manifestSha256: input.runtime.target.manifestSha256,
        runId: input.batchId,
        approvalId: quote.quoteId,
        requestArtifactId: quoteArtifact.artifactId,
        planArtifactId: planArtifacts[0]!.artifactId,
        maxAttempts: 1,
      },
    });
    for (const artifact of [
      quoteArtifact,
      ...planArtifacts,
      envelopeArtifact,
    ]) {
      await persistArtifact(tx, artifact);
    }
    await appendEvent(tx, {
      commandId,
      eventType: "REQUESTED",
      source: "SERVER",
      occurredAt: issuedAt,
      payload: {
        quoteSha256,
        maximumProviderUnits: quote.totals.maximumProviderUnits,
        marketplaceMutations: 0,
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
      occurredAt: issuedAt,
      payload: {
        artifactCount: references.length,
        quoteSha256,
      },
    });
    await tx.productTruthControlCommand.update({
      where: { commandId },
      data: { status: "AWAITING_OWNER" },
    });
    await appendEvent(tx, {
      commandId,
      eventType: "AWAITING_OWNER",
      source: "SERVER",
      occurredAt: issuedAt,
      payload: {
        ownerKeyId: input.runtime.ownerTrustedKey!.keyId,
        expiresAt,
      },
    });
  });
  return {
    command_id: commandId,
    command_sha256: requestSha256,
    quote,
    quote_sha256: quoteSha256,
    envelope,
    owner_agent_url: PRODUCT_TRUTH_WALMART_OWNER_APPROVAL_AGENT_URL,
  };
}

export async function authorizeProductTruthWalmartEnrichment(input: {
  commandId: string;
  requestedByUserId: string;
  signatureBase64: string;
  runtime: ProductTruthWebControlRuntimeActive;
  now?: Date;
}): Promise<{ status: "ADMITTED"; command_id: string }> {
  if (
    !input.runtime.claims.meteredExecutionAdmission
    || !input.runtime.ownerTrustedKey
  ) {
    fail("ENRICHMENT_METERED_STAGE_OFF", "metered execution is not active");
  }
  const now = input.now ?? new Date();
  const command = await prisma.productTruthControlCommand.findFirst({
    where: {
      commandId: input.commandId,
      requestedByUserId: input.requestedByUserId,
      commandKind: "EXECUTE",
      gateClass: "METERED_EXECUTE",
      ...exactRuntimeCommandWhere(input.runtime),
    },
    include: { artifacts: true },
  });
  if (!command || command.status !== "AWAITING_OWNER") {
    fail(
      "ENRICHMENT_OWNER_REQUEST_NOT_CURRENT",
      "owner request is missing or no longer awaiting approval",
    );
  }
  const request = approvalRequestFromRow({ command });
  const verified = verifyProductTruthControlAuthority({
    envelope: request.envelope,
    signatureBase64: input.signatureBase64,
    trustedKey: input.runtime.ownerTrustedKey,
    now,
  });
  if (verified.commandSha256 !== command.requestSha256) {
    fail(
      "ENRICHMENT_OWNER_SIGNATURE_MISMATCH",
      "signature belongs to another command",
    );
  }
  const authorization = {
    schemaVersion: AUTHORIZATION_ARTIFACT_VERSION,
    commandId: command.commandId,
    commandSha256: verified.commandSha256,
    quoteSha256: request.quote_sha256,
    ownerKeyId: input.runtime.ownerTrustedKey.keyId,
    ownerPublicKeySpkiSha256:
      input.runtime.ownerTrustedKey.publicKeySpkiSha256,
    signatureBase64: input.signatureBase64,
    signatureSha256: verified.signatureSha256,
    authorizedAt: now.toISOString(),
  };
  const artifact = sealProductTruthControlArtifact({
    artifactId:
      `pta-${command.commandId.slice(4)}-owner-${verified.signatureSha256.slice(0, 8)}`,
    commandId: command.commandId,
    role: "OWNER_APPROVAL",
    mediaType: "application/json",
    content: canonicalBytes(authorization),
    createdAt: now.toISOString(),
    createdByPrincipal: input.runtime.ownerTrustedKey.keyId,
  });
  await prisma.$transaction(async (tx) => {
    await persistArtifact(tx, artifact);
    await appendEvent(tx, {
      commandId: command.commandId,
      eventType: "OWNER_VERIFIED",
      source: "OWNER_VERIFIER",
      occurredAt: now.toISOString(),
      payload: {
        ownerKeyId: input.runtime.ownerTrustedKey!.keyId,
        signatureSha256: verified.signatureSha256,
        commandSha256: verified.commandSha256,
      },
    });
    await tx.productTruthControlCommand.update({
      where: { commandId: command.commandId },
      data: {
        status: "ADMITTED",
        approvalArtifactId: artifact.artifactId,
        ownerKeyId: request.envelope.authority.ownerKeyId,
        ownerNonce: request.envelope.authority.nonce,
        ownerSignatureSha256: verified.signatureSha256,
        ownerAuthorizedAt: now,
        ownerAuthorizationExpiresAt: new Date(
          request.envelope.authority.expiresAt!,
        ),
      },
    });
    await appendEvent(tx, {
      commandId: command.commandId,
      eventType: "ADMITTED",
      source: "OWNER_VERIFIER",
      occurredAt: now.toISOString(),
      payload: {
        gateClass: "METERED_EXECUTE",
        maximumProviderUnits:
          request.quote.totals.maximumProviderUnits,
        marketplaceMutations: 0,
      },
    });
  });
  return { status: "ADMITTED", command_id: command.commandId };
}

export async function declineProductTruthWalmartEnrichment(input: {
  batchId: string;
  requestedByUserId: string;
  runtime: ProductTruthWebControlRuntimeActive;
  now?: Date;
}): Promise<{ status: "CANCELLED"; command_id: string }> {
  const now = input.now ?? new Date();
  const command = await prisma.productTruthControlCommand.findFirst({
    where: {
      runId: input.batchId,
      requestedByUserId: input.requestedByUserId,
      commandKind: "EXECUTE",
      status: "AWAITING_OWNER",
      ...exactRuntimeCommandWhere(input.runtime),
    },
    orderBy: { requestedAt: "desc" },
  });
  if (!command) {
    fail(
      "ENRICHMENT_OWNER_REQUEST_NOT_CURRENT",
      "there is no pending owner request to decline",
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.productTruthControlCommand.update({
      where: { commandId: command.commandId },
      data: { status: "CANCELLED", outcome: "DECLINED_BEFORE_SPEND" },
    });
    await appendEvent(tx, {
      commandId: command.commandId,
      eventType: "CANCELLED_BEFORE_EXECUTION",
      source: "SERVER",
      occurredAt: now.toISOString(),
      payload: {
        providerCalls: 0,
        marketplaceMutations: 0,
        reason: "OWNER_DECLINED_QUOTE",
      },
    });
  });
  return { status: "CANCELLED", command_id: command.commandId };
}

export async function readProductTruthWalmartEnrichmentCommand(input: {
  batchId: string;
  requestedByUserId?: string;
  runtime: ProductTruthWebControlRuntimeActive;
}) {
  return prisma.productTruthControlCommand.findFirst({
    where: {
      runId: input.batchId,
      commandKind: "EXECUTE",
      ...(input.requestedByUserId
        ? { requestedByUserId: input.requestedByUserId }
        : {}),
      ...exactRuntimeCommandWhere(input.runtime),
    },
    orderBy: { requestedAt: "desc" },
    select: {
      commandId: true,
      status: true,
      outcome: true,
      errorCode: true,
      ownerAuthorizedAt: true,
      ownerAuthorizationExpiresAt: true,
      workerLeaseExpiresAt: true,
      attempts: true,
      executionStartedAt: true,
      updatedAt: true,
    },
  });
}
