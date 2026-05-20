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
  const errors = issues.filter((i) => i.severity === "ERROR");
  const summary =
    raw.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ??
    raw.summaries?.[0];
  const asin = summary?.asin ?? null;
  const statusList = summary?.status ?? [];

  // Heuristic: any ERROR issue → FAILED. Otherwise if Amazon assigned
  // an ASIN AND status includes BUYABLE/DISCOVERABLE → LIVE. Else
  // still in-progress.
  if (errors.length > 0) {
    return {
      channel_sku_id: sku.id,
      new_listing_status: "FAILED",
      issues,
      asin,
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
  await prisma.channelSKU.update({
    where: { id: result.channel_sku_id },
    data: {
      listing_status: result.new_listing_status,
      distribution_errors: result.issues.length
        ? JSON.stringify(result.issues)
        : null,
      last_status_check_at: new Date(),
      published_at:
        result.new_listing_status === "LIVE" ? new Date() : undefined,
      live_url: result.live_url ?? undefined,
      asin: result.asin ?? undefined,
    },
  });
}
