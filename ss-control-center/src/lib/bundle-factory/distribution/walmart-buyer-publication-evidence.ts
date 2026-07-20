/**
 * Immutable buyer-facing publication evidence for Walmart.
 *
 * Feed ingestion and seller-side catalog state are necessary but insufficient:
 * LIVE requires an exact Walmart PDP observation that is both published and
 * buyable, bound to the same SKU, itemId, and durable submission attempt.
 */

import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "@/lib/prisma";
import { hashWalmartNewSkuEvidenceArtifact } from
  "../walmart-new-sku-evidence-sealer";
import {
  assertWalmartCertifiedSubmissionAttemptBinding,
  canonicalWalmartPayloadJson,
  type WalmartCertifiedSubmissionAttemptBinding,
} from "./walmart-publish-lifecycle";

export const WALMART_BUYER_EVIDENCE_VERSION =
  "walmart-buyer-publication-evidence/v1" as const;
export const WALMART_BUYER_RAW_EVIDENCE_VERSION =
  "walmart-buyer-raw-evidence/v1" as const;
export const WALMART_BUYER_EVIDENCE_ENGINE_BINDING_VERSION =
  "walmart-buyer-evidence-engine-binding/v1" as const;
export const WALMART_BUYER_EVIDENCE_MAX_AGE_MS = 30 * 60_000;
const WALMART_BUYER_EVIDENCE_SHA256_PLACEHOLDER =
  "TODO_LOWERCASE_SHA256_OF_LOCAL_ARTIFACT_BYTES" as const;

export type WalmartBuyerEvidenceSourceKind =
  | "WALMART_BUYER_PDP"
  | "SEALED_BUYER_SNAPSHOT"
  | "MANUAL_BROWSER_VERIFICATION";

export interface WalmartBuyerPublicationEvidenceInput {
  engineBinding?: WalmartBuyerEvidenceEngineBinding;
  channelSkuId: string;
  submissionAttemptId: string;
  sku: string;
  walmartItemId: string;
  sourceUrl: string;
  sourceKind: WalmartBuyerEvidenceSourceKind;
  capturedAt: Date | string;
  exactSkuMatch: boolean;
  exactItemIdMatch: boolean;
  published: boolean;
  buyable: boolean;
  rawEvidence: unknown;
}

export interface WalmartBuyerEvidenceEngineBinding {
  schema_version: typeof WALMART_BUYER_EVIDENCE_ENGINE_BINDING_VERSION;
  binding_sha256: string;
  channel: "WALMART";
  certification_sha256: string;
  verify_receipt_sha256: string;
  channel_sku_id: string;
  submission_attempt_id: string;
  sku: string;
  walmart_item_id: string;
  source_url: string;
  source_kind: "MANUAL_BROWSER_VERIFICATION";
}

export interface WalmartBuyerEvidenceCertificationBinding {
  certification_sha256: string;
  channel_sku_id: string;
  sku: string;
  payload_sha256: string;
  seller_account_fingerprint_sha256: string;
}

export interface WalmartBuyerEvidenceVerifyReceiptBinding {
  receipt_sha256: string;
  certification_sha256: string;
  channel_sku_id: string;
  sku: string;
  payload_sha256: string;
  submission_attempt_binding: {
    attempt_id: string;
    channel_sku_id: string;
    certification_sha256: string;
    payload_sha256: string;
    seller_account_fingerprint_sha256: string;
    idempotency_key: string;
  } | null;
  buyer_evidence_status: {
    channel_sku_id: string;
    attempt_id: string | null;
    walmart_item_id: string | null;
    buyer_verified: boolean;
  };
  poll_result: null | {
    channel_sku_id: string;
    submission_attempt_id: string;
    walmart_item_id?: string | null;
  };
}

export function assertCurrentWalmartBuyerEvidenceTarget(input: {
  evidence: Pick<
    WalmartBuyerPublicationEvidenceInput,
    "channelSkuId" | "submissionAttemptId" | "sku" | "walmartItemId"
  >;
  channelSku: {
    id: string;
    sku: string;
    walmartItemId: string | null;
  };
  latestSubmissionAttemptId: string | null;
}): void {
  if (
    input.evidence.channelSkuId !== input.channelSku.id ||
    input.evidence.sku !== input.channelSku.sku
  ) {
    throw new Error("Buyer evidence targets another certified SKU");
  }
  if (
    !input.latestSubmissionAttemptId ||
    input.evidence.submissionAttemptId !== input.latestSubmissionAttemptId
  ) {
    throw new Error(
      "Buyer evidence does not target the latest certified submission attempt",
    );
  }
  if (
    input.channelSku.walmartItemId &&
    input.evidence.walmartItemId !== input.channelSku.walmartItemId
  ) {
    throw new Error("Buyer evidence item ID differs from the current ChannelSKU");
  }
}

export interface ValidatedWalmartBuyerPublicationEvidence {
  channelSkuId: string;
  submissionAttemptId: string;
  sku: string;
  walmartItemId: string;
  sourceUrl: string;
  sourceKind: WalmartBuyerEvidenceSourceKind;
  capturedAt: Date;
  exactSkuMatch: true;
  exactItemIdMatch: true;
  published: true;
  buyable: true;
  rawEvidenceJson: string;
  evidenceHash: string;
}

export type WalmartBuyerRawEvidenceArtifactKind =
  | "PDP_DOCUMENT"
  | "SEALED_SNAPSHOT"
  | "BROWSER_SCREENSHOT";

/** Minimum independently sealed observation carried inside rawEvidence.
 * Additional capture fields are allowed, but these fields are mandatory so a
 * caller cannot promote an empty object by merely setting four booleans. */
export interface WalmartBuyerRawEvidenceContract {
  schema_version: typeof WALMART_BUYER_RAW_EVIDENCE_VERSION;
  source_kind: WalmartBuyerEvidenceSourceKind;
  binding: {
    sku: string;
    walmart_item_id: string;
    source_url: string;
    captured_at: string;
  };
  artifact: {
    kind: WalmartBuyerRawEvidenceArtifactKind;
    sha256: string;
    ref: string;
  };
  observation: {
    page_rendered: true;
    availability: "IN_STOCK" | "LIMITED_STOCK" | "AVAILABLE";
    add_to_cart_enabled: true;
    http_status?: 200;
  };
  /** Required only for MANUAL_BROWSER_VERIFICATION. */
  observer?: string;
}

export function walmartBuyerEvidenceNotBefore(
  attemptNotBefore: Date,
  now = new Date(),
): Date {
  const freshnessBoundary = new Date(
    now.getTime() - WALMART_BUYER_EVIDENCE_MAX_AGE_MS,
  );
  return attemptNotBefore > freshnessBoundary ? attemptNotBefore : freshnessBoundary;
}

function normalizedNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function exactWalmartItemIdFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "walmart.com" && !url.hostname.endsWith(".walmart.com")) {
    return null;
  }
  return url.pathname.match(/\/ip\/(?:[^/]+\/)?(\d+)(?:\/)?$/i)?.[1] ?? null;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} must contain only the engine-generated fields`);
  }
}

function exactString(
  value: unknown,
  expected: string,
  label: string,
): string {
  if (typeof value !== "string" || value !== expected) {
    throw new Error(`${label} does not match the buyer evidence binding`);
  }
  return value;
}

const EXPECTED_ARTIFACT_KIND: Record<
  WalmartBuyerEvidenceSourceKind,
  WalmartBuyerRawEvidenceArtifactKind
> = {
  WALMART_BUYER_PDP: "PDP_DOCUMENT",
  SEALED_BUYER_SNAPSHOT: "SEALED_SNAPSHOT",
  MANUAL_BROWSER_VERIFICATION: "BROWSER_SCREENSHOT",
};

const BUYABLE_AVAILABILITY = new Set(["IN_STOCK", "LIMITED_STOCK", "AVAILABLE"]);

function buyerEvidenceEngineBindingSha256(
  binding: Omit<WalmartBuyerEvidenceEngineBinding, "binding_sha256">,
): string {
  return createHash("sha256")
    .update(canonicalWalmartPayloadJson(binding))
    .digest("hex");
}

/**
 * Operator worksheet only. Unknown observations stay explicitly negative or
 * TODO until an operator has captured and inspected the exact buyer PDP.
 * Passing this object to recordWalmartBuyerPublicationEvidence must fail until
 * every placeholder has been replaced with observed evidence.
 */
export function buildPendingWalmartBuyerPublicationEvidenceTemplate(input: {
  certificationSha256: string;
  verifyReceiptSha256: string;
  channelSkuId: string;
  submissionAttemptId: string;
  sku: string;
  walmartItemId: string;
}) {
  const channelSkuId = normalizedNonEmpty(input.channelSkuId, "channelSkuId");
  const submissionAttemptId = normalizedNonEmpty(
    input.submissionAttemptId,
    "submissionAttemptId",
  );
  const sku = normalizedNonEmpty(input.sku, "sku");
  const walmartItemId = normalizedNonEmpty(input.walmartItemId, "walmartItemId");
  const certificationSha256 = normalizedNonEmpty(
    input.certificationSha256,
    "certificationSha256",
  );
  if (!/^[a-f0-9]{64}$/.test(certificationSha256)) {
    throw new Error("certificationSha256 must be lowercase SHA-256 hex");
  }
  const verifyReceiptSha256 = normalizedNonEmpty(
    input.verifyReceiptSha256,
    "verifyReceiptSha256",
  );
  if (!/^[a-f0-9]{64}$/.test(verifyReceiptSha256)) {
    throw new Error("verifyReceiptSha256 must be lowercase SHA-256 hex");
  }
  if (!/^\d+$/.test(walmartItemId)) {
    throw new Error("walmartItemId must be the exact numeric buyer item ID");
  }
  const sourceUrl = `https://www.walmart.com/ip/${walmartItemId}`;
  const engineBindingBody = {
    schema_version: WALMART_BUYER_EVIDENCE_ENGINE_BINDING_VERSION,
    channel: "WALMART" as const,
    certification_sha256: certificationSha256,
    verify_receipt_sha256: verifyReceiptSha256,
    channel_sku_id: channelSkuId,
    submission_attempt_id: submissionAttemptId,
    sku,
    walmart_item_id: walmartItemId,
    source_url: sourceUrl,
    source_kind: "MANUAL_BROWSER_VERIFICATION" as const,
  };

  return {
    engineBinding: {
      ...engineBindingBody,
      binding_sha256: buyerEvidenceEngineBindingSha256(engineBindingBody),
    },
    channelSkuId,
    submissionAttemptId,
    sku,
    walmartItemId,
    sourceUrl,
    sourceKind: "MANUAL_BROWSER_VERIFICATION" as const,
    capturedAt: null,
    exactSkuMatch: false,
    exactItemIdMatch: false,
    published: false,
    buyable: false,
    rawEvidence: {
      schema_version: WALMART_BUYER_RAW_EVIDENCE_VERSION,
      source_kind: "MANUAL_BROWSER_VERIFICATION" as const,
      binding: {
        sku,
        walmart_item_id: walmartItemId,
        source_url: sourceUrl,
        captured_at: null,
      },
      artifact: {
        kind: "BROWSER_SCREENSHOT" as const,
        sha256: WALMART_BUYER_EVIDENCE_SHA256_PLACEHOLDER,
        ref: "TODO_NORMALIZED_ABSOLUTE_LOCAL_ARTIFACT_PATH",
      },
      observation: {
        page_rendered: false,
        availability: "TODO_OBSERVED_AVAILABILITY",
        add_to_cart_enabled: false,
      },
      observer: "TODO_OBSERVER",
    },
  };
}

/**
 * Suppress a worksheet in the same invocation that just recorded evidence.
 * A later non-LIVE invocation may emit a new receipt-bound worksheet so stale
 * or otherwise nonqualifying evidence has a fail-closed refresh path.
 */
export function shouldCreatePendingWalmartBuyerEvidenceTemplate(input: {
  buyerVerified: boolean;
  buyerEvidenceRecorded: boolean;
  submissionAttemptId: string | null;
  walmartItemId: string | null;
}): boolean {
  return Boolean(
    !input.buyerVerified &&
      !input.buyerEvidenceRecorded &&
      input.submissionAttemptId &&
      input.walmartItemId,
  );
}

/**
 * Validate the exact operator worksheet emitted for one certification. This is
 * deliberately stricter than the general evidence-recording API: the operator
 * may fill TODO/null observation fields, but may not add fields or change any
 * deterministic certification/attempt/SKU/item/source binding.
 */
function inspectWalmartBuyerEvidenceTemplateBinding(input: {
  draft: unknown;
  certification: WalmartBuyerEvidenceCertificationBinding;
  verifyReceipt: WalmartBuyerEvidenceVerifyReceiptBinding;
  artifactSha256State: "PLACEHOLDER" | "SEALED";
}): {
  draft: Record<string, unknown>;
  artifactPath: string;
} {
  const draft = objectValue(input.draft, "buyer evidence template");
  assertExactObjectKeys(draft, [
    "engineBinding",
    "channelSkuId",
    "submissionAttemptId",
    "sku",
    "walmartItemId",
    "sourceUrl",
    "sourceKind",
    "capturedAt",
    "exactSkuMatch",
    "exactItemIdMatch",
    "published",
    "buyable",
    "rawEvidence",
  ], "buyer evidence template");

  const certificationSha256 = normalizedNonEmpty(
    input.certification.certification_sha256,
    "certification.certification_sha256",
  );
  if (!/^[a-f0-9]{64}$/.test(certificationSha256)) {
    throw new Error("certification.certification_sha256 is invalid");
  }
  const certificationChannelSkuId = normalizedNonEmpty(
    input.certification.channel_sku_id,
    "certification.channel_sku_id",
  );
  const certificationSku = normalizedNonEmpty(
    input.certification.sku,
    "certification.sku",
  );
  const certificationPayloadSha256 = normalizedNonEmpty(
    input.certification.payload_sha256,
    "certification.payload_sha256",
  );
  const certificationSellerFingerprint = normalizedNonEmpty(
    input.certification.seller_account_fingerprint_sha256,
    "certification.seller_account_fingerprint_sha256",
  );
  if (
    !/^[a-f0-9]{64}$/.test(certificationPayloadSha256) ||
    !/^[a-f0-9]{64}$/.test(certificationSellerFingerprint)
  ) {
    throw new Error("certification attempt binding hashes are invalid");
  }

  const engineBinding = objectValue(
    draft.engineBinding,
    "buyer evidence engineBinding",
  );
  assertExactObjectKeys(engineBinding, [
    "schema_version",
    "binding_sha256",
    "channel",
    "certification_sha256",
    "verify_receipt_sha256",
    "channel_sku_id",
    "submission_attempt_id",
    "sku",
    "walmart_item_id",
    "source_url",
    "source_kind",
  ], "buyer evidence engineBinding");
  exactString(
    engineBinding.schema_version,
    WALMART_BUYER_EVIDENCE_ENGINE_BINDING_VERSION,
    "engineBinding.schema_version",
  );
  const verifyReceiptSha256 = normalizedNonEmpty(
    input.verifyReceipt.receipt_sha256,
    "verifyReceipt.receipt_sha256",
  );
  if (!/^[a-f0-9]{64}$/.test(verifyReceiptSha256)) {
    throw new Error("verifyReceipt.receipt_sha256 is invalid");
  }
  exactString(
    input.verifyReceipt.certification_sha256,
    certificationSha256,
    "verifyReceipt.certification_sha256",
  );
  exactString(
    input.verifyReceipt.channel_sku_id,
    certificationChannelSkuId,
    "verifyReceipt.channel_sku_id",
  );
  exactString(
    input.verifyReceipt.sku,
    certificationSku,
    "verifyReceipt.sku",
  );
  exactString(
    input.verifyReceipt.payload_sha256,
    certificationPayloadSha256,
    "verifyReceipt.payload_sha256",
  );
  const receiptAttempt = objectValue(
    input.verifyReceipt.submission_attempt_binding,
    "verifyReceipt.submission_attempt_binding",
  );
  assertExactObjectKeys(receiptAttempt, [
    "attempt_id",
    "channel_sku_id",
    "certification_sha256",
    "payload_sha256",
    "seller_account_fingerprint_sha256",
    "idempotency_key",
  ], "verifyReceipt.submission_attempt_binding");
  exactString(
    receiptAttempt.channel_sku_id,
    certificationChannelSkuId,
    "verifyReceipt.submission_attempt_binding.channel_sku_id",
  );
  exactString(
    receiptAttempt.certification_sha256,
    certificationSha256,
    "verifyReceipt.submission_attempt_binding.certification_sha256",
  );
  exactString(
    receiptAttempt.payload_sha256,
    certificationPayloadSha256,
    "verifyReceipt.submission_attempt_binding.payload_sha256",
  );
  exactString(
    receiptAttempt.seller_account_fingerprint_sha256,
    certificationSellerFingerprint,
    "verifyReceipt.submission_attempt_binding.seller_account_fingerprint_sha256",
  );
  const expectedIdempotencyKey = `walmart:v1:${createHash("sha256")
    .update(`${certificationChannelSkuId}\n${certificationPayloadSha256}`)
    .digest("hex")}`;
  exactString(
    receiptAttempt.idempotency_key,
    expectedIdempotencyKey,
    "verifyReceipt.submission_attempt_binding.idempotency_key",
  );
  if (input.verifyReceipt.buyer_evidence_status.buyer_verified !== false) {
    throw new Error("verifyReceipt already contains verified buyer evidence");
  }
  exactString(
    engineBinding.verify_receipt_sha256,
    verifyReceiptSha256,
    "engineBinding.verify_receipt_sha256",
  );
  exactString(engineBinding.channel, "WALMART", "engineBinding.channel");
  exactString(
    engineBinding.certification_sha256,
    certificationSha256,
    "engineBinding.certification_sha256",
  );
  exactString(
    engineBinding.channel_sku_id,
    certificationChannelSkuId,
    "engineBinding.channel_sku_id",
  );
  exactString(engineBinding.sku, certificationSku, "engineBinding.sku");

  const channelSkuId = exactString(
    draft.channelSkuId,
    certificationChannelSkuId,
    "channelSkuId",
  );
  const sku = exactString(draft.sku, certificationSku, "sku");
  const submissionAttemptId = normalizedNonEmpty(
    typeof draft.submissionAttemptId === "string" ? draft.submissionAttemptId : "",
    "submissionAttemptId",
  );
  exactString(
    receiptAttempt.attempt_id,
    submissionAttemptId,
    "verifyReceipt.submission_attempt_binding.attempt_id",
  );
  exactString(
    input.verifyReceipt.buyer_evidence_status.channel_sku_id,
    certificationChannelSkuId,
    "verifyReceipt.buyer_evidence_status.channel_sku_id",
  );
  exactString(
    input.verifyReceipt.buyer_evidence_status.attempt_id,
    submissionAttemptId,
    "verifyReceipt.buyer_evidence_status.attempt_id",
  );
  exactString(
    engineBinding.submission_attempt_id,
    submissionAttemptId,
    "engineBinding.submission_attempt_id",
  );
  const walmartItemId = normalizedNonEmpty(
    typeof draft.walmartItemId === "string" ? draft.walmartItemId : "",
    "walmartItemId",
  );
  if (!/^\d+$/.test(walmartItemId)) {
    throw new Error("walmartItemId must be the exact numeric buyer item ID");
  }
  const pollItemId = input.verifyReceipt.poll_result?.walmart_item_id ?? null;
  if (input.verifyReceipt.poll_result) {
    exactString(
      input.verifyReceipt.poll_result.channel_sku_id,
      certificationChannelSkuId,
      "verifyReceipt.poll_result.channel_sku_id",
    );
    exactString(
      input.verifyReceipt.poll_result.submission_attempt_id,
      submissionAttemptId,
      "verifyReceipt.poll_result.submission_attempt_id",
    );
  }
  const statusItemId = input.verifyReceipt.buyer_evidence_status.walmart_item_id;
  if (pollItemId && statusItemId && pollItemId !== statusItemId) {
    throw new Error("verifyReceipt contains conflicting Walmart item IDs");
  }
  const receiptItemId = pollItemId ?? statusItemId;
  exactString(
    receiptItemId,
    walmartItemId,
    "verifyReceipt.walmart_item_id",
  );
  exactString(
    engineBinding.walmart_item_id,
    walmartItemId,
    "engineBinding.walmart_item_id",
  );
  const sourceUrl = normalizedNonEmpty(
    typeof draft.sourceUrl === "string" ? draft.sourceUrl : "",
    "sourceUrl",
  );
  if (exactWalmartItemIdFromUrl(sourceUrl) !== walmartItemId) {
    throw new Error("sourceUrl does not resolve the exact Walmart item ID");
  }
  exactString(engineBinding.source_url, sourceUrl, "engineBinding.source_url");
  exactString(
    draft.sourceKind,
    "MANUAL_BROWSER_VERIFICATION",
    "sourceKind",
  );
  exactString(
    engineBinding.source_kind,
    "MANUAL_BROWSER_VERIFICATION",
    "engineBinding.source_kind",
  );

  const { binding_sha256: declaredBindingSha256, ...unsignedBinding } =
    engineBinding as unknown as WalmartBuyerEvidenceEngineBinding;
  if (
    typeof declaredBindingSha256 !== "string" ||
    declaredBindingSha256 !== buyerEvidenceEngineBindingSha256(unsignedBinding)
  ) {
    throw new Error("engineBinding.binding_sha256 does not match its exact fields");
  }

  const rawEvidence = objectValue(draft.rawEvidence, "rawEvidence");
  assertExactObjectKeys(rawEvidence, [
    "schema_version",
    "source_kind",
    "binding",
    "artifact",
    "observation",
    "observer",
  ], "rawEvidence");
  exactString(
    rawEvidence.schema_version,
    WALMART_BUYER_RAW_EVIDENCE_VERSION,
    "rawEvidence.schema_version",
  );
  exactString(
    rawEvidence.source_kind,
    "MANUAL_BROWSER_VERIFICATION",
    "rawEvidence.source_kind",
  );
  const rawBinding = objectValue(rawEvidence.binding, "rawEvidence.binding");
  assertExactObjectKeys(rawBinding, [
    "sku",
    "walmart_item_id",
    "source_url",
    "captured_at",
  ], "rawEvidence.binding");
  exactString(rawBinding.sku, sku, "rawEvidence.binding.sku");
  exactString(
    rawBinding.walmart_item_id,
    walmartItemId,
    "rawEvidence.binding.walmart_item_id",
  );
  exactString(
    rawBinding.source_url,
    sourceUrl,
    "rawEvidence.binding.source_url",
  );
  if (
    typeof draft.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(draft.capturedAt)) ||
    new Date(draft.capturedAt).toISOString() !== draft.capturedAt
  ) {
    throw new Error("capturedAt must be an exact canonical ISO UTC timestamp");
  }
  exactString(
    rawBinding.captured_at,
    draft.capturedAt,
    "rawEvidence.binding.captured_at",
  );

  const artifact = objectValue(rawEvidence.artifact, "rawEvidence.artifact");
  assertExactObjectKeys(
    artifact,
    ["kind", "sha256", "ref"],
    "rawEvidence.artifact",
  );
  exactString(
    artifact.kind,
    "BROWSER_SCREENSHOT",
    "rawEvidence.artifact.kind",
  );
  if (input.artifactSha256State === "PLACEHOLDER") {
    exactString(
      artifact.sha256,
      WALMART_BUYER_EVIDENCE_SHA256_PLACEHOLDER,
      "rawEvidence.artifact.sha256",
    );
  } else if (
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  ) {
    throw new Error("rawEvidence.artifact.sha256 must be lowercase SHA-256 hex");
  }
  if (
    typeof artifact.ref !== "string" ||
    artifact.ref.includes("\0") ||
    !isAbsolute(artifact.ref) ||
    resolve(artifact.ref) !== artifact.ref
  ) {
    throw new Error(
      "rawEvidence.artifact.ref must be a normalized absolute local path",
    );
  }

  const observation = objectValue(
    rawEvidence.observation,
    "rawEvidence.observation",
  );
  assertExactObjectKeys(observation, [
    "page_rendered",
    "availability",
    "add_to_cart_enabled",
  ], "rawEvidence.observation");
  if (
    typeof rawEvidence.observer !== "string" ||
    !rawEvidence.observer.trim() ||
    /^(?:TODO|TBD)(?:_|$)/i.test(rawEvidence.observer)
  ) {
    throw new Error("rawEvidence.observer must be the real reviewing operator");
  }

  const expectedEngineBinding = {
    schema_version: WALMART_BUYER_EVIDENCE_ENGINE_BINDING_VERSION,
    channel: "WALMART" as const,
    certification_sha256: certificationSha256,
    verify_receipt_sha256: verifyReceiptSha256,
    channel_sku_id: channelSkuId,
    submission_attempt_id: submissionAttemptId,
    sku,
    walmart_item_id: walmartItemId,
    source_url: sourceUrl,
    source_kind: "MANUAL_BROWSER_VERIFICATION" as const,
  };
  if (
    declaredBindingSha256 !==
      buyerEvidenceEngineBindingSha256(expectedEngineBinding)
  ) {
    throw new Error("engineBinding does not match the certified buyer target");
  }
  return { draft, artifactPath: artifact.ref };
}

export function assertWalmartBuyerEvidenceTemplateBinding(input: {
  draft: unknown;
  certification: WalmartBuyerEvidenceCertificationBinding;
  verifyReceipt: WalmartBuyerEvidenceVerifyReceiptBinding;
}): {
  draft: Record<string, unknown>;
  artifactPath: string;
} {
  return inspectWalmartBuyerEvidenceTemplateBinding({
    ...input,
    artifactSha256State: "PLACEHOLDER",
  });
}

export function assertWalmartBuyerEvidenceSealedBinding(input: {
  evidence: unknown;
  certification: WalmartBuyerEvidenceCertificationBinding;
  verifyReceipt: WalmartBuyerEvidenceVerifyReceiptBinding;
  now?: Date;
}): WalmartBuyerPublicationEvidenceInput {
  const inspected = inspectWalmartBuyerEvidenceTemplateBinding({
    draft: input.evidence,
    certification: input.certification,
    verifyReceipt: input.verifyReceipt,
    artifactSha256State: "SEALED",
  });
  const now = input.now ?? new Date();
  const capturedAt = new Date(
    String((inspected.draft as { capturedAt?: unknown }).capturedAt),
  );
  if (
    capturedAt.getTime() > now.getTime() ||
    now.getTime() - capturedAt.getTime() > WALMART_BUYER_EVIDENCE_MAX_AGE_MS
  ) {
    throw new Error("buyer evidence capturedAt is outside the 30-minute freshness window");
  }
  validateWalmartBuyerPublicationEvidence(
    inspected.draft as unknown as WalmartBuyerPublicationEvidenceInput,
    now,
  );
  return inspected.draft as unknown as WalmartBuyerPublicationEvidenceInput;
}

/**
 * Local-only operator step. It changes exactly one field in a completed
 * engine-generated worksheet after hashing the exact screenshot bytes through
 * the shared no-follow/single-link/race-checked evidence reader.
 */
export async function sealWalmartBuyerEvidenceTemplate(input: {
  draft: unknown;
  certification: WalmartBuyerEvidenceCertificationBinding;
  verifyReceipt: WalmartBuyerEvidenceVerifyReceiptBinding;
  now?: Date;
  testOnlyAfterOpen?: (path: string) => Promise<void> | void;
}): Promise<{
  sealed: Record<string, unknown>;
  artifact: { path: string; sha256: string };
}> {
  const bound = assertWalmartBuyerEvidenceTemplateBinding({
    draft: input.draft,
    certification: input.certification,
    verifyReceipt: input.verifyReceipt,
  });
  const digest = await hashWalmartNewSkuEvidenceArtifact({
    path: bound.artifactPath,
    testOnlyAfterOpen: input.testOnlyAfterOpen,
  });
  const sealed = structuredClone(bound.draft);
  const rawEvidence = objectValue(sealed.rawEvidence, "rawEvidence");
  const artifact = objectValue(rawEvidence.artifact, "rawEvidence.artifact");
  artifact.sha256 = digest.sha256;
  assertWalmartBuyerEvidenceSealedBinding({
    evidence: sealed,
    certification: input.certification,
    verifyReceipt: input.verifyReceipt,
    now: input.now,
  });
  return {
    sealed,
    artifact: { path: bound.artifactPath, sha256: digest.sha256 },
  };
}

function validateRawEvidenceContract(input: {
  rawEvidence: unknown;
  sourceKind: WalmartBuyerEvidenceSourceKind;
  sku: string;
  walmartItemId: string;
  sourceUrl: string;
  capturedAt: Date;
}): WalmartBuyerRawEvidenceContract {
  const raw = objectValue(input.rawEvidence, "rawEvidence");
  exactString(
    raw.schema_version,
    WALMART_BUYER_RAW_EVIDENCE_VERSION,
    "rawEvidence.schema_version",
  );
  exactString(raw.source_kind, input.sourceKind, "rawEvidence.source_kind");

  const binding = objectValue(raw.binding, "rawEvidence.binding");
  exactString(binding.sku, input.sku, "rawEvidence.binding.sku");
  exactString(
    binding.walmart_item_id,
    input.walmartItemId,
    "rawEvidence.binding.walmart_item_id",
  );
  exactString(
    binding.source_url,
    input.sourceUrl,
    "rawEvidence.binding.source_url",
  );
  exactString(
    binding.captured_at,
    input.capturedAt.toISOString(),
    "rawEvidence.binding.captured_at",
  );

  const artifact = objectValue(raw.artifact, "rawEvidence.artifact");
  exactString(
    artifact.kind,
    EXPECTED_ARTIFACT_KIND[input.sourceKind],
    "rawEvidence.artifact.kind",
  );
  if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error("rawEvidence.artifact.sha256 must be lowercase SHA-256 hex");
  }
  if (typeof artifact.ref !== "string" || !artifact.ref.trim()) {
    throw new Error("rawEvidence.artifact.ref is required");
  }

  const observation = objectValue(raw.observation, "rawEvidence.observation");
  if (observation.page_rendered !== true) {
    throw new Error("rawEvidence must prove that the buyer PDP rendered");
  }
  if (
    typeof observation.availability !== "string" ||
    !BUYABLE_AVAILABILITY.has(observation.availability)
  ) {
    throw new Error("rawEvidence must contain a buyable availability signal");
  }
  if (observation.add_to_cart_enabled !== true) {
    throw new Error("rawEvidence must prove that add-to-cart was enabled");
  }
  if (
    input.sourceKind === "WALMART_BUYER_PDP" &&
    observation.http_status !== 200
  ) {
    throw new Error("WALMART_BUYER_PDP rawEvidence requires HTTP 200");
  }
  if (
    input.sourceKind === "MANUAL_BROWSER_VERIFICATION" &&
    (typeof raw.observer !== "string" || !raw.observer.trim())
  ) {
    throw new Error("manual browser rawEvidence requires an observer");
  }

  return raw as unknown as WalmartBuyerRawEvidenceContract;
}

export function validateWalmartBuyerPublicationEvidence(
  input: WalmartBuyerPublicationEvidenceInput,
  now = new Date(),
): ValidatedWalmartBuyerPublicationEvidence {
  const channelSkuId = normalizedNonEmpty(input.channelSkuId, "channelSkuId");
  const submissionAttemptId = normalizedNonEmpty(
    input.submissionAttemptId,
    "submissionAttemptId",
  );
  const sku = normalizedNonEmpty(input.sku, "sku");
  const walmartItemId = normalizedNonEmpty(input.walmartItemId, "walmartItemId");
  if (!/^\d+$/.test(walmartItemId)) {
    throw new Error("walmartItemId must be the exact numeric buyer item ID");
  }
  const sourceUrl = normalizedNonEmpty(input.sourceUrl, "sourceUrl");
  const urlItemId = exactWalmartItemIdFromUrl(sourceUrl);
  if (urlItemId !== walmartItemId) {
    throw new Error("sourceUrl does not resolve the exact Walmart item ID");
  }
  const capturedAt =
    input.capturedAt instanceof Date
      ? new Date(input.capturedAt.getTime())
      : new Date(input.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) throw new Error("capturedAt is invalid");
  if (capturedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("capturedAt cannot be materially in the future");
  }
  if (!input.exactSkuMatch) throw new Error("exact SKU match is required");
  if (!input.exactItemIdMatch) throw new Error("exact itemId match is required");
  if (!input.published) throw new Error("buyer PDP must be published");
  if (!input.buyable) throw new Error("buyer PDP must be buyable");
  if (
    ![
      "WALMART_BUYER_PDP",
      "SEALED_BUYER_SNAPSHOT",
      "MANUAL_BROWSER_VERIFICATION",
    ].includes(input.sourceKind)
  ) {
    throw new Error("sourceKind is unsupported");
  }

  validateRawEvidenceContract({
    rawEvidence: input.rawEvidence,
    sourceKind: input.sourceKind,
    sku,
    walmartItemId,
    sourceUrl,
    capturedAt,
  });

  const rawEvidenceJson = canonicalWalmartPayloadJson(input.rawEvidence);
  const hashBody = {
    schema_version: WALMART_BUYER_EVIDENCE_VERSION,
    channel_sku_id: channelSkuId,
    submission_attempt_id: submissionAttemptId,
    sku,
    walmart_item_id: walmartItemId,
    source_url: sourceUrl,
    source_kind: input.sourceKind,
    captured_at: capturedAt.toISOString(),
    exact_sku_match: true,
    exact_item_id_match: true,
    published: true,
    buyable: true,
    raw_evidence: JSON.parse(rawEvidenceJson) as unknown,
  };
  const evidenceHash = createHash("sha256")
    .update(canonicalWalmartPayloadJson(hashBody))
    .digest("hex");

  return {
    channelSkuId,
    submissionAttemptId,
    sku,
    walmartItemId,
    sourceUrl,
    sourceKind: input.sourceKind,
    capturedAt,
    exactSkuMatch: true,
    exactItemIdMatch: true,
    published: true,
    buyable: true,
    rawEvidenceJson,
    evidenceHash,
  };
}

function resolveLocalArtifactPath(artifactRef: string): string {
  const ref = artifactRef.trim();
  if (ref.includes("\0")) {
    throw new Error("rawEvidence.artifact.ref contains an invalid null byte");
  }
  if (ref.startsWith("file:")) {
    let artifactUrl: URL;
    try {
      artifactUrl = new URL(ref);
    } catch {
      throw new Error("rawEvidence.artifact.ref contains an invalid file URL");
    }
    if (artifactUrl.protocol !== "file:" || artifactUrl.search || artifactUrl.hash) {
      throw new Error(
        "rawEvidence.artifact.ref must be a plain local file URL without query or fragment",
      );
    }
    try {
      return resolve(fileURLToPath(artifactUrl));
    } catch {
      throw new Error("rawEvidence.artifact.ref contains an invalid local file URL");
    }
  }
  if (!isAbsolute(ref)) {
    throw new Error(
      "rawEvidence.artifact.ref must be an absolute local path or file URL",
    );
  }
  return resolve(ref);
}

/**
 * Re-opens and hashes the exact local artifact snapshot represented in the
 * canonical evidence JSON. The database transaction is never entered unless
 * the declared digest equals the bytes currently stored in a regular,
 * non-symlink file.
 */
async function verifyLocalBuyerEvidenceArtifact(
  canonicalRawEvidence: unknown,
): Promise<{ path: string; sha256: string }> {
  const raw = objectValue(canonicalRawEvidence, "rawEvidence");
  const artifact = objectValue(raw.artifact, "rawEvidence.artifact");
  if (typeof artifact.ref !== "string" || !artifact.ref.trim()) {
    throw new Error("rawEvidence.artifact.ref is required");
  }
  if (
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  ) {
    throw new Error("rawEvidence.artifact.sha256 must be lowercase SHA-256 hex");
  }

  const artifactPath = resolveLocalArtifactPath(artifact.ref);
  const digest = await hashWalmartNewSkuEvidenceArtifact({ path: artifactPath });
  if (digest.sha256 !== artifact.sha256) {
    throw new Error(
      "rawEvidence.artifact.sha256 does not match the local artifact bytes",
    );
  }
  return { path: artifactPath, sha256: digest.sha256 };
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

function assertPersistedEvidenceMatches(
  row: {
    channel_sku_id: string;
    submission_attempt_id: string;
    sku: string;
    walmart_item_id: string;
    source_url: string;
    source_kind: string;
    captured_at: Date;
    exact_sku_match: boolean;
    exact_item_id_match: boolean;
    published: boolean;
    buyable: boolean;
    evidence_hash: string;
    raw_evidence: string;
  },
  evidence: ValidatedWalmartBuyerPublicationEvidence,
): void {
  if (
    row.channel_sku_id !== evidence.channelSkuId ||
    row.submission_attempt_id !== evidence.submissionAttemptId ||
    row.sku !== evidence.sku ||
    row.walmart_item_id !== evidence.walmartItemId ||
    row.source_url !== evidence.sourceUrl ||
    row.source_kind !== evidence.sourceKind ||
    row.captured_at.getTime() !== evidence.capturedAt.getTime() ||
    row.exact_sku_match !== true ||
    row.exact_item_id_match !== true ||
    row.published !== true ||
    row.buyable !== true ||
    row.evidence_hash !== evidence.evidenceHash ||
    row.raw_evidence !== evidence.rawEvidenceJson
  ) {
    throw new Error(
      "existing Walmart buyer evidence hash resolves to different evidence",
    );
  }
}

export async function recordWalmartBuyerPublicationEvidence(
  input: WalmartBuyerPublicationEvidenceInput,
  expectedAttempt: WalmartCertifiedSubmissionAttemptBinding,
) {
  const evidence = validateWalmartBuyerPublicationEvidence(input);
  await verifyLocalBuyerEvidenceArtifact(JSON.parse(evidence.rawEvidenceJson));
  try {
    return await prisma.$transaction(async (tx) => {
      const [sku, attempt, latestAttempt, existing] = await Promise.all([
        tx.channelSKU.findUnique({
          where: { id: evidence.channelSkuId },
          select: { id: true, sku: true, channel: true },
        }),
        tx.marketplaceSubmissionAttempt.findUnique({
          where: { id: evidence.submissionAttemptId },
        }),
        tx.marketplaceSubmissionAttempt.findFirst({
          where: {
            channel_sku_id: evidence.channelSkuId,
            marketplace: "WALMART",
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
        }),
        tx.walmartBuyerPublicationEvidence.findUnique({
          where: { evidence_hash: evidence.evidenceHash },
        }),
      ]);
      if (!sku) throw new Error("ChannelSKU does not exist");
      if (sku.channel !== "WALMART") {
        throw new Error("buyer evidence is Walmart-only");
      }
      if (sku.sku !== evidence.sku) {
        throw new Error("buyer evidence SKU does not match ChannelSKU");
      }
      if (
        !attempt ||
        attempt.channel_sku_id !== sku.id ||
        attempt.marketplace !== "WALMART"
      ) {
        throw new Error("buyer evidence does not match the Walmart submission attempt");
      }
      if (
        expectedAttempt.attemptId !== evidence.submissionAttemptId ||
        latestAttempt?.id !== expectedAttempt.attemptId
      ) {
        throw new Error(
          "buyer evidence does not target the latest certified Walmart attempt",
        );
      }
      assertWalmartCertifiedSubmissionAttemptBinding({
        expected: expectedAttempt,
        attempt,
      });
      // Returning the exact immutable row is safe even after the attempt later
      // becomes terminal, and makes an operator/Claude replay idempotent.
      if (existing) {
        assertPersistedEvidenceMatches(existing, evidence);
        return existing;
      }
      const notBefore =
        attempt.accepted_at ?? attempt.requested_at ?? attempt.claimed_at;
      if (evidence.capturedAt < notBefore) {
        throw new Error("buyer evidence predates the marketplace submission attempt");
      }
      if (attempt.state === "REJECTED" || attempt.state === "RETRYABLE") {
        throw new Error(`buyer evidence cannot attach to ${attempt.state} attempt`);
      }

      return tx.walmartBuyerPublicationEvidence.create({
        data: {
          id: randomUUID(),
          channel_sku_id: evidence.channelSkuId,
          submission_attempt_id: evidence.submissionAttemptId,
          sku: evidence.sku,
          walmart_item_id: evidence.walmartItemId,
          source_url: evidence.sourceUrl,
          source_kind: evidence.sourceKind,
          captured_at: evidence.capturedAt,
          exact_sku_match: true,
          exact_item_id_match: true,
          published: true,
          buyable: true,
          evidence_hash: evidence.evidenceHash,
          raw_evidence: evidence.rawEvidenceJson,
        },
      });
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Two identical captures may race. The unique evidence_hash is the
    // idempotency boundary; re-read and verify instead of surfacing P2002.
    const existing = await prisma.walmartBuyerPublicationEvidence.findUnique({
      where: { evidence_hash: evidence.evidenceHash },
    });
    if (!existing) throw error;
    assertPersistedEvidenceMatches(existing, evidence);
    return existing;
  }
}

export async function findQualifyingWalmartBuyerEvidence(input: {
  channelSkuId: string;
  submissionAttemptId: string;
  sku: string;
  walmartItemId: string;
  notBefore: Date;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const effectiveNotBefore = walmartBuyerEvidenceNotBefore(input.notBefore, now);
  return prisma.walmartBuyerPublicationEvidence.findFirst({
    where: {
      channel_sku_id: input.channelSkuId,
      submission_attempt_id: input.submissionAttemptId,
      sku: input.sku,
      walmart_item_id: input.walmartItemId,
      exact_sku_match: true,
      exact_item_id_match: true,
      published: true,
      buyable: true,
      captured_at: { gte: effectiveNotBefore, lte: now },
    },
    orderBy: { captured_at: "desc" },
  });
}

/** Recovery lookup for the crash window where Walmart accepted the POST but
 * the process did not persist a feedId. The immutable attempt/SKU binding and
 * exact buyer proof may recover the numeric itemId without a positional API
 * fallback. */
export async function findQualifyingWalmartBuyerEvidenceForAttempt(input: {
  channelSkuId: string;
  submissionAttemptId: string;
  sku: string;
  notBefore: Date;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const effectiveNotBefore = walmartBuyerEvidenceNotBefore(input.notBefore, now);
  return prisma.walmartBuyerPublicationEvidence.findFirst({
    where: {
      channel_sku_id: input.channelSkuId,
      submission_attempt_id: input.submissionAttemptId,
      sku: input.sku,
      exact_sku_match: true,
      exact_item_id_match: true,
      published: true,
      buyable: true,
      captured_at: { gte: effectiveNotBefore, lte: now },
    },
    orderBy: { captured_at: "desc" },
  });
}

/** Read-only operator/engine status surface for the pilot workflow. */
export async function getWalmartBuyerPublicationEvidenceStatus(
  channelSkuId: string,
  expectedAttemptId?: string,
): Promise<{
  channel_sku_id: string;
  attempt_id: string | null;
  attempt_state: string | null;
  walmart_item_id: string | null;
  buyer_verified: boolean;
  evidence_id: string | null;
  evidence_hash: string | null;
  captured_at: string | null;
}> {
  const attempt = expectedAttemptId
    ? await prisma.marketplaceSubmissionAttempt.findUnique({
        where: { id: expectedAttemptId },
      })
    : await prisma.marketplaceSubmissionAttempt.findFirst({
        where: { channel_sku_id: channelSkuId, marketplace: "WALMART" },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      });
  if (!attempt) {
    return {
      channel_sku_id: channelSkuId,
      attempt_id: null,
      attempt_state: null,
      walmart_item_id: null,
      buyer_verified: false,
      evidence_id: null,
      evidence_hash: null,
      captured_at: null,
    };
  }
  if (
    attempt.channel_sku_id !== channelSkuId ||
    attempt.marketplace !== "WALMART"
  ) {
    throw new Error("Buyer evidence status attempt is outside the Walmart SKU");
  }
  const evidence = await prisma.walmartBuyerPublicationEvidence.findFirst({
    where: {
      channel_sku_id: channelSkuId,
      submission_attempt_id: attempt.id,
      exact_sku_match: true,
      exact_item_id_match: true,
      published: true,
      buyable: true,
    },
    orderBy: { captured_at: "desc" },
  });
  return {
    channel_sku_id: channelSkuId,
    attempt_id: attempt.id,
    attempt_state: attempt.state,
    walmart_item_id: evidence?.walmart_item_id ?? null,
    buyer_verified: attempt.state === "BUYER_VERIFIED" && Boolean(evidence),
    evidence_id: evidence?.id ?? null,
    evidence_hash: evidence?.evidence_hash ?? null,
    captured_at: evidence?.captured_at.toISOString() ?? null,
  };
}
