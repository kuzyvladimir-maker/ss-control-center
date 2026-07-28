/**
 * GET  /api/bundle-factory/generation-jobs
 *      ?status=PENDING|IN_PROGRESS|COMPLETED|FAILED|SKIPPED
 *      ?include=stages  (include child GenerationStage records)
 *      ?limit=50
 *
 * POST /api/bundle-factory/generation-jobs
 *      Body: { brief, bundles_target, user_id?, notes? }
 *
 *   Kicks off a new GenerationJob in PENDING state. Phase 1 has no
 *   pipeline executor wired yet — Stage 2+ will pick it up.
 *
 * PATCH /api/bundle-factory/generation-jobs
 *      Body: { id, ...mutable fields }
 *
 *   Used by pipeline workers (when they exist) and by manual admin ops.
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
  PIPELINE_STAGES,
  STAGE_STATUSES,
  isOneOf,
} from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "generation-jobs",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const includeStages = (searchParams.get("include") ?? "")
      .split(",")
      .includes("stages");
    const limit = Math.min(200, Math.max(1, intParam(searchParams, "limit", 50)));

    if (status && !isOneOf(STAGE_STATUSES, status)) {
      return badRequest(
        `Invalid status. Allowed: ${STAGE_STATUSES.join(", ")}`
      );
    }

    const jobs = await prisma.generationJob.findMany({
      where: status ? { status } : undefined,
      include: includeStages ? { stages: true } : undefined,
      orderBy: { created_at: "desc" },
      take: limit,
    });
    return NextResponse.json({ jobs, total: jobs.length });
  }
);

type CreatePayload = {
  brief: unknown;
  bundles_target: number;
  user_id?: string;
  notes?: string;
};

export const POST = withErrorHandler(
  "generation-jobs[POST]",
  async (request: Request) => {
    const body = await readJson<CreatePayload>(request);
    if (!body) return badRequest("Body must be JSON");
    if (body.brief === undefined) return badRequest("brief is required");
    if (typeof body.bundles_target !== "number" || body.bundles_target <= 0) {
      return badRequest("bundles_target must be a positive integer");
    }

    const created = await prisma.generationJob.create({
      data: {
        brief: JSON.stringify(body.brief),
        bundles_target: body.bundles_target,
        user_id: body.user_id,
        notes: body.notes,
      },
    });
    return NextResponse.json({ job: created }, { status: 201 });
  }
);

type PatchPayload = {
  id: string;
  current_stage?: string;
  status?: string;
  bundles_generated?: number;
  bundles_approved?: number;
  bundles_published?: number;
  bundles_error?: number;
  openai_tokens_used?: number;
  perplexity_queries?: number;
  images_generated?: number;
  cost_cents?: number;
  notes?: string;
  completed_at?: string | null;
};

const PATCHABLE = new Set([
  "current_stage",
  "status",
  "bundles_generated",
  "bundles_approved",
  "bundles_published",
  "bundles_error",
  "openai_tokens_used",
  "perplexity_queries",
  "images_generated",
  "cost_cents",
  "notes",
  "completed_at",
]);

export const PATCH = withErrorHandler(
  "generation-jobs[PATCH]",
  async (request: Request) => {
    const body = await readJson<PatchPayload>(request);
    if (!body) return badRequest("Body must be JSON");
    if (!body.id) return badRequest("id is required");
    if (body.current_stage && !isOneOf(PIPELINE_STAGES, body.current_stage)) {
      return badRequest(`Invalid current_stage: ${body.current_stage}`);
    }
    if (body.status && !isOneOf(STAGE_STATUSES, body.status)) {
      return badRequest(`Invalid status: ${body.status}`);
    }
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === "id") continue;
      if (!PATCHABLE.has(k)) continue;
      data[k] = k === "completed_at" && v ? new Date(v as string) : v;
    }
    if (Object.keys(data).length === 0) {
      return badRequest("No patchable fields supplied");
    }
    const updated = await prisma.generationJob.update({
      where: { id: body.id },
      data,
    });
    return NextResponse.json({ job: updated });
  }
);
