/**
 * POST /api/bundle-factory/drafts/[id]/regenerate-content
 *      Body: { channels?: string[] }   default = channels currently BLOCKED
 *
 * Re-runs Stage 4 ONLY for channels that need it — by default the rows
 * currently marked BLOCKED + manual_review_required. The retry budget
 * resets to a fresh 3 attempts per channel.
 *
 * Use this after manually editing the brief or curating the research
 * pool when the previous generate-content gave a partial fail.
 *
 * Costs the same as `generate-content` but only for the requested
 * subset.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
  "drafts[id]/regenerate-content[POST]",
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
    } else {
      // Default to currently-BLOCKED channels.
      const blockedRows = await prisma.generatedContent.findMany({
        where: { bundle_draft_id: id, compliance_status: "BLOCKED" },
        select: { channel: true },
      });
      channels = blockedRows.map((r) => r.channel);
      if (channels.length === 0) {
        return badRequest(
          "No channels currently BLOCKED — nothing to regenerate. Pass `channels` explicitly to force.",
        );
      }
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
