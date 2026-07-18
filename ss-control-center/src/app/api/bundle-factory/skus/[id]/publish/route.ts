/**
 * POST /api/bundle-factory/skus/[id]/publish
 *      Query: ?dryRun=true|false  (default true — safety!)
 *      Body (optional): { actor?: string; amazonProductType?: string }
 *
 * Phase 2.5 Stage 7 — single-SKU publish. Used by the UI Re-publish
 * button. Loads the parent draft, calls runDistribution scoped to this
 * one channel. Idempotent — re-running on a LIVE SKU is a no-op.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { runDistribution } from "@/lib/bundle-factory/distribution/distribution-pipeline";
import { approveDraftForDistribution } from "@/lib/bundle-factory/approval";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  actor?: unknown;
  amazonProductType?: unknown;
  approvalConfirmed?: unknown;
  approvalNote?: unknown;
}

export const POST = withErrorHandler(
  "skus[id]/publish[POST]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const body = (await readJson<Body>(request)) ?? {};
    const url = new URL(request.url);
    const apply = url.searchParams.get("dryRun") === "false";

    const sku = await prisma.channelSKU.findUnique({ where: { id } });
    if (!sku) {
      return NextResponse.json({ error: "ChannelSKU not found" }, { status: 404 });
    }
    // Find the draft via master_bundle_id → BundleDraft.
    const draft = await prisma.bundleDraft.findFirst({
      where: { master_bundle_id: sku.master_bundle_id },
      select: { id: true },
    });
    if (!draft) {
      return NextResponse.json(
        { error: "Parent BundleDraft not found for this ChannelSKU." },
        { status: 404 },
      );
    }

    const actor =
      typeof body.actor === "string" && body.actor.trim().length > 0
        ? body.actor.trim()
        : "user";
    const amazonProductType =
      typeof body.amazonProductType === "string"
        ? body.amazonProductType
        : undefined;

    if (apply) {
      if (body.approvalConfirmed !== true) {
        return badRequest(
          "Real re-publish requires approvalConfirmed=true from an explicit operator confirmation.",
        );
      }
      await approveDraftForDistribution({
        draftId: draft.id,
        actor,
        note:
          typeof body.approvalNote === "string"
            ? body.approvalNote
            : "Single-SKU re-publish confirmed",
      });
    }

    const result = await runDistribution({
      bundle_draft_id: draft.id,
      channels: [sku.channel],
      apply,
      amazonProductType,
      republish: true,
      actor,
    });
    return NextResponse.json(result);
  },
);
