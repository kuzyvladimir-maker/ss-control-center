/**
 * GET /api/cron/walmart-catalog-report
 *
 * Drives the FULL-catalog ITEM report state machine one step per tick (request →
 * poll → download → replace the WalmartCatalogItem mirror). This is the AUTHORITATIVE
 * catalog source — it matches Seller Center (all statuses), unlike the /v3/items sync
 * which under-reports. The /reports rate bucket is tiny, so one step per tick + a
 * ~daily re-request keeps us well under it.
 *
 * We have one Walmart account (store 1). Auth: Bearer CRON_SECRET like the others.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient } from "@/lib/walmart/client";
import { driveItemCatalogReport } from "@/lib/walmart/catalog-report-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev/local: no gate
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const storeIndex = Number(new URL(request.url).searchParams.get("store") || "1");
  try {
    const result = await driveItemCatalogReport(prisma, new WalmartClient(storeIndex), storeIndex);
    return NextResponse.json({ ok: true, storeIndex, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, storeIndex, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
