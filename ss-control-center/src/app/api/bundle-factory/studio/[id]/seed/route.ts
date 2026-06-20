/**
 * POST /api/bundle-factory/studio/[id]/seed
 *
 *   Seeds the draft's ResearchPool from hand-picked DonorProduct rows
 *   (the donor path — bypasses Perplexity). Thin wrapper over
 *   seedPoolFromDonors; the draft must be in DRAFT status.
 *
 *   Body: { donor_product_ids: string[] }
 *   Returns: the SeedPoolFromDonorsResult (ok, pool_size, mirror_summary, …)
 */

import { NextResponse } from "next/server";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { seedPoolFromDonors } from "@/lib/bundle-factory/donor-pool";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
  "studio-seed",
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = (await readJson<Record<string, unknown>>(request)) ?? {};

    const ids = Array.isArray(body.donor_product_ids)
      ? body.donor_product_ids.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (ids.length === 0) {
      return badRequest("donor_product_ids must be a non-empty array of ids");
    }

    const result = await seedPoolFromDonors({
      bundle_draft_id: id,
      donor_product_ids: ids,
      trigger: "manual",
      actor: "studio",
    });

    if (!result.ok) {
      return NextResponse.json(result, { status: 422 });
    }
    return NextResponse.json(result, { status: 200 });
  },
);
