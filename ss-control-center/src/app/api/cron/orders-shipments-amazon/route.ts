/**
 * GET /api/cron/orders-shipments-amazon
 *
 * Daily — for every Amazon adjustment row missing carrier/tracking,
 * queries Veeqo by amazonOrderId, extracts the actual carrier
 * (service_carrier_name) + tracking_number, and upserts into
 * AmazonOrderShipment. Adjustment enrichment then runs to copy
 * carrier onto ShippingAdjustment rows.
 *
 * Why Veeqo, not Amazon Reports: Amazon's flat-file Orders reports
 * lack carrier/tracking columns, and Amazon doesn't expose
 * seller-confirmed tracking back through standard endpoints. Veeqo
 * has every shipment Vladimir ever printed.
 *
 * Rate-limit-friendly: 1 Veeqo call per unique unseen orderId.
 * Cap at 500 per run to keep within Vercel function timeout.
 *
 * maxDuration=300 covers the worst case (500 orders × ~0.4s = 200s).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncShipmentsForAdjustments } from "@/lib/amazon-sp-api/orders-shipments";
import { enrichAdjustmentsFromShippingPlan } from "@/lib/adjustments/enrich";

export const maxDuration = 300;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const sp = request.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(500, parseInt(sp.get("limit") || "500")));

  const syncLog = await prisma.syncLog.create({
    data: { jobName: "orders-shipments-amazon", status: "running" },
  });

  const startedAt = Date.now();
  let veeqoResult;
  let enrich;
  try {
    veeqoResult = await syncShipmentsForAdjustments({ limit });
    enrich = await enrichAdjustmentsFromShippingPlan();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: { status: "error", completedAt: new Date(), error: msg },
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  await prisma.syncLog.update({
    where: { id: syncLog.id },
    data: {
      status: veeqoResult.errors > 0 ? "error" : "done",
      completedAt: new Date(),
      itemsSynced: veeqoResult.upserted + (enrich?.updated ?? 0),
      error:
        veeqoResult.errors > 0
          ? `${veeqoResult.errors} Veeqo lookups failed (see server log)`
          : null,
    },
  });

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    veeqo: veeqoResult,
    enrichment: enrich,
  });
}
