/**
 * GET  /api/bundle-factory/briefs
 *      ?status=DRAFT  (filter; default = list all DRAFT)
 *      ?limit=100
 *
 *   A "brief" is a BundleDraft in its earliest state (status=DRAFT).
 *   This endpoint is the inbox of pending pipeline jobs the user has not
 *   yet kicked off.
 *
 * POST /api/bundle-factory/briefs
 *      Body: { generation_job_id, draft_name, brand, category,
 *              composition_type, pack_count, draft_components?,
 *              target_channels[] }
 *
 *   Creates a BundleDraft with status=DRAFT. In Phase 1 the generation
 *   pipeline isn't wired yet — this just records the request for later.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import {
  COMPOSITION_TYPES,
  LIFECYCLE_STATES,
  PRODUCT_CATEGORIES,
  SALES_CHANNELS,
  isOneOf,
} from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler("briefs", async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "DRAFT";
  const limit = Math.min(500, Math.max(1, intParam(searchParams, "limit", 100)));

  if (!isOneOf(LIFECYCLE_STATES, status)) {
    return badRequest(`Invalid status. Allowed: ${LIFECYCLE_STATES.join(", ")}`);
  }

  const briefs = await prisma.bundleDraft.findMany({
    where: { status },
    orderBy: { created_at: "desc" },
    take: limit,
  });
  return NextResponse.json({ briefs, total: briefs.length });
});

type CreatePayload = {
  /** Optional; auto-created if missing. */
  generation_job_id?: string;
  draft_name: string;
  brand: string;
  category: string;
  composition_type: string;
  pack_count: number;
  draft_components?: unknown;
  target_channels: string[];
};

export const POST = withErrorHandler(
  "briefs[POST]",
  async (request: Request) => {
    const body = await readJson<CreatePayload>(request);
    if (!body) return badRequest("Body must be JSON");
    const required = [
      "draft_name",
      "brand",
      "category",
      "composition_type",
      "pack_count",
      "target_channels",
    ] as const;
    for (const k of required) {
      if (body[k] === undefined || body[k] === null) {
        return badRequest(`Missing required field: ${k}`);
      }
    }
    if (!isOneOf(PRODUCT_CATEGORIES, body.category)) {
      return badRequest(`Invalid category: ${body.category}`);
    }
    if (!isOneOf(COMPOSITION_TYPES, body.composition_type)) {
      return badRequest(`Invalid composition_type: ${body.composition_type}`);
    }
    if (!Array.isArray(body.target_channels) || body.target_channels.length === 0) {
      return badRequest("target_channels must be a non-empty array");
    }
    for (const ch of body.target_channels) {
      if (!isOneOf(SALES_CHANNELS, ch)) {
        return badRequest(`Invalid target_channels entry: ${ch}`);
      }
    }
    if (typeof body.pack_count !== "number" || body.pack_count < 2 || body.pack_count > 50) {
      return badRequest("pack_count must be a number between 2 and 50");
    }

    // Auto-create the GenerationJob when the caller didn't supply one.
    // Keeping the field optional avoids breaking the Phase 1 contract.
    let generationJobId = body.generation_job_id;
    if (!generationJobId) {
      const job = await prisma.generationJob.create({
        data: {
          brief: JSON.stringify({
            draft_name: body.draft_name,
            brand: body.brand,
            category: body.category,
            composition_type: body.composition_type,
            pack_count: body.pack_count,
            target_channels: body.target_channels,
          }),
          current_stage: "BRIEF",
          status: "PENDING",
          bundles_target: 1,
          user_id: "user",
        },
        select: { id: true },
      });
      generationJobId = job.id;
    }

    const created = await prisma.bundleDraft.create({
      data: {
        generation_job_id: generationJobId,
        draft_name: body.draft_name,
        brand: body.brand,
        category: body.category,
        composition_type: body.composition_type,
        pack_count: body.pack_count,
        draft_components: JSON.stringify(body.draft_components ?? []),
        target_channels: JSON.stringify(body.target_channels),
        status: "DRAFT",
      },
    });
    return NextResponse.json({ brief: created }, { status: 201 });
  }
);
