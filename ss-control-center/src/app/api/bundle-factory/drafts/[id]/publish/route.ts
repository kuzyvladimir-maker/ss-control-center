/**
 * POST /api/bundle-factory/drafts/[id]/publish
 *      Query: ?dryRun=true|false  (default true — safety!)
 *             ?batchSize=N        (default 5)
 *             ?channelFilter=AMAZON_SALUTEM (single channel scope)
 *      Body (optional): { channels?: string[]; actor?: string }
 *
 * Phase 2.5 Stage 7 — bulk publish every PASSED ChannelSKU on the
 * draft's MasterBundle. DRY RUN BY DEFAULT — real submission requires
 * explicit ?dryRun=false (or the UI's confirmation-modal checkbox path).
 *
 * Vercel maxDuration=300 — even with 7 channels × VALIDATION_PREVIEW +
 * PUT (each ~1-3 s) + rate-limit sleep we stay under a few minutes;
 * the cap is defensive for Walmart back-pressure.
 */

import { NextResponse } from "next/server";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { runDistribution } from "@/lib/bundle-factory/distribution/distribution-pipeline";
import { SALES_CHANNELS, isOneOf } from "@/lib/bundle-factory/enums";
import { approveDraftForDistribution } from "@/lib/bundle-factory/approval";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  channels?: unknown;
  actor?: unknown;
  approvalConfirmed?: unknown;
  approvalNote?: unknown;
}

export const POST = withErrorHandler(
  "drafts[id]/publish[POST]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const body = (await readJson<Body>(request)) ?? {};
    const url = new URL(request.url);

    const dryRunParam = url.searchParams.get("dryRun");
    // SAFETY: anything other than literal "false" is treated as dry-run.
    const apply = dryRunParam === "false";

    const batchSizeParam = url.searchParams.get("batchSize");
    const batchSize = batchSizeParam ? Math.max(1, Number(batchSizeParam)) : 5;
    if (!Number.isFinite(batchSize)) {
      return badRequest("batchSize must be a positive integer");
    }

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
      const cf = url.searchParams.get("channelFilter");
      if (cf) {
        if (!isOneOf(SALES_CHANNELS, cf)) {
          return badRequest(`Invalid channelFilter: ${cf}`);
        }
        channels = [cf];
      }
    }

    const actor =
      typeof body.actor === "string" && body.actor.trim().length > 0
        ? body.actor.trim()
        : "user";

    if (apply) {
      if (body.approvalConfirmed !== true) {
        return badRequest(
          "Real publish requires approvalConfirmed=true from the operator confirmation dialog.",
        );
      }
      await approveDraftForDistribution({
        draftId: id,
        actor,
        note: typeof body.approvalNote === "string" ? body.approvalNote : undefined,
      });
    }

    const result = await runDistribution({
      bundle_draft_id: id,
      channels,
      apply,
      batchSize,
      actor,
    });
    return NextResponse.json(result);
  },
);
