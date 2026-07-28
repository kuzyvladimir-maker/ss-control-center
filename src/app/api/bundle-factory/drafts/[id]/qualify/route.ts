/**
 * GET /api/bundle-factory/drafts/[id]/qualify
 *
 * Phase 4 — runs the Qualification Officer over every ChannelSKU of the draft's
 * MasterBundle and returns the per-SKU QA report (read-only, advisory). The
 * draft-detail UI surfaces this before publish; the operator resolves FAILs.
 */

import { NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { prisma } from "@/lib/prisma";
import { qualifyChannelSku } from "@/lib/bundle-factory/qualification/officer";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(
  "drafts[id]/qualify[GET]",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;

    const draft = await prisma.bundleDraft.findUnique({
      where: { id },
      select: { master_bundle_id: true },
    });
    if (!draft?.master_bundle_id) {
      return NextResponse.json({ ok: true, reports: [], note: "Draft not promoted to ChannelSKUs yet." });
    }

    const skus = await prisma.channelSKU.findMany({
      where: { master_bundle_id: draft.master_bundle_id },
      select: {
        sku: true,
        channel: true,
        title: true,
        bullets: true,
        description: true,
        price_cents: true,
        main_image_url: true,
        upc: true,
        package_weight_oz: true,
        package_length_in: true,
        package_width_in: true,
        package_height_in: true,
        attributes: true,
      },
    });

    const reports = skus.map((s) => qualifyChannelSku(s));
    const all_ok = reports.every((r) => r.ok);
    return NextResponse.json({ ok: all_ok, reports });
  },
);
