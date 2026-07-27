/**
 * GET /api/cron/catalog-snapshot
 *
 * Hourly capture of catalog / COGS / enrichment progress → one CatalogSnapshot row.
 * This builds the time-series behind the Catalog Status dashboard's graph. Cheap
 * (a handful of COUNTs), so it runs every hour alongside the sweep it measures.
 *
 * Auth: Bearer CRON_SECRET like the others.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, type Client } from "@libsql/client";
import { computeCatalogStats, writeCatalogSnapshot } from "@/lib/catalog/catalog-stats";
import { probePaidServices } from "@/lib/sourcing/service-health";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

function db(): Client {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;
  try {
    const conn = db();
    const stats = await computeCatalogStats(conn);
    await writeCatalogSnapshot(conn, stats, randomUUID(), new Date().toISOString());
    // Also refresh paid-service health so a provider can't silently run dry unnoticed.
    const health = await probePaidServices(conn).catch(() => null);
    return NextResponse.json({ ok: true, ...stats, serviceHealth: health });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
