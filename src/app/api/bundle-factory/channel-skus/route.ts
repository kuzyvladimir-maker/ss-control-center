/**
 * GET  /api/bundle-factory/channel-skus
 *      ?channel=AMAZON_SALUTEM|WALMART|... (filter)
 *      ?status=DRAFT|LIVE|...               (filter)
 *      ?master_bundle_id=...
 *      ?limit=100 (default 100, max 500)
 *
 * POST /api/bundle-factory/channel-skus
 *      Body: ChannelSKU create payload. Required: master_bundle_id, channel,
 *      sku, upc, title, bullets, description, attributes, price_cents.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import {
  LIFECYCLE_STATES,
  SALES_CHANNELS,
  isOneOf,
} from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "channel-skus",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const channel = searchParams.get("channel");
    const status = searchParams.get("status");
    const masterBundleId = searchParams.get("master_bundle_id");
    const limit = Math.min(500, Math.max(1, intParam(searchParams, "limit", 100)));

    if (channel && !isOneOf(SALES_CHANNELS, channel)) {
      return badRequest(`Invalid channel. Allowed: ${SALES_CHANNELS.join(", ")}`);
    }
    if (status && !isOneOf(LIFECYCLE_STATES, status)) {
      return badRequest(`Invalid status. Allowed: ${LIFECYCLE_STATES.join(", ")}`);
    }

    const where: Record<string, unknown> = {};
    if (channel) where.channel = channel;
    if (status) where.lifecycle_status = status;
    if (masterBundleId) where.master_bundle_id = masterBundleId;

    const skus = await prisma.channelSKU.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
    });
    return NextResponse.json({ channel_skus: skus, total: skus.length });
  }
);

type CreatePayload = {
  master_bundle_id: string;
  channel: string;
  brand_account_id?: string;
  sku: string;
  upc: string;
  upc_pool_id?: string;
  title: string;
  bullets: unknown;
  description: string;
  search_terms?: string;
  attributes: unknown;
  channel_category?: string;
  channel_browse_node?: string;
  price_cents: number;
  business_price_cents?: number;
  lifecycle_status?: string;
};

export const POST = withErrorHandler(
  "channel-skus[POST]",
  async (request: Request) => {
    const body = await readJson<CreatePayload>(request);
    if (!body) return badRequest("Body must be JSON");

    const required = [
      "master_bundle_id",
      "channel",
      "sku",
      "upc",
      "title",
      "bullets",
      "description",
      "attributes",
      "price_cents",
    ] as const;
    for (const k of required) {
      if (body[k] === undefined || body[k] === null) {
        return badRequest(`Missing required field: ${k}`);
      }
    }
    if (!isOneOf(SALES_CHANNELS, body.channel)) {
      return badRequest(`Invalid channel: ${body.channel}`);
    }
    if (
      body.lifecycle_status &&
      !isOneOf(LIFECYCLE_STATES, body.lifecycle_status)
    ) {
      return badRequest(`Invalid lifecycle_status: ${body.lifecycle_status}`);
    }

    const created = await prisma.channelSKU.create({
      data: {
        master_bundle_id: body.master_bundle_id,
        channel: body.channel,
        brand_account_id: body.brand_account_id,
        sku: body.sku,
        upc: body.upc,
        upc_pool_id: body.upc_pool_id,
        title: body.title,
        bullets: JSON.stringify(body.bullets),
        description: body.description,
        search_terms: body.search_terms,
        attributes: JSON.stringify(body.attributes),
        channel_category: body.channel_category,
        channel_browse_node: body.channel_browse_node,
        price_cents: body.price_cents,
        business_price_cents: body.business_price_cents,
        lifecycle_status: body.lifecycle_status ?? "DRAFT",
      },
    });

    // Audit-log the initial state.
    await prisma.listingLifecycleLog.create({
      data: {
        entity_type: "ChannelSKU",
        entity_id: created.id,
        channel_sku_id: created.id,
        master_bundle_id: created.master_bundle_id,
        from_status: null,
        to_status: created.lifecycle_status,
        trigger: "api_create",
      },
    });

    return NextResponse.json({ channel_sku: created }, { status: 201 });
  }
);
