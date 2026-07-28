/**
 * POST /api/bundle-factory/drafts/[id]/regenerate-image
 *      Body: { channel: string; actor?: string }
 *
 * Single-channel image retry. Forces a fresh attempt even if the row
 * already has main_image_url set (the existing-URL idempotency check in
 * the pipeline is bypassed via `force: true`).
 *
 * Resets the per-row retry counter: the pipeline's MAX_IMAGE_RETRIES
 * budget applies to THIS call as a fresh 3-attempt run, separate from
 * the original generate-images attempts.
 *
 * Use cases:
 *   - Vision still flagged a logo and the manual reviewer wants Claude
 *     to try again with the latest detected_logos as negatives.
 *   - The hosted OpenAI URL upload failed and the row is stuck with a
 *     dead preliminary URL.
 *   - Brand vocabulary changed and we want to nudge gpt-image-1 to
 *     re-roll a single SKU.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
  channel?: unknown;
  actor?: unknown;
}

export const POST = withErrorHandler(
  "drafts[id]/regenerate-image[POST]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const body = (await readJson<Body>(request)) ?? {};

    if (typeof body.channel !== "string" || !isOneOf(SALES_CHANNELS, body.channel)) {
      return badRequest("channel must be one of the configured SALES_CHANNELS");
    }
    const channel = body.channel;

    // Reset the per-row retry counter so the fresh 3-attempt budget
    // applies cleanly. We intentionally keep image_generation_cost_cents
    // accumulating — the dollars don't un-spend even if the URL did.
    await prisma.generatedContent.updateMany({
      where: { bundle_draft_id: id, channel },
      data: { image_retry_count: 0, image_generated_at: null },
    });

    const actor =
      typeof body.actor === "string" && body.actor.trim().length > 0
        ? body.actor.trim()
        : "user";

    const result = await runImageGeneration({
      bundle_draft_id: id,
      channels: [channel],
      force: true,
      actor,
    });

    return NextResponse.json(result);
  },
);
