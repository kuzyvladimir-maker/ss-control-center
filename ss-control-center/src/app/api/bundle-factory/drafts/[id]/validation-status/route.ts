/**
 * GET /api/bundle-factory/drafts/[id]/validation-status
 *
 * Returns current per-channel validation status without re-running
 * anything. Used by the DraftDetailClient to refresh badges + by
 * operators checking "did the last validate pass?".
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(
  "drafts[id]/validation-status",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const draft = await prisma.bundleDraft.findUnique({
      where: { id },
      select: { id: true, status: true, master_bundle_id: true },
    });
    if (!draft) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!draft.master_bundle_id) {
      return NextResponse.json({
        bundle_draft_id: draft.id,
        draft_status: draft.status,
        per_sku: [],
        note: "Draft has no MasterBundle yet — run POST /validate first.",
      });
    }
    const skus = await prisma.channelSKU.findMany({
      where: { master_bundle_id: draft.master_bundle_id },
      select: {
        id: true,
        channel: true,
        sku: true,
        validation_status: true,
        validation_errors: true,
        validated_at: true,
        validation_attempt_count: true,
      },
      orderBy: { channel: "asc" },
    });
    return NextResponse.json({
      bundle_draft_id: draft.id,
      master_bundle_id: draft.master_bundle_id,
      draft_status: draft.status,
      per_sku: skus,
    });
  },
);
