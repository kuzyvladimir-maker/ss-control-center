/**
 * POST /api/bundle-factory/drafts/[id]/generate-images
 *      Body (optional): { channels?: string[]; actor?: string }
 *
 * Phase 2.3 Stage 5 — kicks off the image-pipeline.
 * Only rows where compliance_status='CAN_PUBLISH' AND main_image_url IS
 * NULL get processed. If `channels` is supplied, restricts further;
 * BLOCKED rows are silently skipped (this endpoint never generates
 * images for content that hasn't cleared the text gate).
 *
 * Each row: 1-3 OpenAI gpt-image-1 calls (initial + up to 2 retries on
 * Rule 6 BLOCKED) → R2 upload → Compliance Gate with Rule 6 firing.
 *
 * Vercel: maxDuration=300 (≈9 channels × up to 3 attempts × ~10 s).
 */

import { NextResponse } from "next/server";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { runImageGeneration } from "@/lib/bundle-factory/image-pipeline";
import { SALES_CHANNELS, isOneOf } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  channels?: unknown;
  actor?: unknown;
}

export const POST = withErrorHandler(
  "drafts[id]/generate-images[POST]",
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

    const result = await runImageGeneration({
      bundle_draft_id: id,
      channels,
      actor,
    });

    return NextResponse.json(result);
  },
);
