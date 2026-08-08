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
import { withSqliteBusyRetry } from "../sqlite-busy-retry";
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
  /** Pilot-only: a studio submission has no certification to bind. */
  certification_sha256: string | null;
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

/**
 * True when the write was refused because a row with that key already exists.
 *
 * Prisma reports this as P2002 — but only when it recognises the driver error.
 * Against Turso the libSQL adapter surfaces the raw SQLite failure instead
 * (`SQLITE_CONSTRAINT: UNIQUE constraint failed: ...`), which this used to miss.
 * The consequence was not a cosmetic one: the caller catches this exact
 * predicate in order to fall back to re-claiming the existing retryable
 * attempt, so an unrecognised collision skipped the whole recovery path and
 * surfaced as a raw 500 to the operator. Same shape as SQLITE_BUSY, which had
 * to learn the same lesson.
 */
function isUniqueConstraintError(error: unknown): boolean {
  if (!error) return false;
  if (
    typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "P2002"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message)) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return isUniqueConstraintError(cause);
  return false;
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

/**
 * Every write in this module is LOCAL database work: it either applies or it
 * does not, and Turso serialises writers, so a refusal means nothing happened.
 *
 * That distinction matters here more than anywhere else. These transactions
 * bracket the marketplace POST — they claim the one-shot fence, mark the
 * request, and record the outcome. When one of them lost a race with a cron
 * tick and was refused with SQLITE_BUSY, publishing died with "database is
 * locked" AND left the claim stranded in CLAIMED, so the SKU could not be
 * published again either. The fence outlived the request it was fencing.
 *
 * The POST itself is never retried through this or anything else: an unknown
 * marketplace outcome is resolved by reading (AGENTS.md §7).
 */
type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function busyTx<T>(
  label: string,
  run: (tx: PrismaTransaction) => Promise<T>,
): Promise<T> {
  return withSqliteBusyRetry(label, () => prisma.$transaction(run));
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

/**
 * What authorized a submission.
 *
 * The frozen pilot is authorized by an Ed25519 permit the owner signs OUTSIDE
 * the app, binding one SKU per signature. The studio lane is authorized by the
 * sealed distribution approval already on the SKU — operator, validation run,
 * publishable content hash, payload hash — which is re-asserted immediately
 * before the POST.
 *
 * What makes a submission one-shot is identical either way and is not part of
 * this choice: `idempotency_key` is unique per (SKU, payload) and `active_key`
 * is unique per SKU for as long as the attempt can still have marketplace
 * side effects.
 */
export type WalmartSubmissionAuthorization =
  | { basis: "OWNER_SIGNED_PERMIT"; permit: WalmartPilotSubmissionPermit }
  | {
      basis: "STUDIO_SEALED_APPROVAL";
      /** SHA-256 of the sealed distribution_approval carried by the SKU. */
      approvalSha256: string;
      /** Which seller account this submission goes to. */
      sellerAccountFingerprintSha256: string;
    };

export async function claimWalmartSubmission(input: {
  channelSkuId: string;
  payload: Record<string, unknown>;
  /** Pilot lane shorthand; equivalent to an OWNER_SIGNED_PERMIT authorization. */
  pilotPermit?: WalmartPilotSubmissionPermit;
  authorization?: WalmartSubmissionAuthorization;
  now?: Date;
  allowLiveRepublish?: boolean;
}): Promise<WalmartSubmissionClaim> {
  const authorization: WalmartSubmissionAuthorization | undefined =
    input.authorization
    ?? (input.pilotPermit
      ? { basis: "OWNER_SIGNED_PERMIT" as const, permit: input.pilotPermit }
      : undefined);
  if (!authorization) {
    throw new Error("Walmart submission claim requires an authorization");
  }
  const studioApproval = authorization.basis === "STUDIO_SEALED_APPROVAL"
    ? authorization
    : null;
  const permit = authorization.basis === "OWNER_SIGNED_PERMIT"
    ? authorization.permit
    : null;
  const now = input.now ?? new Date();
  const payloadHash = hashWalmartPayload(input.payload);
  const idempotencyKey = walmartSubmissionIdempotencyKey(
    input.channelSkuId,
    payloadHash,
  );
  const claimToken = randomUUID();
  const attemptId = randomUUID();
  if (studioApproval) {
    if (!/^[a-f0-9]{64}$/.test(studioApproval.approvalSha256)) {
      throw new Error(
        "Studio submission claim requires the sealed approval digest",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(studioApproval.sellerAccountFingerprintSha256)) {
      throw new Error(
        "Studio submission claim requires the seller account fingerprint",
      );
    }
  }
  const signedBody = permit?.signedPermit?.signed_body;
  if (
    permit && (
    !/^[a-f0-9]{64}$/.test(permit.permitSha256) ||
    !permit.permitId.trim() ||
    !permit.ownerKeyId.trim() ||
    !/^[a-f0-9]{64}$/.test(permit.ownerSignatureSha256) ||
    permit.signedPermit?.permit_sha256 !== permit.permitSha256 ||
    permit.signedPermit?.key_id !== permit.ownerKeyId ||
    permit.signedPermit?.signature_sha256 !== permit.ownerSignatureSha256 ||
    signedBody?.permit_id !== permit.permitId ||
    signedBody?.engine_release_sha256 !== permit.engineReleaseSha256 ||
    signedBody?.pilot_slot !== permit.pilotSlot ||
    signedBody?.approval_sha256 !== permit.approvalSha256 ||
    signedBody?.certification_sha256 !== permit.certificationSha256 ||
    signedBody?.channel_sku_id !== input.channelSkuId ||
    signedBody?.payload_sha256 !== payloadHash ||
    signedBody?.seller_account_fingerprint_sha256 !==
      permit.sellerAccountFingerprintSha256 ||
    ![1, 2].includes(permit.pilotSlot) ||
    !/^[a-f0-9]{64}$/.test(permit.approvalSha256) ||
    !/^[a-f0-9]{64}$/.test(permit.certificationSha256) ||
    !/^[a-f0-9]{64}$/.test(permit.sellerAccountFingerprintSha256))
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
    // A retryable attempt may only be re-claimed under the SAME authorization
    // it was created with. Anything else means a different decision is trying
    // to reuse an existing attempt row, which is exactly what must not happen.
    const boundToADifferentAuthorization = permit
      ? existing.pilot_permit_sha256 !== permit.permitSha256 ||
        existing.pilot_permit_id !== permit.permitId ||
        existing.owner_key_id !== permit.ownerKeyId ||
        existing.owner_signature_sha256 !== permit.ownerSignatureSha256 ||
        existing.pilot_slot !== permit.pilotSlot ||
        existing.pilot_approval_sha256 !== permit.approvalSha256 ||
        existing.certification_sha256 !== permit.certificationSha256 ||
        existing.seller_account_fingerprint_sha256 !==
          permit.sellerAccountFingerprintSha256
      // The studio lane re-seals its distribution approval on every publish
      // press — the seal carries its own timestamp, so its SHA-256 is different
      // every time even when operator, validation run, content and payload are
      // identical. Requiring the seal to be BYTE-IDENTICAL therefore made a
      // retry structurally impossible: the row could never be re-claimed, and
      // a new row could never be inserted either, because the idempotency key
      // is the same. That is the loop.
      //
      // What actually identifies a submission is the payload, and that is
      // exactly what the idempotency key and payload_hash record. Content drift
      // cannot slip through here: the pipeline refuses before the claim if the
      // prepared payload's hash differs from the CURRENT sealed approval, and
      // asserts the approval again immediately before the POST. So an attempt
      // carrying this payload hash is the same submission, whichever seal
      // authorised it, and the lane and seller account must still match.
      : existing.authorization_basis !== "STUDIO_SEALED_APPROVAL" ||
        existing.payload_hash !== payloadHash ||
        existing.seller_account_fingerprint_sha256 !==
          studioApproval!.sellerAccountFingerprintSha256;
    if (boundToADifferentAuthorization) {
      return {
        claimed: false,
        attempt_id: existing.id,
        claim_token: null,
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        prior_state: existing.state,
        reason: "same payload attempt is bound to another authorization",
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
      await busyTx("walmart:claim-retryable", async (tx) => {
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
    await busyTx("walmart:claim", async (tx) => {
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
          authorization_basis: authorization.basis,
          authorization_sha256: permit
            ? permit.permitSha256
            : studioApproval!.approvalSha256,
          // Pilot evidence exists only on the pilot lane; a studio row leaves
          // these NULL rather than inventing signature-shaped values.
          ...(permit
            ? {
                pilot_permit_sha256: permit.permitSha256,
                pilot_permit_id: permit.permitId,
                owner_key_id: permit.ownerKeyId,
                owner_signature_sha256: permit.ownerSignatureSha256,
                pilot_slot: permit.pilotSlot,
                pilot_approval_sha256: permit.approvalSha256,
                certification_sha256: permit.certificationSha256,
              }
            : {}),
          seller_account_fingerprint_sha256: permit
            ? permit.sellerAccountFingerprintSha256
            : studioApproval!.sellerAccountFingerprintSha256,
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
  /**
   * Digest of whatever authorized this POST — the signed permit on the pilot
   * lane, the sealed distribution approval on the studio lane. It is matched
   * against the row, so a POST cannot be marked under a different
   * authorization than the one the attempt was claimed with.
   */
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
      authorization_sha256: input.pilotPermitSha256,
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

/**
 * Mark EVERY attempt in a batch as requesting, in one transaction.
 *
 * A batched feed is one POST for many listings, so the marks must be one write:
 * marking them one by one meant a failure on the fifth left the first four at
 * `REQUESTING/1` with no POST behind them. The recovery classifier reads
 * `REQUESTING/1` as "the request may have left" and parks the listing as
 * UNKNOWN with its fence held — a POST that never happened, and the most
 * expensive state in the system, invented by a database error
 * (re-review 2026-08-08).
 *
 * All or nothing: if any row fails its guard, the transaction rolls back and
 * every attempt stays CLAIMED, which is the truth.
 */
export async function markWalmartSubmissionsRequesting(
  items: ReadonlyArray<{
    attemptId: string;
    claimToken: string;
    channelSkuId: string;
    payloadHash: string;
    pilotPermitSha256: string;
  }>,
  now: Date = new Date(),
): Promise<void> {
  if (items.length === 0) return;
  for (const item of items) {
    if (!item.attemptId.trim() || !item.claimToken.trim() || !item.channelSkuId.trim()) {
      throw new Error("Walmart feed POST claim identity is incomplete");
    }
    if (!/^[a-f0-9]{64}$/.test(item.payloadHash)
      || !/^[a-f0-9]{64}$/.test(item.pilotPermitSha256)) {
      throw new Error("Walmart feed POST claim hashes are invalid");
    }
  }
  await busyTx("walmart:mark-requesting-batch", async (tx) => {
    for (const item of items) {
      const result = await tx.marketplaceSubmissionAttempt.updateMany({
        where: {
          id: item.attemptId,
          claim_token: item.claimToken,
          channel_sku_id: item.channelSkuId,
          payload_hash: item.payloadHash,
          authorization_sha256: item.pilotPermitSha256,
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
  });
}

/**
 * Bind one accepted feed ID to EVERY attempt it carried, in one transaction.
 *
 * Accepting one at a time left the first listings ACCEPTED and the rest
 * REQUESTING with no feed ID recorded when a later write failed — and a
 * listing with no feed ID cannot be reconciled by reading, which is the only
 * recovery this lane allows.
 */
export async function acceptWalmartSubmissions(
  items: ReadonlyArray<{ channelSkuId: string; attemptId: string; claimToken: string }>,
  feedId: string,
  marketplaceStatus?: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (items.length === 0) return;
  await busyTx("walmart:accept-batch", async (tx) => {
    for (const item of items) {
      const attempt = await tx.marketplaceSubmissionAttempt.updateMany({
        where: {
          id: item.attemptId,
          channel_sku_id: item.channelSkuId,
          claim_token: item.claimToken,
          state: "REQUESTING",
        },
        data: {
          state: "ACCEPTED",
          marketplace_submission_id: feedId,
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
        where: { id: item.channelSkuId },
        data: {
          listing_status: "SUBMITTED",
          lifecycle_status: "SUBMITTED",
          submission_id: feedId,
          submitted_at: now,
          distribution_attempt_count: { increment: 1 },
          last_status_check_at: now,
          distribution_errors: null,
        },
      });
      await tx.listingLifecycleLog.create({
        data: {
          entity_type: "ChannelSKU",
          entity_id: item.channelSkuId,
          channel_sku_id: item.channelSkuId,
          from_status: "SUBMITTING",
          to_status: "SUBMITTED",
          trigger: "walmart_submission_accepted",
          details: JSON.stringify({
            attempt_id: item.attemptId,
            feed_id: feedId,
            marketplace_status: marketplaceStatus ?? null,
            batched: items.length > 1,
          }),
          user_id: "walmart-batch",
        },
      });
    }
  });
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
  await busyTx("walmart:accept", async (tx) => {
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
  return busyTx("walmart:record-failure", async (tx) => {
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
