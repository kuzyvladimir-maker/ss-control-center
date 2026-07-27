/**
 * GET /api/reference-catalog/enqueue — read-only recent-job status.
 *
 * POST is a hard tombstone. API callers must not create executable Product Truth
 * work outside a sealed canonical CLI plan.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { requireAdmin } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

function db() {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: "LEGACY_REFERENCE_ENRICHMENT_ENQUEUE_RETIRED",
      reason:
        "Legacy manual enrichment enqueue is disabled. Use the owner-gated, sealed Product Truth CLI.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const jobs = await db().execute(
      `SELECT id, targetType, target, listingKey, status, source, attempts, result, error, queuedAt, finishedAt
       FROM "EnrichmentJob" ORDER BY queuedAt DESC LIMIT 50`,
    );
    return NextResponse.json({ ok: true, jobs: jobs.rows });
  } catch (error: unknown) {
    return NextResponse.json({ ok: false, error: errorMessage(error, "query failed"), jobs: [] });
  }
}
