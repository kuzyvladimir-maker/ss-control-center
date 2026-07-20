/**
 * Marketplace submission status poller.
 *
 * Walmart is deliberately two-stage: a processed feed only proves ingestion.
 * LIVE additionally requires exact seller-SKU PUBLISHED+ACTIVE state and an
 * immutable buyer-facing PDP observation that is published and buyable.
 */

import { prisma } from "@/lib/prisma";
import type { ChannelSKU } from "@/generated/prisma/client";

import { spApiGet, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getWalmartClient } from "@/lib/walmart/client";

import { channelTarget } from "./account-map";
import {
  findQualifyingWalmartBuyerEvidence,
  findQualifyingWalmartBuyerEvidenceForAttempt,
  walmartBuyerEvidenceNotBefore,
} from "./walmart-buyer-publication-evidence";
import {
  assertWalmartCertifiedSubmissionAttemptBinding,
  assertWalmartPublishLifecycleSchema,
  classifyWalmartMarketplaceIssues,
  getActiveWalmartSubmissionAttempt,
  WALMART_UNKNOWN_RECOVERY_GRACE_MS,
  walmartUnknownAbsenceRecovery,
  walmartDispositionQuarantinesUpc,
  walmartRecoveryDelayMs,
  type WalmartCertifiedSubmissionAttemptBinding,
  type WalmartMarketplaceDisposition,
  type WalmartSubmissionAttemptIdentity,
} from "./walmart-publish-lifecycle";

export type PollTerminalStatus =
  | "LIVE"
  | "FAILED"
  | "PENDING_REVIEW"
  | "SUBMITTED"
  | "SUBMISSION_UNKNOWN"
  | "RETRYABLE";

export interface PollResult {
  channel_sku_id: string;
  new_listing_status: PollTerminalStatus;
  issues: Array<{ code?: string; message?: string; severity?: string }>;
  live_url?: string | null;
  asin?: string | null;
  walmart_item_id?: string | null;
  submission_attempt_id?: string | null;
  buyer_evidence_id?: string | null;
  buyer_evidence_hash?: string | null;
  marketplace_disposition?: WalmartMarketplaceDisposition;
  retryable?: boolean;
  raw?: unknown;
}

function currentInProgressStatus(sku: ChannelSKU): PollTerminalStatus {
  if (sku.listing_status === "PENDING_REVIEW") return "PENDING_REVIEW";
  if (
    sku.listing_status === "SUBMISSION_UNKNOWN" ||
    sku.listing_status === "SUBMITTING"
  ) {
    return "SUBMISSION_UNKNOWN";
  }
  return "SUBMITTED";
}

async function pollAmazon(sku: ChannelSKU): Promise<PollResult> {
  const target = channelTarget(sku.channel);
  let sellerId: string;
  try {
    sellerId = await getMerchantToken(target.storeIndex);
  } catch (e) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: currentInProgressStatus(sku),
      retryable: true,
      issues: [
        {
          code: "seller_id_resolution",
          message: e instanceof Error ? e.message : String(e),
          severity: "WARNING",
        },
      ],
    };
  }

  let raw: {
    summaries?: Array<{ asin?: string; status?: string[]; marketplaceId?: string }>;
    issues?: Array<{ code?: string; message?: string; severity?: string }>;
  };
  try {
    raw = await spApiGet(
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku.sku)}`,
      {
        storeId: `store${target.storeIndex}`,
        params: {
          marketplaceIds: MARKETPLACE_ID,
          includedData: "summaries,issues",
        },
      },
    );
  } catch (e) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: currentInProgressStatus(sku),
      retryable: true,
      issues: [
        {
          code: "amazon_get_transient",
          message: e instanceof Error ? e.message : String(e),
          severity: "WARNING",
        },
      ],
    };
  }

  const issues = (raw.issues ?? []).filter(
    (issue) => issue.severity === "ERROR" || issue.severity === "WARNING",
  );
  const isReviewHold = (issue: { code?: string; message?: string }): boolean => {
    if (String(issue.code ?? "").trim() === "100521") return true;
    const message = (issue.message ?? "").toLowerCase();
    return (
      /reviewing this listing/.test(message) ||
      /allow up to \d+\s*hours/.test(message) ||
      /the listing will be published/.test(message)
    );
  };
  const errors = issues.filter((issue) => issue.severity === "ERROR");
  const hardErrors = errors.filter((issue) => !isReviewHold(issue));
  const reviewHeld = errors.some(isReviewHold);
  const summary =
    raw.summaries?.find((item) => item.marketplaceId === MARKETPLACE_ID) ??
    raw.summaries?.[0];
  const asin = summary?.asin ?? null;
  const statusList = summary?.status ?? [];

  if (hardErrors.length > 0) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      issues,
      asin,
      raw,
    };
  }
  if (reviewHeld) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "PENDING_REVIEW",
      issues,
      asin,
      live_url: asin ? `https://www.amazon.com/dp/${asin}` : undefined,
      raw,
    };
  }
  if (asin && statusList.some((status) => ["BUYABLE", "DISCOVERABLE"].includes(status))) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "LIVE",
      issues,
      asin,
      live_url: `https://www.amazon.com/dp/${asin}`,
      raw,
    };
  }
  if (issues.length > 0) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "PENDING_REVIEW",
      issues,
      asin,
      raw,
    };
  }
  return {
    channel_sku_id: sku.id,
    new_listing_status: "SUBMITTED",
    issues: [],
    asin,
    raw,
  };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function exactWalmartSellerRows(payload: unknown, sku: string): JsonObject[] {
  if (!isObject(payload)) return [];
  const candidates = [payload.ItemResponse, payload.itemResponse, payload.items];
  let rows: JsonObject[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      rows = candidate.filter(isObject);
      break;
    }
    if (isObject(candidate)) {
      rows = [candidate];
      break;
    }
  }
  if (rows.length === 0 && (text(payload.sku) || text(payload.Sku))) rows = [payload];
  return rows.filter((row) => (text(row.sku) ?? text(row.Sku)) === sku);
}

export function exactNumericWalmartItemId(row: JsonObject): string | null {
  const mart = isObject(row.mart) ? row.mart : null;
  const candidate = text(mart?.itemId) ?? text(row.itemId) ?? text(row.item_id);
  return candidate && /^\d+$/.test(candidate) ? candidate : null;
}

function walmartSellerState(row: JsonObject): {
  publishedStatus: string;
  lifecycleStatus: string;
} {
  return {
    publishedStatus: (text(row.publishedStatus) ?? "").toUpperCase(),
    lifecycleStatus: (text(row.lifecycleStatus) ?? "").toUpperCase(),
  };
}

export function evaluateWalmartBuyerLiveGate(input: {
  sellerPublishedStatus: string;
  sellerLifecycleStatus: string;
  numericItemId: string | null;
  buyerEvidence: {
    published: boolean;
    buyable: boolean;
    exact_sku_match: boolean;
    exact_item_id_match: boolean;
  } | null;
}): { live: boolean; reason: string } {
  if (
    input.sellerPublishedStatus.toUpperCase() !== "PUBLISHED" ||
    input.sellerLifecycleStatus.toUpperCase() !== "ACTIVE"
  ) {
    return { live: false, reason: "SELLER_ITEM_NOT_PUBLISHED_ACTIVE" };
  }
  if (!input.numericItemId || !/^\d+$/.test(input.numericItemId)) {
    return { live: false, reason: "NUMERIC_BUYER_ITEM_ID_MISSING" };
  }
  if (
    !input.buyerEvidence ||
    !input.buyerEvidence.published ||
    !input.buyerEvidence.buyable ||
    !input.buyerEvidence.exact_sku_match ||
    !input.buyerEvidence.exact_item_id_match
  ) {
    return { live: false, reason: "BUYER_PUBLISHED_BUYABLE_EVIDENCE_PENDING" };
  }
  return { live: true, reason: "BUYER_VERIFIED" };
}

export function exactWalmartFeedItem(
  items: Array<{
    sku?: string;
    ingestionStatus?: string;
    martId?: string;
    ingestionErrors?: {
      ingestionError?: Array<{ code?: string; description?: string }>;
    };
  }>,
  sku: string,
) {
  const exact = items.filter((item) => item.sku === sku);
  return exact.length === 1 ? exact[0] : null;
}

async function qualifyingBuyerEvidence(input: {
  sku: ChannelSKU;
  attempt: {
    id: string;
    accepted_at: Date | null;
    requested_at: Date | null;
    claimed_at: Date;
  };
  walmartItemId: string;
}) {
  return findQualifyingWalmartBuyerEvidence({
    channelSkuId: input.sku.id,
    submissionAttemptId: input.attempt.id,
    sku: input.sku.sku,
    walmartItemId: input.walmartItemId,
    notBefore:
      input.attempt.accepted_at ??
      input.attempt.requested_at ??
      input.attempt.claimed_at,
  });
}

async function verifyWalmartSellerAndBuyer(input: {
  sku: ChannelSKU;
  client: ReturnType<typeof getWalmartClient>;
  attempt: {
    id: string;
    accepted_at: Date | null;
    requested_at: Date | null;
    claimed_at: Date;
  };
  expectedItemId?: string | null;
  feedRaw?: unknown;
}): Promise<PollResult> {
  let sellerRaw: unknown;
  try {
    sellerRaw = await input.client.request("GET", "/items", {
      params: { sku: input.sku.sku },
    });
  } catch (error) {
    return {
      channel_sku_id: input.sku.id,
      new_listing_status: currentInProgressStatus(input.sku),
      submission_attempt_id: input.attempt.id,
      retryable: true,
      marketplace_disposition: "POLL_TRANSIENT",
      issues: [
        {
          code: "WALMART_EXACT_SKU_GET_TRANSIENT",
          message: error instanceof Error ? error.message : String(error),
          severity: "WARNING",
        },
      ],
      raw: { feed: input.feedRaw, seller: null },
    };
  }
  const exactRows = exactWalmartSellerRows(sellerRaw, input.sku.sku);
  if (exactRows.length !== 1) {
    return {
      channel_sku_id: input.sku.id,
      new_listing_status: "PENDING_REVIEW",
      submission_attempt_id: input.attempt.id,
      marketplace_disposition: "BUYER_VERIFICATION_PENDING",
      issues: [
        {
          code: "WALMART_EXACT_SELLER_SKU_UNRESOLVED",
          message: `Expected one exact seller row for ${input.sku.sku}; found ${exactRows.length}.`,
          severity: "WARNING",
        },
      ],
      raw: { feed: input.feedRaw, seller: sellerRaw },
    };
  }
  const seller = exactRows[0]!;
  const state = walmartSellerState(seller);
  const sellerItemId = exactNumericWalmartItemId(seller);
  let itemId = input.expectedItemId ?? sellerItemId;
  let evidence: Awaited<
    ReturnType<typeof findQualifyingWalmartBuyerEvidence>
  > = null;
  if (
    state.publishedStatus !== "PUBLISHED" ||
    state.lifecycleStatus !== "ACTIVE"
  ) {
    return {
      channel_sku_id: input.sku.id,
      new_listing_status: "PENDING_REVIEW",
      submission_attempt_id: input.attempt.id,
      walmart_item_id: itemId,
      marketplace_disposition: "BUYER_VERIFICATION_PENDING",
      issues: [
        {
          code: "WALMART_SELLER_ITEM_NOT_PUBLISHED_ACTIVE",
          message: `Seller state is ${state.publishedStatus || "UNKNOWN"}/${state.lifecycleStatus || "UNKNOWN"}.`,
          severity: "WARNING",
        },
      ],
      raw: { feed: input.feedRaw, seller: sellerRaw },
    };
  }
  if (!itemId) {
    evidence = await findQualifyingWalmartBuyerEvidenceForAttempt({
      channelSkuId: input.sku.id,
      submissionAttemptId: input.attempt.id,
      sku: input.sku.sku,
      notBefore:
        input.attempt.accepted_at ??
        input.attempt.requested_at ??
        input.attempt.claimed_at,
    });
    itemId = evidence?.walmart_item_id ?? null;
  }
  if (!itemId || !/^\d+$/.test(itemId)) {
    return {
      channel_sku_id: input.sku.id,
      new_listing_status: "PENDING_REVIEW",
      submission_attempt_id: input.attempt.id,
      marketplace_disposition: "BUYER_VERIFICATION_PENDING",
      issues: [
        {
          code: "WALMART_NUMERIC_BUYER_ITEM_ID_MISSING",
          message:
            "Published seller row and exact buyer evidence provide no numeric buyer item ID.",
          severity: "WARNING",
        },
      ],
      raw: { feed: input.feedRaw, seller: sellerRaw },
    };
  }
  if (sellerItemId && input.expectedItemId && sellerItemId !== input.expectedItemId) {
    return {
      channel_sku_id: input.sku.id,
      new_listing_status: "PENDING_REVIEW",
      submission_attempt_id: input.attempt.id,
      marketplace_disposition: "BUYER_VERIFICATION_PENDING",
      issues: [
        {
          code: "WALMART_ITEM_ID_MISMATCH",
          message: `Feed itemId ${input.expectedItemId} != exact seller itemId ${sellerItemId}.`,
          severity: "ERROR",
        },
      ],
      raw: { feed: input.feedRaw, seller: sellerRaw },
    };
  }
  evidence ??= await qualifyingBuyerEvidence({
    sku: input.sku,
    attempt: input.attempt,
    walmartItemId: itemId,
  });
  const liveGate = evaluateWalmartBuyerLiveGate({
    sellerPublishedStatus: state.publishedStatus,
    sellerLifecycleStatus: state.lifecycleStatus,
    numericItemId: itemId,
    buyerEvidence: evidence,
  });
  if (!liveGate.live || !evidence) {
    return {
      channel_sku_id: input.sku.id,
      new_listing_status: "PENDING_REVIEW",
      submission_attempt_id: input.attempt.id,
      walmart_item_id: itemId,
      live_url: `https://www.walmart.com/ip/${itemId}`,
      marketplace_disposition: "BUYER_VERIFICATION_PENDING",
      issues: [
        {
          code: "WALMART_BUYER_PUBLISHED_BUYABLE_EVIDENCE_PENDING",
          message:
            "Feed and seller catalog are ready; exact buyer-facing published+buyable evidence is still required.",
          severity: "WARNING",
        },
      ],
      raw: { feed: input.feedRaw, seller: sellerRaw },
    };
  }
  return {
    channel_sku_id: input.sku.id,
    new_listing_status: "LIVE",
    submission_attempt_id: input.attempt.id,
    walmart_item_id: itemId,
    live_url: `https://www.walmart.com/ip/${itemId}`,
    buyer_evidence_id: evidence.id,
    buyer_evidence_hash: evidence.evidence_hash,
    marketplace_disposition: "BUYER_VERIFIED",
    issues: [],
    raw: { feed: input.feedRaw, seller: sellerRaw },
  };
}

async function pollWalmart(
  sku: ChannelSKU,
  expectedAttempt?: WalmartCertifiedSubmissionAttemptBinding,
): Promise<PollResult> {
  await assertWalmartPublishLifecycleSchema();
  const activeAttempt = await getActiveWalmartSubmissionAttempt(sku.id);
  const attempt =
    activeAttempt ??
    (sku.submission_id
      ? await prisma.marketplaceSubmissionAttempt.findFirst({
          where: {
            channel_sku_id: sku.id,
            marketplace: "WALMART",
            marketplace_submission_id: sku.submission_id,
          },
          orderBy: { created_at: "desc" },
        })
      : null);
  if (!attempt) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "PENDING_REVIEW",
      marketplace_disposition: "BUYER_VERIFICATION_PENDING",
      issues: [
        {
          code: "WALMART_DURABLE_ATTEMPT_MISSING",
          message: "Walmart status cannot advance without a durable submission attempt.",
          severity: "ERROR",
        },
      ],
    };
  }
  if (expectedAttempt) {
    assertWalmartCertifiedSubmissionAttemptBinding({
      expected: expectedAttempt,
      attempt,
    });
    if (
      attempt.active_key !== sku.id ||
      !["REQUESTING", "ACCEPTED", "UNKNOWN", "PENDING_REVIEW"].includes(
        attempt.state,
      )
    ) {
      throw new Error(
        "Certified Walmart attempt is not the active pollable attempt",
      );
    }
  }

  const target = channelTarget(sku.channel);
  let client: ReturnType<typeof getWalmartClient>;
  try {
    client = getWalmartClient(target.storeIndex);
  } catch (error) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: currentInProgressStatus(sku),
      submission_attempt_id: attempt.id,
      retryable: true,
      marketplace_disposition: "POLL_TRANSIENT",
      issues: [
        {
          code: "WALMART_CLIENT_INIT_TRANSIENT",
          message: error instanceof Error ? error.message : String(error),
          severity: "WARNING",
        },
      ],
    };
  }

  // Crash/timeout recovery when the POST may have happened but no feedId was
  // persisted. Read the exact seller SKU; never resubmit from this branch.
  if (!sku.submission_id) {
    const recovered = await verifyWalmartSellerAndBuyer({
      sku,
      client,
      attempt,
    });
    if (
      recovered.new_listing_status === "PENDING_REVIEW" &&
      recovered.issues[0]?.code === "WALMART_EXACT_SELLER_SKU_UNRESOLVED" &&
      Date.now() - attempt.claimed_at.getTime() >=
        WALMART_UNKNOWN_RECOVERY_GRACE_MS &&
      (!attempt.retry_after || attempt.retry_after.getTime() <= Date.now())
    ) {
      const recovery = walmartUnknownAbsenceRecovery({
        claimedAt: attempt.claimed_at,
        now: new Date(),
      });
      return {
        ...recovered,
        new_listing_status: "SUBMISSION_UNKNOWN",
        marketplace_disposition: recovery.disposition,
        retryable: false,
        issues: [
          {
            code: "WALMART_UNKNOWN_SUBMISSION_MANUAL_RECONCILIATION_REQUIRED",
            message:
              "No exact seller SKU appeared during the recovery grace period, but absence does not prove the first POST was rejected. The active fence remains and manual reconciliation is required; no new POST is authorized.",
            severity: "WARNING",
          },
        ],
      };
    }
    if (recovered.new_listing_status === "SUBMITTED") {
      recovered.new_listing_status = "SUBMISSION_UNKNOWN";
    }
    return recovered;
  }

  let raw: {
    feedStatus?: string;
    itemDetails?: {
      itemDetails?: Array<{
        sku?: string;
        ingestionStatus?: string;
        martId?: string;
        ingestionErrors?: {
          ingestionError?: Array<{ code?: string; description?: string }>;
        };
      }>;
    };
  };
  try {
    raw = (await client.request(
      "GET",
      `/feeds/${encodeURIComponent(sku.submission_id)}`,
      { params: { includeDetails: "true" } },
    )) as typeof raw;
  } catch (error) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: currentInProgressStatus(sku),
      submission_attempt_id: attempt.id,
      retryable: true,
      marketplace_disposition: "POLL_TRANSIENT",
      issues: [
        {
          code: "WALMART_FEED_GET_TRANSIENT",
          message: error instanceof Error ? error.message : String(error),
          severity: "WARNING",
        },
      ],
    };
  }

  const feedStatus = (raw.feedStatus ?? "").toUpperCase();
  if (!["PROCESSED", "ERROR", "PROCESSED_WITH_ERRORS"].includes(feedStatus)) {
    return {
      channel_sku_id: sku.id,
      new_listing_status:
        sku.listing_status === "PENDING_REVIEW" ? "PENDING_REVIEW" : "SUBMITTED",
      submission_attempt_id: attempt.id,
      marketplace_disposition: "FEED_PROCESSING",
      issues: [],
      raw,
    };
  }
  const item = exactWalmartFeedItem(
    raw.itemDetails?.itemDetails ?? [],
    sku.sku,
  );
  if (!item) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "PENDING_REVIEW",
      submission_attempt_id: attempt.id,
      marketplace_disposition: "BUYER_VERIFICATION_PENDING",
      issues: [
        {
          code: "WALMART_FEED_EXACT_SKU_RESULT_MISSING",
          message: `Terminal feed has no unique exact result for SKU ${sku.sku}.`,
          severity: "ERROR",
        },
      ],
      raw,
    };
  }
  const errors =
    item.ingestionErrors?.ingestionError?.map((error) => ({
      code: error.code,
      message: error.description,
      severity: "ERROR",
    })) ?? [];
  if (errors.length > 0 || feedStatus === "ERROR") {
    const fallbackErrors =
      errors.length > 0
        ? errors
        : [
            {
              code: "WALMART_FEED_ERROR",
              message: "Walmart feed reached ERROR without item-level details.",
              severity: "ERROR",
            },
          ];
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      submission_attempt_id: attempt.id,
      marketplace_disposition: classifyWalmartMarketplaceIssues(fallbackErrors),
      issues: fallbackErrors,
      raw,
    };
  }
  if (
    String(item.ingestionStatus ?? "").toUpperCase() === "SUCCESS" &&
    item.martId
  ) {
    return verifyWalmartSellerAndBuyer({
      sku,
      client,
      attempt,
      expectedItemId: String(item.martId),
      feedRaw: raw,
    });
  }
  return {
    channel_sku_id: sku.id,
    new_listing_status: "PENDING_REVIEW",
    submission_attempt_id: attempt.id,
    marketplace_disposition: "BUYER_VERIFICATION_PENDING",
    issues: [
      {
        code: "WALMART_FEED_TERMINAL_NOT_SUCCESS",
        message: `Exact feed item status is ${item.ingestionStatus ?? "UNKNOWN"}.`,
        severity: "WARNING",
      },
    ],
    raw,
  };
}

export async function pollSubmissionStatus(
  sku: ChannelSKU,
  expectedAttempt?: WalmartCertifiedSubmissionAttemptBinding,
): Promise<PollResult> {
  const target = channelTarget(sku.channel);
  if (target.kind === "amazon") return pollAmazon(sku);
  if (target.kind === "walmart") return pollWalmart(sku, expectedAttempt);
  return {
    channel_sku_id: sku.id,
    new_listing_status: "PENDING_REVIEW",
    issues: [{ message: `${target.kind} polling not implemented yet.` }],
  };
}

export function assertWalmartPollPersistenceFence(input: {
  expected: WalmartCertifiedSubmissionAttemptBinding;
  resultAttemptId: string | null | undefined;
  boundAttempt: (WalmartSubmissionAttemptIdentity & {
    active_key: string | null;
    state: string;
  }) | null;
  activeAttemptId: string | null;
}): void {
  assertWalmartCertifiedSubmissionAttemptBinding({
    expected: input.expected,
    attempt: input.boundAttempt,
  });
  const attempt = input.boundAttempt;
  if (
    !attempt ||
    input.resultAttemptId !== input.expected.attemptId ||
    attempt.active_key !== input.expected.channelSkuId ||
    input.activeAttemptId !== input.expected.attemptId ||
    !["REQUESTING", "ACCEPTED", "UNKNOWN", "PENDING_REVIEW"].includes(
      attempt.state,
    )
  ) {
    throw new Error(
      "Walmart poll persistence lost the exact active certified attempt",
    );
  }
}

export async function persistPollResult(
  result: PollResult,
  expectedAttempt?: WalmartCertifiedSubmissionAttemptBinding,
): Promise<void> {
  const sku = await prisma.channelSKU.findUniqueOrThrow({
    where: { id: result.channel_sku_id },
    select: {
      id: true,
      channel: true,
      sku: true,
      upc_pool_id: true,
      master_bundle_id: true,
      listing_status: true,
      lifecycle_status: true,
      published_at: true,
    },
  });
  const now = new Date();
  const lifecycleStatus =
    result.new_listing_status === "LIVE"
      ? "LIVE"
      : result.new_listing_status === "FAILED"
        ? "ERROR"
        : result.new_listing_status === "SUBMITTED"
          ? "SUBMITTED"
          : "PROCESSING";

  await prisma.$transaction(async (tx) => {
    if (sku.channel === "WALMART" && expectedAttempt) {
      const [boundAttempt, activeAttempt] = await Promise.all([
        tx.marketplaceSubmissionAttempt.findUnique({
          where: { id: expectedAttempt.attemptId },
        }),
        tx.marketplaceSubmissionAttempt.findUnique({
          where: { active_key: sku.id },
        }),
      ]);
      assertWalmartPollPersistenceFence({
        expected: expectedAttempt,
        resultAttemptId: result.submission_attempt_id,
        boundAttempt,
        activeAttemptId: activeAttempt?.id ?? null,
      });
    }
    let buyerEvidence: {
      id: string;
      evidence_hash: string;
      walmart_item_id: string;
      channel_sku_id: string;
      submission_attempt_id: string;
      sku: string;
      captured_at: Date;
      published: boolean;
      buyable: boolean;
      exact_sku_match: boolean;
      exact_item_id_match: boolean;
    } | null = null;
    if (sku.channel === "WALMART" && result.new_listing_status === "LIVE") {
      if (!result.buyer_evidence_id || !result.submission_attempt_id) {
        throw new Error("Walmart LIVE requires durable buyer evidence and attempt IDs");
      }
      const liveAttempt = await tx.marketplaceSubmissionAttempt.findUnique({
        where: { id: result.submission_attempt_id },
        select: {
          channel_sku_id: true,
          marketplace: true,
          claimed_at: true,
          requested_at: true,
          accepted_at: true,
        },
      });
      if (
        !liveAttempt ||
        liveAttempt.channel_sku_id !== sku.id ||
        liveAttempt.marketplace !== "WALMART"
      ) {
        throw new Error("Walmart LIVE attempt does not match the ChannelSKU");
      }
      const evidenceNotBefore = walmartBuyerEvidenceNotBefore(
        liveAttempt.accepted_at ??
          liveAttempt.requested_at ??
          liveAttempt.claimed_at,
        now,
      );
      buyerEvidence = await tx.walmartBuyerPublicationEvidence.findUnique({
        where: { id: result.buyer_evidence_id },
        select: {
          id: true,
          evidence_hash: true,
          walmart_item_id: true,
          channel_sku_id: true,
          submission_attempt_id: true,
          sku: true,
          captured_at: true,
          published: true,
          buyable: true,
          exact_sku_match: true,
          exact_item_id_match: true,
        },
      });
      if (
        !buyerEvidence ||
        buyerEvidence.channel_sku_id !== sku.id ||
        buyerEvidence.submission_attempt_id !== result.submission_attempt_id ||
        buyerEvidence.sku !== sku.sku ||
        buyerEvidence.walmart_item_id !== result.walmart_item_id ||
        buyerEvidence.evidence_hash !== result.buyer_evidence_hash ||
        buyerEvidence.captured_at < evidenceNotBefore ||
        buyerEvidence.captured_at > now ||
        !buyerEvidence.published ||
        !buyerEvidence.buyable ||
        !buyerEvidence.exact_sku_match ||
        !buyerEvidence.exact_item_id_match
      ) {
        throw new Error("Walmart buyer evidence does not satisfy the LIVE contract");
      }
    }

    await tx.channelSKU.update({
      where: { id: result.channel_sku_id },
      data: {
        listing_status: result.new_listing_status,
        lifecycle_status: lifecycleStatus,
        distribution_errors: result.issues.length
          ? JSON.stringify(result.issues)
          : null,
        errors:
          result.new_listing_status === "FAILED" && result.issues.length
            ? JSON.stringify(result.issues)
            : result.new_listing_status === "LIVE"
              ? null
              : undefined,
        last_status_check_at: now,
        last_error_at: result.new_listing_status === "FAILED" ? now : undefined,
        live_url: result.live_url ?? undefined,
        asin: result.asin ?? undefined,
        walmart_item_id: result.walmart_item_id ?? undefined,
      },
    });

    const attempt = result.submission_attempt_id
      ? await tx.marketplaceSubmissionAttempt.findUnique({
          where: { id: result.submission_attempt_id },
        })
      : null;
    if (attempt) {
      const attemptState =
        result.new_listing_status === "LIVE"
          ? "BUYER_VERIFIED"
          : result.new_listing_status === "FAILED"
            ? "REJECTED"
            : result.new_listing_status === "PENDING_REVIEW"
              ? "PENDING_REVIEW"
              : result.new_listing_status === "RETRYABLE"
                ? "RETRYABLE"
                : result.new_listing_status === "SUBMISSION_UNKNOWN"
                  ? "UNKNOWN"
                  : "ACCEPTED";
      const terminal = ["BUYER_VERIFIED", "REJECTED", "RETRYABLE"].includes(
        attemptState,
      );
      const recoveryCount = attempt.recovery_count + (result.retryable ? 1 : 0);
      await tx.marketplaceSubmissionAttempt.update({
        where: { id: attempt.id },
        data: {
          state: attemptState,
          active_key: terminal ? null : sku.id,
          marketplace_disposition:
            result.marketplace_disposition ?? attempt.marketplace_disposition,
          error_json: result.issues.length ? JSON.stringify(result.issues) : null,
          recovery_count: recoveryCount,
          retry_after: result.retryable
            ? new Date(
                now.getTime() + walmartRecoveryDelayMs(attempt.recovery_count),
              )
            : null,
          terminal_at: terminal ? now : null,
        },
      });
    }

    if (
      sku.upc_pool_id &&
      walmartDispositionQuarantinesUpc(result.marketplace_disposition)
    ) {
      const pool = await tx.uPCPool.findUnique({
        where: { id: sku.upc_pool_id },
        select: { notes: true },
      });
      const note = `${new Date().toISOString()} ${result.marketplace_disposition}: Walmart rejected SKU ${sku.sku}`;
      await tx.uPCPool.update({
        where: { id: sku.upc_pool_id },
        data: {
          status: "QUARANTINED",
          notes: pool?.notes ? `${pool.notes}\n${note}` : note,
        },
      });
    }

    if (
      sku.lifecycle_status !== lifecycleStatus ||
      sku.listing_status !== result.new_listing_status
    ) {
      await tx.listingLifecycleLog.create({
        data: {
          entity_type: "ChannelSKU",
          entity_id: sku.id,
          channel_sku_id: sku.id,
          from_status: sku.lifecycle_status,
          to_status: lifecycleStatus,
          trigger: `Marketplace poll: ${result.new_listing_status}`,
          details: JSON.stringify({
            prior_listing_status: sku.listing_status,
            listing_status: result.new_listing_status,
            issues_count: result.issues.length,
            marketplace_disposition: result.marketplace_disposition ?? null,
            submission_attempt_id: result.submission_attempt_id ?? null,
            buyer_evidence_id: buyerEvidence?.id ?? null,
          }),
          user_id: "status-poller",
        },
      });
    }

    if (result.new_listing_status !== "LIVE") return;

    await tx.channelSKU.updateMany({
      where: { id: sku.id, published_at: null },
      data: { published_at: now },
    });
    await tx.channelSKU.updateMany({
      where: { id: sku.id, live_at: null },
      data: { live_at: now },
    });

    const master = await tx.masterBundle.findUniqueOrThrow({
      where: { id: sku.master_bundle_id },
      select: { lifecycle_status: true },
    });
    if (master.lifecycle_status !== "LIVE") {
      await tx.masterBundle.update({
        where: { id: sku.master_bundle_id },
        data: { lifecycle_status: "LIVE" },
      });
      await tx.listingLifecycleLog.create({
        data: {
          entity_type: "MasterBundle",
          entity_id: sku.master_bundle_id,
          master_bundle_id: sku.master_bundle_id,
          from_status: master.lifecycle_status,
          to_status: "LIVE",
          trigger: "At least one marketplace listing buyer-verified LIVE",
          user_id: "status-poller",
        },
      });
    }

    const draft = await tx.bundleDraft.findUnique({
      where: { master_bundle_id: sku.master_bundle_id },
      select: {
        id: true,
        status: true,
        published_at: true,
        generation_job_id: true,
      },
    });
    if (!draft) return;

    const firstPublication = await tx.bundleDraft.updateMany({
      where: { id: draft.id, published_at: null },
      data: { status: "PUBLISHED", published_at: now },
    });
    if (firstPublication.count > 0) {
      await tx.generationJob.update({
        where: { id: draft.generation_job_id },
        data: { bundles_published: { increment: 1 } },
      });
      await tx.listingLifecycleLog.create({
        data: {
          entity_type: "BundleDraft",
          entity_id: draft.id,
          from_status: draft.status,
          to_status: "PUBLISHED",
          trigger: "Marketplace poll confirmed first buyer-verified LIVE ChannelSKU",
          details: JSON.stringify({ channel_sku_id: sku.id }),
          user_id: "status-poller",
        },
      });
    } else if (draft.status !== "PUBLISHED") {
      await tx.bundleDraft.update({
        where: { id: draft.id },
        data: { status: "PUBLISHED" },
      });
    }
  });
}

/** Engine-facing read/reconcile entry point. It never writes to Walmart; the
 * only mutation is the guarded local lifecycle transition. */
export async function pollAndPersistWalmartSubmission(
  channelSkuId: string,
  expectedAttempt: WalmartCertifiedSubmissionAttemptBinding,
): Promise<PollResult> {
  const sku = await prisma.channelSKU.findUniqueOrThrow({
    where: { id: channelSkuId },
  });
  if (channelTarget(sku.channel).kind !== "walmart") {
    throw new Error(`ChannelSKU ${channelSkuId} is not a Walmart SKU`);
  }
  if (
    !["SUBMITTED", "PENDING_REVIEW", "SUBMITTING", "SUBMISSION_UNKNOWN"].includes(
      sku.listing_status,
    )
  ) {
    throw new Error(
      `Walmart SKU ${sku.sku} is not pollable from ${sku.listing_status}`,
    );
  }
  const polled = await pollSubmissionStatus(sku, expectedAttempt);
  if (
    polled.submission_attempt_id != null &&
    polled.submission_attempt_id !== expectedAttempt.attemptId
  ) {
    throw new Error("Walmart poll returned a foreign submission attempt");
  }
  const result = {
    ...polled,
    submission_attempt_id: expectedAttempt.attemptId,
  };
  await persistPollResult(result, expectedAttempt);
  return result;
}
