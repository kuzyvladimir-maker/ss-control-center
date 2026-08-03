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
import { promoteDraftToChannelSkus } from "@/lib/bundle-factory/validation/promote-draft";
import { runValidationForDraft } from "@/lib/bundle-factory/validation/validation-pipeline";
import { withSqliteBusyRetry } from "@/lib/bundle-factory/sqlite-busy-retry";
import { prisma } from "@/lib/prisma";

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

    // Walmart drafts arrive straight from the Product Truth draft engine with
    // no MasterBundle, so publishing them used to be impossible from the UI.
    // Promote on demand: this mints the SKU and RESERVES a pool UPC for 24h
    // (a reservation, not a burn), which is what validation and publishing
    // both read.
    const draftRow = await prisma.bundleDraft.findUnique({
      where: { id },
      select: { master_bundle_id: true },
    });
    if (!draftRow) return badRequest("Draft not found");
    // Always promote: the call is idempotent (it skips channels that already
    // have a SKU). Keying off master_bundle_id alone was wrong — a draft can
    // hold a MasterBundle from an earlier attempt whose content had not yet
    // passed compliance, so no ChannelSKU was ever minted and publishing had
    // nothing to act on.
    // Local database work only — never the marketplace POST. A locked
    // database is a write that did not happen, so it is retried; an unknown
    // POST is never repeated.
    const promotion = await withSqliteBusyRetry(
      "publish:promote",
      () => promoteDraftToChannelSkus(id),
    );
    {
      if (!promotion.master_bundle_id) {
        return NextResponse.json({
          ok: false,
          stage: "PROMOTE",
          error: "This draft could not be promoted into a publishable SKU.",
          skipped: promotion.skipped,
        }, { status: 409 });
      }
    }

    // Promotion re-syncs the generated content onto the SKU and therefore
    // RESETS its validation to PENDING — the content it just copied has not
    // been checked in that form. Approval, one line below, requires the draft
    // to be VALIDATED. So pressing Publish destroyed its own precondition and
    // failed every time with "Draft must be VALIDATED before approval
    // (current=GENERATED)". Re-validating here closes the loop and makes the
    // guarantee stronger than it was: what gets published is exactly what
    // just passed, never a validation from an earlier version of the content.
    const validation = await withSqliteBusyRetry(
      "publish:validate",
      () => runValidationForDraft({
        bundle_draft_id: id,
        ...(channels ? { channels } : {}),
        actor,
      }),
    );
    const unvalidated = validation.per_sku.filter(
      (entry) => entry.status !== "PASSED",
    );
    if (apply && unvalidated.length > 0) {
      return NextResponse.json({
        ok: false,
        stage: "VALIDATE",
        error: unvalidated.length === validation.per_sku.length
          ? "Validation did not pass, so nothing was published."
          : `${unvalidated.length} of ${validation.per_sku.length} listings did not pass validation; nothing was published.`,
        failures: unvalidated.map((entry) => ({
          channel: entry.channel,
          status: entry.status,
          failed: entry.failed,
        })),
        promotion,
      }, { status: 422 });
    }

    if (apply) {
      if (body.approvalConfirmed !== true) {
        return badRequest(
          "Real publish requires approvalConfirmed=true from the operator confirmation dialog.",
        );
      }
      await withSqliteBusyRetry(
        "publish:approve",
        () => approveDraftForDistribution({
          draftId: id,
          actor,
          note: typeof body.approvalNote === "string" ? body.approvalNote : undefined,
        }),
      );
    }

    const result = await runDistribution({
      bundle_draft_id: id,
      channels,
      apply,
      batchSize,
      actor,
    });
    return NextResponse.json({ ...result, promotion, validation });
  },
);
