/**
 * POST /api/reference-catalog/enqueue  — queue a directed enrichment ("vector").
 *   body: { target: string, targetType?: "brand"|"product"|"sku"|"query", requestedBy?: string }
 * GET  /api/reference-catalog/enqueue  — recent jobs (for the Reference Catalog page).
 *
 * The cron worker (reference-enrichment-worker) drains the queue.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { enqueueEnrichment, type EnrichTargetType } from "@/lib/sourcing/enrichment-queue";

export const dynamic = "force-dynamic";

function db() {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({} as any));
  const target = String(body?.target || "").trim();
  if (!target) return NextResponse.json({ error: "target required" }, { status: 400 });
  const targetType = (["brand", "product", "sku", "query"].includes(body?.targetType) ? body.targetType : "brand") as EnrichTargetType;
  try {
    const r = await enqueueEnrichment(db(), { targetType, target, source: "manual", requestedBy: body?.requestedBy ?? null });
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || "enqueue failed") }, { status: 500 });
  }
}

export async function GET() {
  try {
    const jobs = await db().execute(
      `SELECT id, targetType, target, status, source, attempts, result, error, queuedAt, finishedAt
       FROM "EnrichmentJob" ORDER BY queuedAt DESC LIMIT 50`,
    );
    return NextResponse.json({ ok: true, jobs: jobs.rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || "query failed"), jobs: [] });
  }
}
