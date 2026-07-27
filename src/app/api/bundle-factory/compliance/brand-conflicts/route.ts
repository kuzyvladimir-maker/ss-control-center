/**
 * GET  /api/bundle-factory/compliance/brand-conflicts
 *   ?status=active|resolved|archived   default 'active'
 *   ?limit=200                          default 200, max 1000
 *
 * POST /api/bundle-factory/compliance/brand-conflicts
 *   Body: { foreign_brand, product_keywords[], asin?, account?,
 *           incident_type, amazon_action?, notes? }
 *
 *   Adds one BrandConflict row for Rule 7 to pick up on subsequent
 *   gate runs. `incident_date` defaults to now if omitted.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

const ALLOWED_STATUS = ["active", "resolved", "archived"] as const;

export const GET = withErrorHandler(
  "compliance/brand-conflicts:get",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status") ?? "active";
    if (!ALLOWED_STATUS.includes(statusParam as (typeof ALLOWED_STATUS)[number])) {
      return badRequest(
        `Invalid status. Allowed: ${ALLOWED_STATUS.join(", ")}`,
      );
    }
    const limit = Math.min(
      1000,
      Math.max(1, Number.parseInt(searchParams.get("limit") ?? "200", 10) || 200),
    );

    const conflicts = await prisma.brandConflict.findMany({
      where: { status: statusParam },
      orderBy: { incident_date: "desc" },
      take: limit,
    });

    return NextResponse.json({ conflicts, count: conflicts.length });
  },
);

interface PostBody {
  foreign_brand?: unknown;
  product_keywords?: unknown;
  asin?: unknown;
  account?: unknown;
  incident_date?: unknown;
  incident_type?: unknown;
  amazon_action?: unknown;
  notes?: unknown;
}

export const POST = withErrorHandler(
  "compliance/brand-conflicts:post",
  async (request: Request) => {
    const body = (await readJson<PostBody>(request)) ?? {};
    const foreignBrand =
      typeof body.foreign_brand === "string"
        ? body.foreign_brand.trim()
        : "";
    if (!foreignBrand) return badRequest("foreign_brand is required");

    const keywords = Array.isArray(body.product_keywords)
      ? body.product_keywords.filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0,
        )
      : [];
    if (keywords.length === 0) {
      return badRequest("product_keywords must be a non-empty string array");
    }

    const incidentType =
      typeof body.incident_type === "string" && body.incident_type.trim()
        ? body.incident_type.trim()
        : "trademark_logo_misuse";

    let incidentDate = new Date();
    if (typeof body.incident_date === "string") {
      const parsed = new Date(body.incident_date);
      if (!Number.isNaN(parsed.getTime())) incidentDate = parsed;
    }

    const conflict = await prisma.brandConflict.create({
      data: {
        foreign_brand: foreignBrand,
        product_keywords: JSON.stringify(keywords),
        asin: typeof body.asin === "string" ? body.asin : null,
        account: typeof body.account === "string" ? body.account : null,
        incident_date: incidentDate,
        incident_type: incidentType,
        amazon_action:
          typeof body.amazon_action === "string" ? body.amazon_action : null,
        notes: typeof body.notes === "string" ? body.notes : null,
        status: "active",
      },
    });

    return NextResponse.json({ conflict }, { status: 201 });
  },
);
