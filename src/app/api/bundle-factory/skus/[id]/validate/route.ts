/**
 * POST /api/bundle-factory/skus/[id]/validate
 *      Body (optional): { actor?: string }
 *
 * Phase 2.4 Stage 6 — single-SKU re-validate. Used by the per-channel
 * Re-validate button in the UI after the operator fills in a missing
 * field (item_type, package weight, etc.) or the inventory situation
 * changes.
 *
 * Does NOT trigger draft-level status transitions — those happen only
 * when validate-by-draft processes the full set. A single-SKU re-run
 * just refreshes that one row.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import {
  persistValidation,
  runValidation,
} from "@/lib/bundle-factory/validation/validation-pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  actor?: unknown;
}

export const POST = withErrorHandler(
  "skus[id]/validate[POST]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const _body = (await readJson<Body>(request)) ?? {};

    const sku = await prisma.channelSKU.findUnique({ where: { id } });
    if (!sku) {
      return NextResponse.json({ error: "ChannelSKU not found" }, { status: 404 });
    }

    // Need the parent draft's brand for the compliance-rerun validator.
    const draft = await prisma.bundleDraft.findFirst({
      where: { master_bundle_id: sku.master_bundle_id },
      select: { brand: true },
    });
    const draftBrand = draft?.brand ?? "";

    const outcome = await runValidation(sku, draftBrand);
    await persistValidation(sku, outcome);

    return NextResponse.json({
      sku_id: sku.id,
      channel: sku.channel,
      validation_status: outcome.status,
      failed: outcome.failed,
      warnings: outcome.warnings,
      results: outcome.results,
      duration_ms: outcome.duration_ms,
    });
  },
);
