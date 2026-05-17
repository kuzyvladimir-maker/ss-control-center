/**
 * GET  /api/bundle-factory/upc-pool
 *      ?status=AVAILABLE|RESERVED|ASSIGNED|RETIRED|INVALID
 *      ?prefix=742259|789232|617261
 *      ?limit=100 (default 200, max 1000)
 *
 *   Returns matching UPC rows + a pool summary (counts per status).
 *
 * POST /api/bundle-factory/upc-pool
 *      Body: { action: "reserve", upc?: string, ttl_minutes?: number,
 *              reserved_for_id?: string }
 *
 *   Reserves a UPC for a BundleDraft. If `upc` is given, reserves that
 *   specific code; otherwise picks the first AVAILABLE row. Returns the
 *   reserved row, or 409 if nothing is available / 404 if the requested
 *   UPC is not in pool.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  notFound,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { UPC_STATUSES, isOneOf } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "upc-pool",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const prefix = searchParams.get("prefix");
    const limit = Math.min(1000, Math.max(1, intParam(searchParams, "limit", 200)));

    if (status && !isOneOf(UPC_STATUSES, status)) {
      return badRequest(`Invalid status. Allowed: ${UPC_STATUSES.join(", ")}`);
    }

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (prefix) where.upc_prefix = prefix;

    const [upcs, summary] = await Promise.all([
      prisma.uPCPool.findMany({ where, orderBy: { upc: "asc" }, take: limit }),
      prisma.uPCPool.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    ]);

    return NextResponse.json({
      upcs,
      total: upcs.length,
      summary: Object.fromEntries(
        summary.map((s) => [s.status, s._count._all])
      ),
    });
  }
);

type ReservePayload = {
  action?: string;
  upc?: string;
  ttl_minutes?: number;
  reserved_for_id?: string;
};

export const POST = withErrorHandler(
  "upc-pool[POST]",
  async (request: Request) => {
    const body = await readJson<ReservePayload>(request);
    if (!body) return badRequest("Body must be JSON");

    if (body.action !== "reserve") {
      return badRequest('Only action: "reserve" is supported in Phase 1');
    }

    const ttlMinutes = body.ttl_minutes ?? 60;
    const reservedUntil = new Date(Date.now() + ttlMinutes * 60_000);

    if (body.upc) {
      const row = await prisma.uPCPool.findUnique({ where: { upc: body.upc } });
      if (!row) return notFound("UPC not in pool");
      if (row.status !== "AVAILABLE") {
        return NextResponse.json(
          { error: "UPC is not AVAILABLE", current_status: row.status },
          { status: 409 }
        );
      }
      const updated = await prisma.uPCPool.update({
        where: { upc: body.upc },
        data: {
          status: "RESERVED",
          reserved_for_id: body.reserved_for_id ?? null,
          reserved_at: new Date(),
          reserved_until: reservedUntil,
        },
      });
      return NextResponse.json({ upc: updated });
    }

    // Pick first AVAILABLE row.
    const pick = await prisma.uPCPool.findFirst({
      where: { status: "AVAILABLE" },
      orderBy: { upc: "asc" },
    });
    if (!pick) {
      return NextResponse.json(
        { error: "No AVAILABLE UPCs in pool" },
        { status: 409 }
      );
    }
    const updated = await prisma.uPCPool.update({
      where: { id: pick.id },
      data: {
        status: "RESERVED",
        reserved_for_id: body.reserved_for_id ?? null,
        reserved_at: new Date(),
        reserved_until: reservedUntil,
      },
    });
    return NextResponse.json({ upc: updated });
  }
);
