/**
 * GET    /api/bundle-factory/briefs/[id]
 *        Returns the BundleDraft + its ResearchPool + GenerationStage[]
 *        for the detail page. Heavy enough that we don't fetch it via
 *        the list endpoint.
 *
 * PATCH  /api/bundle-factory/briefs/[id]
 *        Edits a brief while still in DRAFT status. Once research runs
 *        the brief locks (you can re-run research, but the brief fields
 *        themselves are frozen).
 *
 * DELETE /api/bundle-factory/briefs/[id]
 *        Soft-archives the brief (status → ARCHIVED). Hard delete is
 *        reserved for admin tooling — preserves the audit trail.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import {
  COMPOSITION_TYPES,
  PRODUCT_CATEGORIES,
  SALES_CHANNELS,
  isOneOf,
} from "@/lib/bundle-factory/enums";
import { logLifecycle } from "@/lib/bundle-factory/lifecycle-log";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(
  "briefs[id]",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const brief = await prisma.bundleDraft.findUnique({ where: { id } });
    if (!brief) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [researchPool, stages] = await Promise.all([
      prisma.researchPool.findMany({
        where: { generation_job_id: brief.generation_job_id },
        orderBy: [{ freshness_score: "desc" }, { created_at: "asc" }],
      }),
      prisma.generationStage.findMany({
        where: { generation_job_id: brief.generation_job_id },
        orderBy: { started_at: "asc" },
      }),
    ]);

    return NextResponse.json({
      brief,
      research_pool: researchPool,
      stages,
    });
  },
);

interface PatchBody {
  draft_name?: unknown;
  pack_count?: unknown;
  category?: unknown;
  composition_type?: unknown;
  brand?: unknown;
  target_channels?: unknown;
  draft_components?: unknown;
}

export const PATCH = withErrorHandler(
  "briefs[id][PATCH]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const brief = await prisma.bundleDraft.findUnique({ where: { id } });
    if (!brief) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (brief.status !== "DRAFT") {
      return badRequest(
        `Brief can only be edited while status=DRAFT (current=${brief.status})`,
      );
    }

    const body = await readJson<PatchBody>(request);
    if (!body) return badRequest("Body must be JSON");

    const data: Record<string, unknown> = {};

    if (typeof body.draft_name === "string") {
      const trimmed = body.draft_name.trim();
      if (trimmed.length < 5 || trimmed.length > 100) {
        return badRequest("draft_name must be 5–100 chars");
      }
      data.draft_name = trimmed;
    }
    if (typeof body.brand === "string") {
      data.brand = body.brand.trim();
    }
    if (typeof body.pack_count === "number") {
      if (body.pack_count < 2 || body.pack_count > 50) {
        return badRequest("pack_count must be between 2 and 50");
      }
      data.pack_count = body.pack_count;
    }
    if (typeof body.category === "string") {
      if (!isOneOf(PRODUCT_CATEGORIES, body.category)) {
        return badRequest(`Invalid category: ${body.category}`);
      }
      data.category = body.category;
    }
    if (typeof body.composition_type === "string") {
      if (!isOneOf(COMPOSITION_TYPES, body.composition_type)) {
        return badRequest(`Invalid composition_type: ${body.composition_type}`);
      }
      data.composition_type = body.composition_type;
    }
    if (Array.isArray(body.target_channels)) {
      for (const ch of body.target_channels) {
        if (typeof ch !== "string" || !isOneOf(SALES_CHANNELS, ch)) {
          return badRequest(`Invalid target_channels entry: ${String(ch)}`);
        }
      }
      if (body.target_channels.length === 0) {
        return badRequest("target_channels must be non-empty");
      }
      data.target_channels = JSON.stringify(body.target_channels);
    }
    if (body.draft_components !== undefined) {
      data.draft_components = JSON.stringify(body.draft_components);
    }

    if (Object.keys(data).length === 0) {
      return badRequest("No editable fields supplied");
    }

    const updated = await prisma.bundleDraft.update({
      where: { id },
      data,
    });
    return NextResponse.json({ brief: updated });
  },
);

export const DELETE = withErrorHandler(
  "briefs[id][DELETE]",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const brief = await prisma.bundleDraft.findUnique({ where: { id } });
    if (!brief) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updated = await prisma.bundleDraft.update({
      where: { id },
      data: { status: "ARCHIVED" },
    });

    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: id,
      from_status: brief.status,
      to_status: "ARCHIVED",
      reason: "Brief archived via DELETE endpoint",
      actor: "user",
    });

    return NextResponse.json({ brief: updated });
  },
);
