/**
 * GET /api/cron/adjustments-amazon
 *
 * Daily nightly cron — re-runs the same two-step Amazon adjustments
 * sync that the UI's "Sync now" button does, then records the outcome
 * in SyncLog so the page's scan history can display "last successful
 * run + N rows added".
 *
 * Step 1: /api/adjustments/scan         (Financial Events, real-time)
 * Step 2: /api/adjustments/settlement-sync (TSV Settlement Reports for SKU)
 *
 * Walmart adjustments are handled separately by /api/cron/walmart's
 * syncAdjustments sub-job.
 *
 * Auth: Vercel cron adds `authorization: Bearer ${CRON_SECRET}`; we
 * validate when CRON_SECRET is set (no gate in dev/local).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getFinancialEvents,
  parseAdjustments,
  buildAdjustmentExternalId,
} from "@/lib/amazon-sp-api/finances";
import { fetchSettlementAdjustments } from "@/lib/amazon-sp-api/settlement-reports";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";

// Settlement TSV downloads + financial-events pagination can take a while
// across all stores. 5 minutes covers the worst case (full settlement
// re-walk for 3 stores with rate limiting).
export const maxDuration = 300;

const SKIPPED_STORES = new Set<string>(["store2"]);

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function runFinancialEventsScan(): Promise<{
  scanned: number;
  inserted: number;
  perStore: Array<{ store: string; ok: boolean; scanned: number; inserted: number; error?: string }>;
}> {
  const days = 14;
  const postedAfter = new Date(Date.now() - days * 86400_000).toISOString();
  const stores = getConfiguredStores().filter((s) => !SKIPPED_STORES.has(s));

  const perStore: Array<{ store: string; ok: boolean; scanned: number; inserted: number; error?: string }> = [];
  let totalScanned = 0;
  let totalInserted = 0;

  for (const storeId of stores) {
    try {
      const events = await getFinancialEvents({ storeId, postedAfter });
      const parsed = parseAdjustments(events);
      const candidates = parsed.map((adj) => ({
        adj,
        externalId: buildAdjustmentExternalId(adj, storeId),
      }));
      const existing = await prisma.shippingAdjustment.findMany({
        where: { externalId: { in: candidates.map((c) => c.externalId) } },
        select: { externalId: true },
      });
      const seen = new Set(existing.map((e) => e.externalId));
      const toCreate = candidates
        .filter((c) => !seen.has(c.externalId))
        .map(({ adj, externalId }) => ({
          externalId,
          channel: "Amazon",
          storeId,
          currency: adj.currency,
          orderId: adj.orderId ?? null,
          amazonOrderId: adj.orderId ?? null,
          adjustmentDate: adj.postedDate.split("T")[0] || "",
          adjustmentType: adj.type,
          rawType: adj.rawType,
          adjustmentAmount: adj.amount,
          adjustmentReason: adj.reason,
          sku: adj.sku ?? null,
        }));
      let inserted = 0;
      if (toCreate.length > 0) {
        const r = await prisma.shippingAdjustment.createMany({ data: toCreate });
        inserted = r.count;
      }
      perStore.push({ store: storeId, ok: true, scanned: parsed.length, inserted });
      totalScanned += parsed.length;
      totalInserted += inserted;
    } catch (err) {
      perStore.push({
        store: storeId,
        ok: false,
        scanned: 0,
        inserted: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: totalScanned, inserted: totalInserted, perStore };
}

async function runSettlementSync(): Promise<{
  inserted: number;
  enriched: number;
  perStore: Array<{ store: string; ok: boolean; inserted: number; enriched: number; error?: string }>;
}> {
  const days = 60;
  const stores = getConfiguredStores().filter((s) => !SKIPPED_STORES.has(s));

  const perStore: Array<{ store: string; ok: boolean; inserted: number; enriched: number; error?: string }> = [];
  let totalInserted = 0;
  let totalEnriched = 0;

  for (const storeId of stores) {
    try {
      const { adjustments } = await fetchSettlementAdjustments(storeId, days);
      let inserted = 0;
      let enriched = 0;
      for (const rec of adjustments) {
        const result = await prisma.shippingAdjustment.upsert({
          where: { externalId: rec.externalId },
          create: rec,
          update: {
            orderId: rec.orderId,
            amazonOrderId: rec.amazonOrderId,
            sku: rec.sku,
            currency: rec.currency,
            adjustmentReason: rec.adjustmentReason,
          },
        });
        if (Date.now() - result.createdAt.getTime() < 1500) inserted++;
        else enriched++;
      }
      perStore.push({ store: storeId, ok: true, inserted, enriched });
      totalInserted += inserted;
      totalEnriched += enriched;
    } catch (err) {
      perStore.push({
        store: storeId,
        ok: false,
        inserted: 0,
        enriched: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { inserted: totalInserted, enriched: totalEnriched, perStore };
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const startedAt = Date.now();
  const syncLog = await prisma.syncLog.create({
    data: { jobName: "adjustments-amazon", status: "running" },
  });

  try {
    const scan = await runFinancialEventsScan();
    const settle = await runSettlementSync();

    const totalItems =
      scan.inserted + settle.inserted + settle.enriched;
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "done",
        completedAt: new Date(),
        itemsSynced: totalItems,
      },
    });

    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      scan,
      settle,
      itemsSynced: totalItems,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "error",
        completedAt: new Date(),
        error: msg,
      },
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
