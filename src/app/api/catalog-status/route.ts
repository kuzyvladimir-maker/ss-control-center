/**
 * GET /api/catalog-status
 *
 * Feeds the Catalog Status dashboard: the ALWAYS-CURRENT stats (computed live) plus
 * the hourly time-series (CatalogSnapshot rows) for the progress graph. If no snapshot
 * exists yet, seeds one so the graph is never empty on first visit.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, type Client } from "@libsql/client";
import { computeCatalogStats, readSnapshotSeries, writeCatalogSnapshot } from "@/lib/catalog/catalog-stats";
import { getPaidServiceHealth, probePaidServices } from "@/lib/sourcing/service-health";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

function db(): Client {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

export async function GET(_request: NextRequest) {
  try {
    const conn = db();
    const current = await computeCatalogStats(conn);
    let series = await readSnapshotSeries(conn, 120);
    // Seed the first point so the dashboard graph has data before the hourly cron runs.
    if (series.length === 0) {
      await writeCatalogSnapshot(conn, current, randomUUID(), new Date().toISOString());
      series = await readSnapshotSeries(conn, 120);
    }
    // Paid-service health: use the cached snapshot; probe live if we've never checked.
    let serviceHealth = await getPaidServiceHealth(conn);
    if (!serviceHealth) serviceHealth = await probePaidServices(conn).catch(() => null);
    return NextResponse.json({ ok: true, current, series, serviceHealth });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
