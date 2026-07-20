/**
 * Durable, fail-closed lifecycle for Walmart MP_ITEM submissions.
 *
 * Walmart's feed POST has no repository-level idempotency guarantee. We fence
 * every network attempt with a durable row created before the request, bind the
 * row to the canonical payload hash, and atomically consume that claim directly
 * before POST. An ambiguous POST is never automatically retryable: seller-SKU
 * absence cannot prove that Walmart did not accept the first request.
 */

import { createHash, randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { hashWalmartPayload } from "./walmart-payload-hash";
import type { WalmartOwnerPermit } from "../walmart-owner-permit";

export {
  canonicalWalmartPayloadJson,
  hashWalmartPayload,
} from "./walmart-payload-hash";

export const WALMART_PUBLISH_LIFECYCLE_VERSION =
  "walmart-publish-lifecycle/v2" as const;
export const WALMART_PILOT_MAX_APPLY_SKUS = 2;
export const WALMART_UNKNOWN_RECOVERY_GRACE_MS = 2 * 60 * 60 * 1_000;

export const WALMART_POLLABLE_LISTING_STATUSES = [
  "SUBMITTED",
  "PENDING_REVIEW",
  "SUBMITTING",
  "SUBMISSION_UNKNOWN",
] as const;

export type WalmartSubmissionAttemptState =
  | "CLAIMED"
  | "REQUESTING"
  | "ACCEPTED"
  | "UNKNOWN"
  | "PENDING_REVIEW"
  | "BUYER_VERIFIED"
  | "REJECTED"
  | "RETRYABLE";

export type WalmartMarketplaceDisposition =
  | "CLAIMED"
  | "REQUESTING"
  | "FEED_ACCEPTED"
  | "SUBMISSION_AMBIGUOUS"
  | "LOCAL_PREFLIGHT_RETRYABLE"
  | "FEED_PROCESSING"
  | "BUYER_VERIFICATION_PENDING"
  | "BUYER_VERIFIED"
  | "UPC_COLLISION"
  | "GTIN_OWNERSHIP_REJECTED"
  | "MARKETPLACE_REJECTED"
  | "POLL_TRANSIENT"
  | "MANUAL_RECONCILIATION_REQUIRED";

export interface MarketplaceIssue {
  code?: string;
  message?: string;
  severity?: string;
}

export function walmartSubmissionIdempotencyKey(
  channelSkuId: string,
  payloadHash: string,
): string {
  if (!channelSkuId.trim()) throw new Error("channelSkuId is required");
  if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
    throw new Error("payloadHash must be lowercase SHA-256 hex");
  }
  return `walmart:v1:${createHash("sha256")
    .update(`${channelSkuId}\n${payloadHash}`)
    .digest("hex")}`;
}

export interface WalmartCertifiedSubmissionAttemptBinding {
  attemptId: string;
  channelSkuId: string;
  certificationSha256: string;
  payloadSha256: string;
  sellerAccountFingerprintSha256: string;
  idempotencyKey: string;
}

export interface WalmartSubmissionAttemptIdentity {
  id: string;
  channel_sku_id: string;
  marketplace: string;
  certification_sha256: string;
  payload_hash: string;
  seller_account_fingerprint_sha256: string;
  idempotency_key: string;
}

/** Exact certification -> signed permit -> durable attempt fence. */
export function assertWalmartCertifiedSubmissionAttemptBinding(input: {
  expected: WalmartCertifiedSubmissionAttemptBinding;
  attempt: WalmartSubmissionAttemptIdentity | null;
}): void {
  const expectedIdempotencyKey = walmartSubmissionIdempotencyKey(
    input.expected.channelSkuId,
    input.expected.payloadSha256,
  );
  const attempt = input.attempt;
  if (
    !attempt ||
    input.expected.idempotencyKey !== expectedIdempotencyKey ||
    attempt.id !== input.expected.attemptId ||
    attempt.channel_sku_id !== input.expected.channelSkuId ||
    attempt.marketplace !== "WALMART" ||
    attempt.certification_sha256 !== input.expected.certificationSha256 ||
    attempt.payload_hash !== input.expected.payloadSha256 ||
    attempt.seller_account_fingerprint_sha256 !==
      input.expected.sellerAccountFingerprintSha256 ||
    attempt.idempotency_key !== expectedIdempotencyKey
  ) {
    throw new Error(
      "Walmart submission attempt is not exactly bound to the supplied certification",
    );
  }
}

export function walmartRecoveryDelayMs(recoveryCount: number): number {
  const bounded = Math.max(0, Math.min(6, Math.trunc(recoveryCount)));
  return Math.min(60 * 60 * 1_000, 5 * 60 * 1_000 * 2 ** bounded);
}

export function walmartUnknownAbsenceRecovery(input: {
  claimedAt: Date;
  now: Date;
}): {
  state: "UNKNOWN";
  disposition: "SUBMISSION_AMBIGUOUS" | "MANUAL_RECONCILIATION_REQUIRED";
  automatic_retry_allowed: false;
} {
  if (!Number.isFinite(input.claimedAt.getTime()) || !Number.isFinite(input.now.getTime())) {
    throw new Error("claimedAt and now must be valid dates");
  }
  return {
    state: "UNKNOWN",
    disposition:
      input.now.getTime() - input.claimedAt.getTime()
        >= WALMART_UNKNOWN_RECOVERY_GRACE_MS
        ? "MANUAL_RECONCILIATION_REQUIRED"
        : "SUBMISSION_AMBIGUOUS",
    automatic_retry_allowed: false,
  };
}

export function classifyWalmartDurableSynchronousFailure(input: {
  state: string;
  requestCount: number;
}): {
  state: "UNKNOWN" | "RETRYABLE";
  disposition: "SUBMISSION_AMBIGUOUS" | "LOCAL_PREFLIGHT_RETRYABLE";
  release_active_fence: boolean;
} {
  if (input.state === "CLAIMED" && input.requestCount === 0) {
    return {
      state: "RETRYABLE",
      disposition: "LOCAL_PREFLIGHT_RETRYABLE",
      release_active_fence: true,
    };
  }
  if (input.state === "REQUESTING" && input.requestCount === 1) {
    return {
      state: "UNKNOWN",
      disposition: "SUBMISSION_AMBIGUOUS",
      release_active_fence: false,
    };
  }
  throw new Error("Walmart submission attempt has an invalid request counter/state");
}

export function classifyWalmartMarketplaceIssues(
  issues: MarketplaceIssue[] | null | undefined,
): WalmartMarketplaceDisposition {
  const rows = issues ?? [];
  const combined = rows
    .map((issue) => `${issue.code ?? ""} ${issue.message ?? ""}`.toLowerCase())
    .join("\n");
  if (
    /\b(upc|gtin|ean|barcode|product\s*id(?:entifier)?)\b[^\n]*(already|duplicate|in use|assigned|associated|another item|conflict)/i.test(
      combined,
    ) ||
    /(already|duplicate|in use|conflict)[^\n]*\b(upc|gtin|ean|barcode|product\s*id(?:entifier)?)\b/i.test(
      combined,
    )
  ) {
    return "UPC_COLLISION";
  }
  if (
    /\b(gtin|upc|ean|barcode)\b[^\n]*(owner|ownership|licensed|gs1|brand mismatch|not authorized|not registered)/i.test(
      combined,
    ) ||
    /(owner|ownership|licensed|gs1|not authorized)[^\n]*\b(gtin|upc|ean|barcode)\b/i.test(
      combined,
    )
  ) {
    return "GTIN_OWNERSHIP_REJECTED";
  }
  return "MARKETPLACE_REJECTED";
}

export function walmartDispositionQuarantinesUpc(
  disposition: WalmartMarketplaceDisposition | null | undefined,
): boolean {
  return (
    disposition === "UPC_COLLISION" ||
    disposition === "GTIN_OWNERSHIP_REJECTED"
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

export interface WalmartPublishLifecycleSchemaReport {
  ready: boolean;
  missing: string[];
}

/** Read-only runtime doctor. Apply paths call the throwing variant before any
 * draft/attempt mutation so an undeployed migration fails with a clear gate. */
export async function inspectWalmartPublishLifecycleSchema(): Promise<WalmartPublishLifecycleSchemaReport> {
  const [attemptColumns, evidenceColumns, objects] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ name?: string }>>(
      `PRAGMA table_info('MarketplaceSubmissionAttempt')`,
    ),
    prisma.$queryRawUnsafe<Array<{ name?: string }>>(
      `PRAGMA table_info('WalmartBuyerPublicationEvidence')`,
    ),
    prisma.$queryRawUnsafe<Array<{ name?: string; type?: string }>>(
      `SELECT name, type FROM sqlite_master
       WHERE name IN (
         'MarketplaceSubmissionAttempt_active_key_key',
         'MarketplaceSubmissionAttempt_idempotency_key_key',
         'MarketplaceSubmissionAttempt_pilot_permit_sha256_key',
         'MarketplaceSubmissionAttempt_pilot_permit_id_key',
         'MarketplaceSubmissionAttempt_owner_signature_sha256_key',
         'MarketplaceSubmissionAttempt_pilot_slot_key',
         'UPCPool_reserved_for_id_key',
         'MarketplaceSubmissionAttempt_active_insert_guard',
         'MarketplaceSubmissionAttempt_active_update_guard',
         'MarketplaceSubmissionAttempt_identity_immutable',
         'MarketplaceSubmissionAttempt_no_delete',
         'MarketplaceSubmissionAttempt_pilot_global_cap',
         'WalmartBuyerPublicationEvidence_attempt_sku_guard',
         'WalmartBuyerPublicationEvidence_no_update',
         'WalmartBuyerPublicationEvidence_no_delete'
       )`,
    ),
  ]);
  const attempt = new Set(attemptColumns.map((row) => row.name).filter(Boolean));
  const evidence = new Set(evidenceColumns.map((row) => row.name).filter(Boolean));
  const schemaObjects = new Set(objects.map((row) => row.name).filter(Boolean));
  const missing: string[] = [];
  for (const column of [
    "idempotency_key",
    "active_key",
    "payload_hash",
    "claim_token",
    "state",
    "retry_after",
    "pilot_permit_sha256",
    "pilot_permit_id",
    "owner_key_id",
    "owner_signature_sha256",
    "pilot_slot",
    "pilot_approval_sha256",
    "certification_sha256",
    "seller_account_fingerprint_sha256",
  ]) {
    if (!attempt.has(column)) missing.push(`MarketplaceSubmissionAttempt.${column}`);
  }
  for (const column of [
    "submission_attempt_id",
    "walmart_item_id",
    "exact_sku_match",
    "exact_item_id_match",
    "published",
    "buyable",
    "evidence_hash",
  ]) {
    if (!evidence.has(column)) {
      missing.push(`WalmartBuyerPublicationEvidence.${column}`);
    }
  }
  for (const object of [
    "MarketplaceSubmissionAttempt_active_key_key",
    "MarketplaceSubmissionAttempt_idempotency_key_key",
    "MarketplaceSubmissionAttempt_pilot_permit_sha256_key",
    "MarketplaceSubmissionAttempt_pilot_permit_id_key",
    "MarketplaceSubmissionAttempt_owner_signature_sha256_key",
    "MarketplaceSubmissionAttempt_pilot_slot_key",
    "UPCPool_reserved_for_id_key",
    "MarketplaceSubmissionAttempt_active_insert_guard",
    "MarketplaceSubmissionAttempt_active_update_guard",
    "MarketplaceSubmissionAttempt_identity_immutable",
    "MarketplaceSubmissionAttempt_no_delete",
    "MarketplaceSubmissionAttempt_pilot_global_cap",
    "WalmartBuyerPublicationEvidence_attempt_sku_guard",
    "WalmartBuyerPublicationEvidence_no_update",
    "WalmartBuyerPublicationEvidence_no_delete",
  ]) {
    if (!schemaObjects.has(object)) missing.push(`sqlite_master.${object}`);
  }
  return { ready: missing.length === 0, missing };
}

export async function assertWalmartPublishLifecycleSchema(): Promise<void> {
  const report = await inspectWalmartPublishLifecycleSchema();
  if (!report.ready) {
    throw new Error(
      `Walmart publish lifecycle migration is not ready: ${report.missing.join(", ")}`,
    );
  }
}

class ClaimUnavailableError extends Error {}

export interface WalmartSubmissionClaim {
  claimed: boolean;
  attempt_id: string | null;
  claim_token: string | null;
  idempotency_key: string;
  payload_hash: string;
  prior_state?: string;
  reason?: string;
}

/** Opaque-by-contract pointer to a lifecycle row. Possession is not authority:
 * the transport must atomically consume the matching durable CLAIMED row. */
export interface WalmartFeedPostLifecycleClaim {
  attemptId: string;
  claimToken: string;
}

export interface WalmartPilotSubmissionPermit {
  permitSha256: string;
  permitId: string;
  ownerKeyId: string;
  ownerSignatureSha256: string;
  signedPermit: WalmartOwnerPermit;
  engineReleaseSha256: string;
  pilotSlot: 1 | 2;
  approvalSha256: string;
  certificationSha256: string;
  sellerAccountFingerprintSha256: string;
}

export async function claimWalmartSubmission(input: {
  channelSkuId: string;
  payload: Record<string, unknown>;
  pilotPermit: WalmartPilotSubmissionPermit;
  now?: Date;
  allowLiveRepublish?: boolean;
}): Promise<WalmartSubmissionClaim> {
  const now = input.now ?? new Date();
  const payloadHash = hashWalmartPayload(input.payload);
  const idempotencyKey = walmartSubmissionIdempotencyKey(
    input.channelSkuId,
    payloadHash,
  );
  const claimToken = randomUUID();
  const attemptId = randomUUID();
  const signedBody = input.pilotPermit.signedPermit?.signed_body;
  if (
    !/^[a-f0-9]{64}$/.test(input.pilotPermit.permitSha256) ||
    !input.pilotPermit.permitId.trim() ||
    !input.pilotPermit.ownerKeyId.trim() ||
    !/^[a-f0-9]{64}$/.test(input.pilotPermit.ownerSignatureSha256) ||
    input.pilotPermit.signedPermit?.permit_sha256 !==
      input.pilotPermit.permitSha256 ||
    input.pilotPermit.signedPermit?.key_id !== input.pilotPermit.ownerKeyId ||
    input.pilotPermit.signedPermit?.signature_sha256 !==
      input.pilotPermit.ownerSignatureSha256 ||
    signedBody?.permit_id !== input.pilotPermit.permitId ||
    signedBody?.engine_release_sha256 !== input.pilotPermit.engineReleaseSha256 ||
    signedBody?.pilot_slot !== input.pilotPermit.pilotSlot ||
    signedBody?.approval_sha256 !== input.pilotPermit.approvalSha256 ||
    signedBody?.certification_sha256 !==
      input.pilotPermit.certificationSha256 ||
    signedBody?.channel_sku_id !== input.channelSkuId ||
    signedBody?.payload_sha256 !== payloadHash ||
    signedBody?.seller_account_fingerprint_sha256 !==
      input.pilotPermit.sellerAccountFingerprintSha256 ||
    ![1, 2].includes(input.pilotPermit.pilotSlot) ||
    !/^[a-f0-9]{64}$/.test(input.pilotPermit.approvalSha256) ||
    !/^[a-f0-9]{64}$/.test(input.pilotPermit.certificationSha256) ||
    !/^[a-f0-9]{64}$/.test(
      input.pilotPermit.sellerAccountFingerprintSha256,
    )
  ) {
    throw new Error("Walmart submission claim requires an exact owner pilot permit");
  }
  const allowedListingStatuses = input.allowLiveRepublish
    ? ["PENDING", "FAILED", "RETRYABLE", "LIVE"]
    : ["PENDING", "FAILED", "RETRYABLE"];

  const claimExistingRetryable = async () => {
    const existing = await prisma.marketplaceSubmissionAttempt.findUnique({
      where: { idempotency_key: idempotencyKey },
    });
    if (!existing) return null;
    if (
      existing.pilot_permit_sha256 !== input.pilotPermit.permitSha256 ||
      existing.pilot_permit_id !== input.pilotPermit.permitId ||
      existing.owner_key_id !== input.pilotPermit.ownerKeyId ||
      existing.owner_signature_sha256 !==
        input.pilotPermit.ownerSignatureSha256 ||
      existing.pilot_slot !== input.pilotPermit.pilotSlot ||
      existing.pilot_approval_sha256 !== input.pilotPermit.approvalSha256 ||
      existing.certification_sha256 !==
        input.pilotPermit.certificationSha256 ||
      existing.seller_account_fingerprint_sha256 !==
        input.pilotPermit.sellerAccountFingerprintSha256
    ) {
      return {
        claimed: false,
        attempt_id: existing.id,
        claim_token: null,
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        prior_state: existing.state,
        reason: "same payload attempt is bound to another owner pilot permit",
      } satisfies WalmartSubmissionClaim;
    }
    if (
      existing.state !== "RETRYABLE" ||
      (existing.retry_after && existing.retry_after > now)
    ) {
      return {
        claimed: false,
        attempt_id: existing.id,
        claim_token: null,
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        prior_state: existing.state,
        reason: `same payload already has ${existing.state} attempt`,
      } satisfies WalmartSubmissionClaim;
    }
    try {
      await prisma.$transaction(async (tx) => {
        const attempt = await tx.marketplaceSubmissionAttempt.updateMany({
          where: {
            id: existing.id,
            state: "RETRYABLE",
            active_key: null,
            OR: [{ retry_after: null }, { retry_after: { lte: now } }],
          },
          data: {
            active_key: input.channelSkuId,
            claim_token: claimToken,
            state: "CLAIMED",
            marketplace_disposition: "CLAIMED",
            error_json: null,
            claimed_at: now,
            requested_at: null,
            accepted_at: null,
            terminal_at: null,
            retry_after: null,
          },
        });
        if (attempt.count !== 1) throw new ClaimUnavailableError();
        const sku = await tx.channelSKU.updateMany({
          where: {
            id: input.channelSkuId,
            listing_status: { in: allowedListingStatuses },
          },
          data: {
            listing_status: "SUBMITTING",
            lifecycle_status: "PROCESSING",
            processing_at: now,
            distribution_errors: null,
          },
        });
        if (sku.count !== 1) throw new ClaimUnavailableError();
      });
      return {
        claimed: true,
        attempt_id: existing.id,
        claim_token: claimToken,
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        prior_state: "RETRYABLE",
      } satisfies WalmartSubmissionClaim;
    } catch (error) {
      if (!isUniqueConstraintError(error) && !(error instanceof ClaimUnavailableError)) {
        throw error;
      }
      return {
        claimed: false,
        attempt_id: existing.id,
        claim_token: null,
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        prior_state: existing.state,
        reason: "retryable attempt was claimed concurrently",
      } satisfies WalmartSubmissionClaim;
    }
  };

  try {
    await prisma.$transaction(async (tx) => {
      const sku = await tx.channelSKU.updateMany({
        where: {
          id: input.channelSkuId,
          listing_status: { in: allowedListingStatuses },
        },
        data: {
          listing_status: "SUBMITTING",
          lifecycle_status: "PROCESSING",
          processing_at: now,
          distribution_errors: null,
        },
      });
      if (sku.count !== 1) throw new ClaimUnavailableError();
      await tx.marketplaceSubmissionAttempt.create({
        data: {
          id: attemptId,
          channel_sku_id: input.channelSkuId,
          marketplace: "WALMART",
          idempotency_key: idempotencyKey,
          active_key: input.channelSkuId,
          pilot_permit_sha256: input.pilotPermit.permitSha256,
          pilot_permit_id: input.pilotPermit.permitId,
          owner_key_id: input.pilotPermit.ownerKeyId,
          owner_signature_sha256: input.pilotPermit.ownerSignatureSha256,
          pilot_slot: input.pilotPermit.pilotSlot,
          pilot_approval_sha256: input.pilotPermit.approvalSha256,
          certification_sha256: input.pilotPermit.certificationSha256,
          seller_account_fingerprint_sha256:
            input.pilotPermit.sellerAccountFingerprintSha256,
          payload_hash: payloadHash,
          claim_token: claimToken,
          state: "CLAIMED",
          marketplace_disposition: "CLAIMED",
          claimed_at: now,
        },
      });
    });
    return {
      claimed: true,
      attempt_id: attemptId,
      claim_token: claimToken,
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
    };
  } catch (error) {
    if (!(error instanceof ClaimUnavailableError) && !isUniqueConstraintError(error)) {
      throw error;
    }
    const samePayload = await claimExistingRetryable();
    if (samePayload) return samePayload;
    const active = await prisma.marketplaceSubmissionAttempt.findUnique({
      where: { active_key: input.channelSkuId },
    });
    const sku = await prisma.channelSKU.findUnique({
      where: { id: input.channelSkuId },
      select: { listing_status: true },
    });
    return {
      claimed: false,
      attempt_id: active?.id ?? null,
      claim_token: null,
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      prior_state: active?.state ?? sku?.listing_status,
      reason: active
        ? `active ${active.state} attempt already fences this SKU`
        : `ChannelSKU status ${sku?.listing_status ?? "missing"} is not claimable`,
    };
  }
}

export async function markWalmartSubmissionRequesting(input: {
  attemptId: string;
  claimToken: string;
  channelSkuId: string;
  payloadHash: string;
  pilotPermitSha256: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  if (!input.attemptId.trim() || !input.claimToken.trim() || !input.channelSkuId.trim()) {
    throw new Error("Walmart feed POST claim identity is incomplete");
  }
  if (!/^[a-f0-9]{64}$/.test(input.payloadHash)
    || !/^[a-f0-9]{64}$/.test(input.pilotPermitSha256)) {
    throw new Error("Walmart feed POST claim hashes are invalid");
  }
  const result = await prisma.marketplaceSubmissionAttempt.updateMany({
    where: {
      id: input.attemptId,
      claim_token: input.claimToken,
      channel_sku_id: input.channelSkuId,
      payload_hash: input.payloadHash,
      pilot_permit_sha256: input.pilotPermitSha256,
      state: "CLAIMED",
      request_count: 0,
    },
    data: {
      state: "REQUESTING",
      marketplace_disposition: "REQUESTING",
      requested_at: now,
      request_count: 1,
    },
  });
  if (result.count !== 1) {
    throw new Error(
      "Walmart submission one-shot claim was absent, forged, changed, or already consumed",
    );
  }
}

export async function acceptWalmartSubmission(input: {
  channelSkuId: string;
  attemptId: string;
  claimToken: string;
  feedId: string;
  marketplaceStatus?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    const attempt = await tx.marketplaceSubmissionAttempt.updateMany({
      where: {
        id: input.attemptId,
        channel_sku_id: input.channelSkuId,
        claim_token: input.claimToken,
        state: "REQUESTING",
      },
      data: {
        state: "ACCEPTED",
        marketplace_submission_id: input.feedId,
        marketplace_disposition: "FEED_ACCEPTED",
        error_json: null,
        accepted_at: now,
        retry_after: null,
      },
    });
    if (attempt.count !== 1) {
      throw new Error("Walmart submission attempt was not REQUESTING at accept");
    }
    await tx.channelSKU.update({
      where: { id: input.channelSkuId },
      data: {
        listing_status: "SUBMITTED",
        lifecycle_status: "SUBMITTED",
        submission_id: input.feedId,
        submitted_at: now,
        distribution_attempt_count: { increment: 1 },
        last_status_check_at: now,
        distribution_errors: null,
      },
    });
    await tx.listingLifecycleLog.create({
      data: {
        entity_type: "ChannelSKU",
        entity_id: input.channelSkuId,
        channel_sku_id: input.channelSkuId,
        from_status: "PROCESSING",
        to_status: "SUBMITTED",
        trigger: "walmart_submission_accepted",
        details: JSON.stringify({
          attempt_id: input.attemptId,
          feed_id: input.feedId,
          marketplace_status: input.marketplaceStatus ?? null,
        }),
        user_id: "distribution-pipeline",
      },
    });
  });
}

export async function recordWalmartSynchronousFailure(input: {
  channelSkuId: string;
  attemptId: string;
  claimToken: string;
  feedId?: string | null;
  error?: string;
  now?: Date;
}): Promise<{
  listingStatus: "SUBMISSION_UNKNOWN" | "RETRYABLE" | "FAILED";
}> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const current = await tx.marketplaceSubmissionAttempt.findFirst({
      where: {
        id: input.attemptId,
        channel_sku_id: input.channelSkuId,
        claim_token: input.claimToken,
      },
      select: { state: true, request_count: true },
    });
    if (!current || (current.state !== "CLAIMED" && current.state !== "REQUESTING")) {
      throw new Error(
        "Walmart submission attempt is not an active pre-request/requesting claim",
      );
    }
    // CLAIMED + request_count=0 is durable proof that the transport never
    // acquired POST authority. Only this path may become automatically retryable.
    const classified = classifyWalmartDurableSynchronousFailure({
      state: current.state,
      requestCount: current.request_count,
    });
    const preRequestFailure = classified.release_active_fence;
    const listingStatus =
      classified.state === "UNKNOWN"
        ? "SUBMISSION_UNKNOWN"
        : classified.state === "RETRYABLE"
          ? "RETRYABLE"
          : "FAILED";
    const retryAfter = classified.state === "RETRYABLE"
      ? new Date(now.getTime() + walmartRecoveryDelayMs(0))
      : null;
    const attempt = await tx.marketplaceSubmissionAttempt.updateMany({
      where: {
        id: input.attemptId,
        channel_sku_id: input.channelSkuId,
        claim_token: input.claimToken,
        state: current.state,
        request_count: current.request_count,
      },
      data: {
        state: classified.state,
        active_key:
          classified.state === "UNKNOWN" ? input.channelSkuId : null,
        marketplace_disposition: classified.disposition,
        marketplace_submission_id: preRequestFailure
          ? undefined
          : input.feedId ?? undefined,
        error_json: JSON.stringify({ error: input.error ?? "missing feedId" }),
        retry_after: retryAfter,
        terminal_at: classified.state === "UNKNOWN" ? null : now,
      },
    });
    if (attempt.count !== 1) {
      throw new Error("Walmart submission attempt changed while recording failure");
    }
    const channelSku = await tx.channelSKU.updateMany({
      where: { id: input.channelSkuId },
      data: {
        listing_status: listingStatus,
        lifecycle_status: listingStatus === "FAILED" ? "ERROR" : "PROCESSING",
        submission_id: preRequestFailure ? undefined : input.feedId ?? undefined,
        submitted_at: !preRequestFailure && input.feedId ? now : undefined,
        distribution_attempt_count: { increment: 1 },
        last_status_check_at: now,
        last_error_at: now,
        distribution_errors: JSON.stringify([
          {
            code: classified.disposition,
            message: input.error ?? "Walmart submission returned no feedId",
            severity:
              classified.state === "UNKNOWN" ? "WARNING" : "ERROR",
          },
        ]),
      },
    });
    if (channelSku.count !== 1) {
      throw new Error("Walmart submission ChannelSKU changed while recording failure");
    }
    await tx.listingLifecycleLog.create({
      data: {
        entity_type: "ChannelSKU",
        entity_id: input.channelSkuId,
        channel_sku_id: input.channelSkuId,
        from_status: "PROCESSING",
        to_status: listingStatus === "FAILED" ? "ERROR" : "PROCESSING",
        trigger: `walmart_submission_${classified.state.toLowerCase()}`,
        details: JSON.stringify({
          attempt_id: input.attemptId,
          disposition: classified.disposition,
          retry_after: retryAfter?.toISOString() ?? null,
          post_authority_consumed: !preRequestFailure,
        }),
        user_id: "distribution-pipeline",
      },
      select: { id: true },
    });
    return { listingStatus };
  });
}

export async function getActiveWalmartSubmissionAttempt(channelSkuId: string) {
  return prisma.marketplaceSubmissionAttempt.findUnique({
    where: { active_key: channelSkuId },
  });
}

export async function releaseUnknownWalmartSubmissionForRetry(input: {
  channelSkuId: string;
  attemptId: string;
  reason: string;
  now?: Date;
}): Promise<never> {
  void input;
  throw new Error(
    "Automatic retry release is prohibited after a Walmart submission becomes ambiguous; manual reconciliation must retain the active fence",
  );
}
