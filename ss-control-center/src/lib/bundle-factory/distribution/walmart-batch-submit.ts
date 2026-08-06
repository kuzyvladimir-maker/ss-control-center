/**
 * One POST, many listings — with every per-listing fence still standing.
 *
 * The single path (`distribution-pipeline.ts`) is untouched and stays the
 * default. This is the volume path, and it changes exactly one thing: the
 * transport. Every listing still gets its own payload, its own live-spec
 * validation, its own verified product ID, its own one-shot claim, and its own
 * re-asserted approval immediately before the request. What they now share is
 * the feed they travel in.
 *
 * WHY, precisely: Walmart's documented baseline is ~10 feeds an hour and the
 * factory's target is ~10 listings an hour, so one feed per listing spends the
 * whole allowance on the smallest useful batch.
 *
 * WHAT IT COSTS: an unknown POST outcome now leaves N listings unknown instead
 * of one. That is the reason for everything below — the batch is small, nothing
 * is ever re-POSTed, and an unknown outcome is resolved only by reading the
 * feed. The read side already resolves each listing separately: the poller
 * finds its own row in `itemIngestionStatus` by exact seller SKU, so twenty
 * listings sharing a feed ID each get their own result and their own errors.
 */

import { prisma } from "@/lib/prisma";

import { channelTarget } from "./account-map";
import {
  buildWalmartBatchFeed,
  WalmartBatchFeedError,
  WALMART_BATCH_FEED_MAX_ITEMS,
} from "./walmart-batch-feed";
import {
  acceptWalmartSubmission,
  claimWalmartSubmission,
  markWalmartSubmissionRequesting,
  recordWalmartSynchronousFailure,
} from "./walmart-publish-lifecycle";
import { hashWalmartPayload } from "./walmart-payload-hash";
import { submitToWalmart } from "./walmart-publish";
import { getWalmartClient } from "@/lib/walmart/client";
import { isWalmartStudioLane } from "../walmart-studio-listing";
import {
  assertValidWalmartDistributionApproval,
  parseWalmartListingAttributes,
  sha256WalmartJson,
} from "../walmart-listing-contract";
import {
  assertCurrentWalmartDistributionApproval,
  walmartSellerAccountFingerprint,
} from "./distribution-pipeline";
import { ensureFreeWalmartUpc } from "../walmart-upc-availability";
import { buildWalmartSkuTemplateMapBatch } from "../walmart-shipping-template-association";

export interface WalmartBatchSkipped {
  channelSkuId: string;
  sku: string;
  reason: string;
}

export interface WalmartBatchSubmitResult {
  /** SUBMITTED: the feed is in. UNKNOWN: it may be — read, never resend. */
  outcome: "SUBMITTED" | "NOTHING_TO_SEND" | "UNKNOWN";
  feedId: string | null;
  shippingFeedId: string | null;
  /** Seller SKUs that travelled in the feed. */
  submitted: string[];
  skipped: WalmartBatchSkipped[];
  error: string | null;
}

interface PreparedItem {
  channelSkuId: string;
  sku: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  attemptId: string;
  claimToken: string;
  authorizationSha256: string;
  approval: { publishable: string; payload: string };
  shipping: { templateId: string; fulfillmentCenterId: string };
}

/**
 * Send up to `WALMART_BATCH_FEED_MAX_ITEMS` listings in one MP_ITEM feed.
 *
 * A listing that cannot be prepared is skipped with a reason and the rest go
 * without it — one bad listing must not cost the batch. Once the POST is
 * attempted, every claimed listing shares its fate, because that is what a feed
 * is.
 */
export async function submitWalmartBatch(input: {
  channelSkuIds: string[];
  storeIndex?: number;
}): Promise<WalmartBatchSubmitResult> {
  const skipped: WalmartBatchSkipped[] = [];
  const prepared: PreparedItem[] = [];

  if (input.channelSkuIds.length > WALMART_BATCH_FEED_MAX_ITEMS) {
    throw new WalmartBatchFeedError(
      `A Walmart batch carries at most ${WALMART_BATCH_FEED_MAX_ITEMS} listings; `
      + `got ${input.channelSkuIds.length}.`,
    );
  }

  for (const channelSkuId of input.channelSkuIds) {
    try {
      prepared.push(await prepareOne(channelSkuId, input.storeIndex));
    } catch (error) {
      const row = await prisma.channelSKU.findUnique({
        where: { id: channelSkuId },
        select: { sku: true },
      });
      skipped.push({
        channelSkuId,
        sku: row?.sku ?? channelSkuId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (prepared.length === 0) {
    return {
      outcome: "NOTHING_TO_SEND",
      feedId: null,
      shippingFeedId: null,
      submitted: [],
      skipped,
      error: null,
    };
  }

  const feed = buildWalmartBatchFeed(
    prepared.map((item) => ({ sku: item.sku, payload: item.payload })),
  );
  const templateFeed = buildWalmartSkuTemplateMapBatch(
    prepared.map((item) => ({
      sku: item.sku,
      shipping_template_id: item.shipping.templateId,
      fulfillment_center_id: item.shipping.fulfillmentCenterId,
    })),
  );

  // Last fence before the network: re-read every approval, so one revoked or
  // re-sealed between preparation and now stops the whole feed rather than
  // travelling inside it.
  try {
    for (const item of prepared) {
      await assertCurrentWalmartDistributionApproval(
        item.channelSkuId,
        item.approval.publishable,
        item.approval.payload,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await releaseAll(prepared, message, null);
    return {
      outcome: "NOTHING_TO_SEND",
      feedId: null,
      shippingFeedId: null,
      submitted: [],
      skipped: [
        ...skipped,
        ...prepared.map((item) => ({
          channelSkuId: item.channelSkuId,
          sku: item.sku,
          reason: message,
        })),
      ],
      error: message,
    };
  }

  // Mark every attempt as requesting BEFORE the POST, so an outcome we never
  // learn is already recorded as one that may have happened. If this fails
  // partway, nothing has been sent yet and the whole batch stands down — a
  // listing left marked "requesting" with no feed behind it would be unknown
  // forever, which is the most expensive state there is.
  try {
    for (const item of prepared) {
      await markWalmartSubmissionRequesting({
        attemptId: item.attemptId,
        claimToken: item.claimToken,
        channelSkuId: item.channelSkuId,
        payloadHash: item.payloadHash,
        pilotPermitSha256: item.authorizationSha256,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await releaseAll(prepared, message, null);
    return {
      outcome: "NOTHING_TO_SEND",
      feedId: null,
      shippingFeedId: null,
      submitted: [],
      skipped: [
        ...skipped,
        ...prepared.map((item) => ({
          channelSkuId: item.channelSkuId,
          sku: item.sku,
          reason: message,
        })),
      ],
      error: message,
    };
  }

  const client = getWalmartClient(input.storeIndex ?? 1);
  let feedId: string | null = null;
  let postError: string | null = null;
  try {
    const response = await client.requestRaw("POST", "/feeds", {
      params: { feedType: "MP_ITEM" },
      file: {
        filename: feed.filename,
        contentType: feed.contentType,
        content: feed.content,
      },
    });
    const body = response.body && typeof response.body === "object"
      ? (response.body as { feedId?: string })
      : null;
    feedId = body?.feedId ?? null;
    if (!response.ok || !feedId) {
      postError = `Walmart MP_ITEM batch feed returned HTTP ${response.status} without a feedId`;
    }
  } catch (error) {
    // The request left and we do not know what happened to it. This is the one
    // case that must never become a second POST.
    postError = error instanceof Error ? error.message : String(error);
  }

  if (!feedId) {
    await releaseAll(prepared, postError ?? "Walmart batch feed POST failed", null);
    return {
      outcome: "UNKNOWN",
      feedId: null,
      shippingFeedId: null,
      submitted: [],
      skipped,
      error: postError,
    };
  }

  // The item feed is in. The template feed is a separate write, and failing it
  // does not un-submit the items — so its failure is reported, never retried,
  // and the listings stay bound to the feed that carries them.
  let shippingFeedId: string | null = null;
  let shippingError: string | null = null;
  try {
    const response = await client.requestRaw("POST", "/feeds", {
      params: { feedType: templateFeed.params.feedType },
      file: templateFeed.file,
    });
    const body = response.body && typeof response.body === "object"
      ? (response.body as { feedId?: string })
      : null;
    shippingFeedId = body?.feedId ?? null;
    if (!response.ok || !shippingFeedId) {
      shippingError =
        `Walmart SKU_TEMPLATE_MAP batch feed returned HTTP ${response.status} without a feedId`;
    }
  } catch (error) {
    shippingError = error instanceof Error ? error.message : String(error);
  }

  for (const item of prepared) {
    await acceptWalmartSubmission({
      channelSkuId: item.channelSkuId,
      attemptId: item.attemptId,
      claimToken: item.claimToken,
      feedId,
      marketplaceStatus: "SUBMITTED",
    });
  }

  return {
    outcome: "SUBMITTED",
    feedId,
    shippingFeedId,
    submitted: feed.skus,
    skipped,
    error: shippingError,
  };
}

/**
 * Everything one listing needs before it may enter a feed.
 *
 * Throws rather than returning a partial item: a listing that cannot be fully
 * prepared is skipped, and skipping is cheap. The order matters — the product
 * ID is verified BEFORE the payload is built, because verification can replace
 * it, and a payload built around a retired number would be sent with it.
 */
async function prepareOne(
  channelSkuId: string,
  storeIndex?: number,
): Promise<PreparedItem> {
  await ensureFreeWalmartUpc({ channelSkuId, ...(storeIndex ? { storeIndex } : {}) });

  const sku = await prisma.channelSKU.findUniqueOrThrow({
    where: { id: channelSkuId },
  });
  if (sku.channel !== "WALMART") {
    throw new Error(`${sku.sku} is not a Walmart listing`);
  }
  if (!isWalmartStudioLane(sku.attributes)) {
    // The frozen pilot lane authorizes each POST with an owner-signed permit
    // bound to one submission. Batching would break that binding, and it is
    // not what the pilot is for.
    throw new Error(`${sku.sku} is not on the studio lane; batching is studio-only`);
  }

  const target = channelTarget(sku.channel);
  const resolvedStore = storeIndex ?? target.storeIndex ?? 1;
  const masterBundle = await prisma.masterBundle.findUnique({
    where: { id: sku.master_bundle_id },
    select: { brand: true, pack_count: true, packaging_spec: true },
  });

  // Build the payload through the same function the single path uses, in dry
  // run, so the batch cannot drift from the proven construction or skip the
  // live-spec validation.
  const built = await submitToWalmart({
    sku,
    storeIndex: resolvedStore,
    ...(masterBundle?.brand ? { brand: masterBundle.brand } : {}),
    ...(masterBundle?.pack_count ? { packCount: masterBundle.pack_count } : {}),
    dryRun: true,
    validateLiveSpec: true,
  });
  if (!built.ok) {
    throw new Error(built.error ?? `${sku.sku} did not build a valid payload`);
  }

  const shipping = sealedShipping(sku.sku, sku.attributes);
  const approval = assertValidWalmartDistributionApproval(sku);
  const authorizationSha256 = sha256WalmartJson(
    parseWalmartListingAttributes(sku.attributes).distribution_approval,
  );

  const claim = await claimWalmartSubmission({
    channelSkuId: sku.id,
    payload: built.payload,
    authorization: {
      basis: "STUDIO_SEALED_APPROVAL",
      approvalSha256: authorizationSha256,
      sellerAccountFingerprintSha256: walmartSellerAccountFingerprint(resolvedStore),
    },
  });
  if (!claim.claimed || !claim.attempt_id || !claim.claim_token) {
    throw new Error(claim.reason ?? `${sku.sku} did not acquire a submission claim`);
  }

  return {
    channelSkuId: sku.id,
    sku: sku.sku,
    payload: built.payload,
    payloadHash: hashWalmartPayload(built.payload),
    attemptId: claim.attempt_id,
    claimToken: claim.claim_token,
    authorizationSha256,
    approval: {
      publishable: approval.publishable_content_sha256,
      payload: approval.marketplace_payload_sha256,
    },
    shipping,
  };
}

/** The template and ship node this listing was priced against, from its own seal. */
function sealedShipping(
  sku: string,
  attributes: string | null,
): { templateId: string; fulfillmentCenterId: string } {
  const offer = (() => {
    try {
      const parsed = JSON.parse(attributes ?? "{}") as Record<string, unknown>;
      const listing = parsed.walmart_studio_listing as
        | { offer?: { shipping_template_id?: unknown; fulfillment_center_id?: unknown } }
        | undefined;
      return listing?.offer ?? null;
    } catch {
      return null;
    }
  })();
  const templateId = typeof offer?.shipping_template_id === "string"
    ? offer.shipping_template_id.trim()
    : "";
  const fulfillmentCenterId = typeof offer?.fulfillment_center_id === "string"
    ? offer.fulfillment_center_id.trim()
    : "";
  if (!templateId || !fulfillmentCenterId) {
    throw new Error(
      `${sku} has no sealed shipping template or ship node; re-run its build so `
      + "the template it was priced against is recorded.",
    );
  }
  return { templateId, fulfillmentCenterId };
}

/** Close out claims that never reached a POST, so no fence is left held. */
async function releaseAll(
  prepared: PreparedItem[],
  error: string,
  feedId: string | null,
): Promise<void> {
  for (const item of prepared) {
    await recordWalmartSynchronousFailure({
      channelSkuId: item.channelSkuId,
      attemptId: item.attemptId,
      claimToken: item.claimToken,
      ...(feedId ? { feedId } : {}),
      error,
    });
  }
}
