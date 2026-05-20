/**
 * GET /api/bundle-factory/drafts/[id]/distribution-status
 *
 * Snapshot per-channel listing state without triggering anything.
 * Used by DraftDetailClient to refresh badges after the operator
 * clicks Publish All or Poll Status.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(
  "drafts[id]/distribution-status",
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
        note: "Draft has no MasterBundle yet — run validate (then publish).",
      });
    }
    const skus = await prisma.channelSKU.findMany({
      where: { master_bundle_id: draft.master_bundle_id },
      select: {
        id: true,
        channel: true,
        sku: true,
        listing_status: true,
        submission_id: true,
        published_at: true,
        distribution_errors: true,
        distribution_attempt_count: true,
        last_status_check_at: true,
        asin: true,
        live_url: true,
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
