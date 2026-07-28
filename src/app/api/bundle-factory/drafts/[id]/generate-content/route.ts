/**
 * POST /api/bundle-factory/drafts/[id]/generate-content
 *      Body (optional): { channels?: string[] }
 *
 * Stage 4 — generates per-channel content via Claude Sonnet 4.5 with
 * prompt-cached marketplace-rules KB, runs the Compliance Gate against
 * each channel with autoFix:true (disclaimer auto-injection), retries
 * BLOCKED outputs up to 3 times with failed-rule feedback, then either
 * marks the row CAN_PUBLISH or BLOCKED + manual_review_required.
 *
 * When EVERY channel passes compliance, the parent BundleDraft flips
 * to status=GENERATED. Otherwise the draft stays at VARIATION_SELECTED
 * and the operator handles the manual-review queue.
 *
 * Costs roll up only on the "template owner" row (5 Amazon channels
 * share one Claude call; their sibling rows carry generation_cost_cents=0).
 *
 * Vercel: maxDuration=300 because a worst-case run is 2 templates ×
 * 3 retries × ~10s/Claude-call + compliance gate per channel.
 */

import { NextResponse } from "next/server";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { runContentGeneration } from "@/lib/bundle-factory/content-pipeline";
import { SALES_CHANNELS, isOneOf } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  channels?: unknown;
  actor?: unknown;
}

export const POST = withErrorHandler(
  "drafts[id]/generate-content[POST]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const body = (await readJson<Body>(request)) ?? {};

    let channels: string[] | undefined;
    if (body.channels !== undefined) {
      if (!Array.isArray(body.channels) || body.channels.length === 0) {
        return badRequest("channels must be a non-empty array if supplied");
      }
      for (const ch of body.channels) {
        if (typeof ch !== "string" || !isOneOf(SALES_CHANNELS, ch)) {
          return badRequest(`Invalid channel: ${String(ch)}`);
        }
      }
      channels = body.channels as string[];
    }

    const actor =
      typeof body.actor === "string" && body.actor.trim().length > 0
        ? body.actor.trim()
        : "user";

    const result = await runContentGeneration({
      bundle_draft_id: id,
      channels,
      actor,
    });

    return NextResponse.json(result);
  },
);
