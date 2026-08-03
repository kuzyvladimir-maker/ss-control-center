/**
 * POST /api/bundle-factory/drafts/[id]/publish
 *      Query: ?dryRun=true|false  (default true — safety!)
 *             ?channelFilter=AMAZON_SALUTEM (single channel scope)
 *      Body (optional): { channels?: string[]; actor?: string }
 *
 * Publish one draft. DRY RUN BY DEFAULT — a real submission requires an
 * explicit ?dryRun=false plus the operator's confirmation from the dialog.
 *
 * The sequence itself lives in publishOneDraft, shared with the server-side
 * publish queue, so a batch and a single press cannot drift apart. Anything
 * that must hold before a marketplace write belongs there, not here.
 *
 * Vercel maxDuration=300 — promote, validate, approve and one feed POST.
 */

import { NextResponse } from "next/server";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { SALES_CHANNELS, isOneOf } from "@/lib/bundle-factory/enums";
import { publishOneDraft } from "@/lib/bundle-factory/publish-one-draft";

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

    if (apply && body.approvalConfirmed !== true) {
      return badRequest(
        "Real publish requires approvalConfirmed=true from the operator confirmation dialog.",
      );
    }

    const outcome = await publishOneDraft({
      draftId: id,
      ...(channels ? { channels } : {}),
      actor,
      apply,
      ...(typeof body.approvalNote === "string"
        ? { approvalNote: body.approvalNote }
        : {}),
    });

    if (outcome.stage === "PROMOTE") {
      return NextResponse.json({
        ok: false,
        stage: "PROMOTE",
        error: outcome.error,
        skipped: outcome.skipped,
      }, { status: 409 });
    }
    if (outcome.stage === "VALIDATE") {
      return NextResponse.json({
        ok: false,
        stage: "VALIDATE",
        error: outcome.error,
        failures: outcome.failures,
        promotion: outcome.promotion,
      }, { status: 422 });
    }

    return NextResponse.json({
      ...outcome.distribution,
      promotion: outcome.promotion,
      validation: outcome.validation,
    });
  },
);
