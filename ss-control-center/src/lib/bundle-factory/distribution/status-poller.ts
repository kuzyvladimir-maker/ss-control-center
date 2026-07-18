/**
 * Phase 2.5 Stage 7 — submission status poller.
 *
 * For each SUBMITTED ChannelSKU, query the marketplace for terminal
 * state and persist the result. Idempotent — re-running on a LIVE row
 * just refreshes last_status_check_at.
 *
 *   Amazon: GET /listings/2021-08-01/items/{sellerId}/{sku}?issueLocale=…
 *     Look for items[].status + items[].issues
 *   Walmart: GET /v3/feeds/{feedId}
 *     Look for response.feedStatus + response.itemDetails
 *
 * The orchestrator + the cron-friendly poll-pending endpoint both call
 * pollSubmissionStatus(); only callers differ.
 */

import { prisma } from "@/lib/prisma";
import type { ChannelSKU } from "@/generated/prisma/client";

import { spApiGet, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getWalmartClient } from "@/lib/walmart/client";

import { channelTarget } from "./account-map";

export type PollTerminalStatus =
  | "LIVE"
  | "FAILED"
  | "PENDING_REVIEW"
  | "SUBMITTED"; // still in-progress

export interface PollResult {
  channel_sku_id: string;
  new_listing_status: PollTerminalStatus;
  issues: Array<{ code?: string; message?: string; severity?: string }>;
  live_url?: string | null;
  asin?: string | null;
  raw?: unknown;
}

async function pollAmazon(sku: ChannelSKU): Promise<PollResult> {
  const target = channelTarget(sku.channel);
  let sellerId: string;
  try {
    sellerId = await getMerchantToken(target.storeIndex);
  } catch (e) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      issues: [
        {
          code: "seller_id_resolution",
          message: e instanceof Error ? e.message : String(e),
          severity: "ERROR",
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
      new_listing_status: "FAILED",
      issues: [
        {
          code: "amazon_get_failed",
          message: e instanceof Error ? e.message : String(e),
          severity: "ERROR",
        },
      ],
    };
  }

  const issues = (raw.issues ?? []).filter(
    (i) => i.severity === "ERROR" || i.severity === "WARNING",
  );
  // Amazon's new-listing REVIEW HOLD (code 100521 / "we are reviewing this
  // listing … allow up to 48 hours … otherwise the listing will be published")
  // is reported with severity=ERROR + a CATALOG_ITEM_REMOVED enforcement, but it
  // is NOT a rejection — it's a transient moderation gate that auto-clears and
  // publishes. An ASIN is already assigned and the item shows DISCOVERABLE. So
  // it must NOT mark the SKU FAILED (which would abort the publish flow); it maps
  // to PENDING_REVIEW. Only NON-review ERROR issues are real failures.
  const isReviewHold = (i: { code?: string; message?: string }): boolean => {
    if (String(i.code ?? "").trim() === "100521") return true;
    const m = (i.message ?? "").toLowerCase();
    return (
      /reviewing this listing/.test(m) ||
      /allow up to \d+\s*hours/.test(m) ||
      /the listing will be published/.test(m)
    );
  };
  const errors = issues.filter((i) => i.severity === "ERROR");
  const hardErrors = errors.filter((i) => !isReviewHold(i));
  const reviewHeld = errors.some(isReviewHold);
  const summary =
    raw.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ??
    raw.summaries?.[0];
  const asin = summary?.asin ?? null;
  const statusList = summary?.status ?? [];

  // Only a genuine (non-review) ERROR is a real failure.
  if (hardErrors.length > 0) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      issues,
      asin,
      raw,
    };
  }
  // Under Amazon's review hold → PENDING_REVIEW (in catalog, not yet buyable);
  // surface the ASIN + URL so the operator can watch it clear.
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
  const liveSignals = ["BUYABLE", "DISCOVERABLE"];
  if (asin && statusList.some((s) => liveSignals.includes(s))) {
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

async function pollWalmart(sku: ChannelSKU): Promise<PollResult> {
  if (!sku.submission_id) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      issues: [{ message: "Walmart submission has no feedId on the SKU." }],
    };
  }
  const target = channelTarget(sku.channel);
  let client;
  try {
    client = getWalmartClient(target.storeIndex);
  } catch (e) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      issues: [
        {
          message: `Walmart client init: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }

  let raw: {
    feedStatus?: string;
    itemsReceived?: number;
    itemsSucceeded?: number;
    itemsFailed?: number;
    itemDetails?: {
      itemDetails?: Array<{
        sku?: string;
        ingestionStatus?: string;
        martId?: string;
        ingestionErrors?: { ingestionError?: Array<{ code?: string; description?: string }> };
      }>;
    };
  };
  try {
    raw = (await client.request(
      "GET",
      `/feeds/${encodeURIComponent(sku.submission_id)}`,
      { params: { includeDetails: "true" } },
    )) as never;
  } catch (e) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      issues: [
        {
          message: `Walmart feed GET failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }

  const feedStatus = raw.feedStatus ?? "";
  const items = raw.itemDetails?.itemDetails ?? [];
  const ours = items.find((it) => it.sku === sku.sku) ?? items[0];

  // Translate Walmart feed terminal states.
  if (feedStatus !== "PROCESSED" && feedStatus !== "ERROR" && feedStatus !== "PROCESSED_WITH_ERRORS") {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "SUBMITTED",
      issues: [],
      raw,
    };
  }
  const errors =
    ours?.ingestionErrors?.ingestionError?.map((e) => ({
      code: e.code,
      message: e.description,
      severity: "ERROR",
    })) ?? [];
  if (errors.length > 0 || feedStatus === "ERROR") {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      issues: errors,
      raw,
    };
  }
  if (ours?.ingestionStatus === "SUCCESS" && ours.martId) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "LIVE",
      issues: [],
      live_url: `https://www.walmart.com/ip/${ours.martId}`,
      raw,
    };
  }
  return {
    channel_sku_id: sku.id,
    new_listing_status: "PENDING_REVIEW",
    issues: errors,
    raw,
  };
}

export async function pollSubmissionStatus(
  sku: ChannelSKU,
): Promise<PollResult> {
  const target = channelTarget(sku.channel);
  if (target.kind === "amazon") return pollAmazon(sku);
  if (target.kind === "walmart") return pollWalmart(sku);
  return {
    channel_sku_id: sku.id,
    new_listing_status: "PENDING_REVIEW",
    issues: [{ message: `${target.kind} polling not implemented yet.` }],
  };
}

export async function persistPollResult(result: PollResult): Promise<void> {
  const sku = await prisma.channelSKU.findUniqueOrThrow({
    where: { id: result.channel_sku_id },
    select: {
      id: true,
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
        : result.new_listing_status === "PENDING_REVIEW"
          ? "PROCESSING"
          : "SUBMITTED";

  await prisma.$transaction(async (tx) => {
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
        last_error_at:
          result.new_listing_status === "FAILED" ? now : undefined,
        live_url: result.live_url ?? undefined,
        asin: result.asin ?? undefined,
      },
    });

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
          }),
          user_id: "status-poller",
        },
      });
    }

    if (result.new_listing_status !== "LIVE") return;

    // Preserve the original publication timestamp on later refresh polls.
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
          trigger: "At least one marketplace listing confirmed LIVE",
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
          trigger: "Marketplace poll confirmed first LIVE ChannelSKU",
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
