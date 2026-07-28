/**
 * POST /api/bundle-factory/drafts/[id]/validate
 *      Body (optional): { channels?: string[]; actor?: string }
 *
 * Phase 2.4 Stage 6 — runs the 15-validator pipeline for every
 * CAN_PUBLISH ChannelSKU on the draft's MasterBundle.
 *
 * Lazy promotion: if the draft has no MasterBundle / ChannelSKU rows
 * yet, we first promote it from its CAN_PUBLISH+with-image
 * GeneratedContent rows (creates a MasterBundle, allocates one UPC
 * per channel from UPCPool, creates ChannelSKU rows). Then validate.
 *
 * Vercel: maxDuration=120 — even with 9 channels × ~1 s/validator the
 * worst case finishes in seconds; the cap is mostly defensive for
 * slow Anthropic + Veeqo round trips.
 */

import { NextResponse } from "next/server";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { runValidationForDraft } from "@/lib/bundle-factory/validation/validation-pipeline";
import { promoteDraftToChannelSkus } from "@/lib/bundle-factory/validation/promote-draft";
import { SALES_CHANNELS, isOneOf } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  channels?: unknown;
  actor?: unknown;
}

export const POST = withErrorHandler(
  "drafts[id]/validate[POST]",
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

    const promote = await promoteDraftToChannelSkus(id);
    const result = await runValidationForDraft({
      bundle_draft_id: id,
      channels,
      actor,
    });
    return NextResponse.json({ promote, validation: result });
  },
);
