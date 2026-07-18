/**
 * GET  /api/bundle-factory/drafts
 *      ?status=VARIATION_SELECTED|GENERATED|APPROVED|... (default = all
 *              non-DRAFT, since DRAFT lives under /briefs)
 *      ?generation_job_id=...
 *      ?brand=...
 *      ?limit=100
 *
 * POST /api/bundle-factory/drafts
 *      Body: BundleDraft create payload (same fields as /briefs, plus
 *      optional draft_* content/image fields).
 *
 * PATCH /api/bundle-factory/drafts
 *      Body: { id, ...partial }
 *      Generic partial-update for a draft. Allowed fields are whitelisted.
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

const APPROVAL_PROTECTED_STATES = new Set([
  "APPROVED",
  "PUBLISHING",
  "PUBLISHED",
  "SUBMITTED",
  "PROCESSING",
  "LIVE",
]);

export const GET = withErrorHandler("drafts", async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const generationJobId = searchParams.get("generation_job_id");
  const brand = searchParams.get("brand");
  const limit = Math.min(500, Math.max(1, intParam(searchParams, "limit", 100)));

  if (status && !isOneOf(LIFECYCLE_STATES, status)) {
    return badRequest(`Invalid status. Allowed: ${LIFECYCLE_STATES.join(", ")}`);
  }

  const where: Record<string, unknown> = {};
  if (status) {
    where.status = status;
  } else {
    // Default: hide pure briefs (DRAFT) — they have their own endpoint.
    where.status = { not: "DRAFT" };
  }
  if (generationJobId) where.generation_job_id = generationJobId;
  if (brand) where.brand = brand;

  const drafts = await prisma.bundleDraft.findMany({
    where,
    orderBy: { updated_at: "desc" },
    take: limit,
  });
  return NextResponse.json({ drafts, total: drafts.length });
});

type CreatePayload = {
  generation_job_id: string;
  draft_name: string;
  brand: string;
  category: string;
  composition_type: string;
  pack_count: number;
  draft_components: unknown;
  target_channels: string[];
  status?: string;
  draft_title?: string;
  draft_bullets?: unknown;
  draft_description?: string;
  draft_search_terms?: string;
  draft_main_image_url?: string;
  draft_secondary_images?: unknown;
  draft_cost_cents?: number;
  draft_suggested_price_cents?: number;
};

export const POST = withErrorHandler(
  "drafts[POST]",
  async (request: Request) => {
    const body = await readJson<CreatePayload>(request);
    if (!body) return badRequest("Body must be JSON");
    const required = [
      "generation_job_id",
      "draft_name",
      "brand",
      "category",
      "composition_type",
      "pack_count",
      "draft_components",
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
    if (body.status && !isOneOf(LIFECYCLE_STATES, body.status)) {
      return badRequest(`Invalid status: ${body.status}`);
    }
    if (body.status && APPROVAL_PROTECTED_STATES.has(body.status)) {
      return badRequest(
        `status=${body.status} can only be reached through validation, approval, and distribution workflows.`,
      );
    }
    for (const ch of body.target_channels ?? []) {
      if (!isOneOf(SALES_CHANNELS, ch)) {
        return badRequest(`Invalid target_channels entry: ${ch}`);
      }
    }

    const created = await prisma.bundleDraft.create({
      data: {
        generation_job_id: body.generation_job_id,
        draft_name: body.draft_name,
        brand: body.brand,
        category: body.category,
        composition_type: body.composition_type,
        pack_count: body.pack_count,
        draft_components: JSON.stringify(body.draft_components),
        target_channels: JSON.stringify(body.target_channels),
        status: body.status ?? "VARIATION_SELECTED",
        draft_title: body.draft_title,
        draft_bullets: body.draft_bullets
          ? JSON.stringify(body.draft_bullets)
          : undefined,
        draft_description: body.draft_description,
        draft_search_terms: body.draft_search_terms,
        draft_main_image_url: body.draft_main_image_url,
        draft_secondary_images: body.draft_secondary_images
          ? JSON.stringify(body.draft_secondary_images)
          : undefined,
        draft_cost_cents: body.draft_cost_cents,
        draft_suggested_price_cents: body.draft_suggested_price_cents,
      },
    });
    return NextResponse.json({ draft: created }, { status: 201 });
  }
);

type PatchPayload = Partial<CreatePayload> & {
  id: string;
  approval_notes?: string;
};

const PATCHABLE_FIELDS = new Set([
  "draft_name",
  "draft_title",
  "draft_bullets",
  "draft_description",
  "draft_search_terms",
  "draft_main_image_url",
  "draft_secondary_images",
  "draft_cost_cents",
  "draft_suggested_price_cents",
  "draft_components",
  "target_channels",
  "approval_notes",
  "pack_count",
]);

const JSON_FIELDS = new Set([
  "draft_bullets",
  "draft_secondary_images",
  "draft_components",
  "target_channels",
]);

export const PATCH = withErrorHandler(
  "drafts[PATCH]",
  async (request: Request) => {
    const body = await readJson<PatchPayload>(request);
    if (!body) return badRequest("Body must be JSON");
    if (!body.id) return badRequest("id is required");
    if (body.status !== undefined) {
      return badRequest(
        "Draft status is workflow-owned and cannot be changed through the generic PATCH endpoint.",
      );
    }

    const current = await prisma.bundleDraft.findUnique({
      where: { id: body.id },
      select: { master_bundle_id: true },
    });
    if (!current) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === "id") continue;
      if (!PATCHABLE_FIELDS.has(k)) continue;
      data[k] = JSON_FIELDS.has(k) ? JSON.stringify(v) : v;
    }
    if (Object.keys(data).length === 0) {
      return badRequest("No patchable fields supplied");
    }
    const materialFields = Object.keys(data).filter(
      (field) => field !== "approval_notes",
    );
    if (current.master_bundle_id && materialFields.length > 0) {
      return badRequest(
        `Promoted drafts cannot be materially edited through generic PATCH (${materialFields.join(", ")}); use the content/image regeneration workflow so validation and approval are invalidated safely.`,
      );
    }
    const updated = await prisma.bundleDraft.update({
      where: { id: body.id },
      data,
    });
    return NextResponse.json({ draft: updated });
  }
);
