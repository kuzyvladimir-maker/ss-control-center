/**
 * POST /api/adjustments/scan
 *
 * Walks every configured Amazon store, pulls /finances/v0/financialEvents
 * for the last `days` days, runs the AdjustmentEvent classifier, and
 * upserts new rows into ShippingAdjustment.
 *
 * Banned/suspended stores: STORE2 (Personal — account banned) is skipped
 * outright since SP-API returns 403. STORE5 (Retailer — US suspension)
 * still returns valid finance data and is included.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getFinancialEvents,
  parseAdjustments,
  buildAdjustmentExternalId,
} from "@/lib/amazon-sp-api/finances";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";

/** Stores to skip even when SP-API creds exist. */
const SKIPPED_STORES = new Set<string>(["store2"]); // Personal — banned 2026-05-22

type StoreResult = {
  store: string;
  ok: boolean;
  scanned: number;
  newSaved: number;
  error?: string;
};

export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const days = Math.max(1, Math.min(60, parseInt(sp.get("days") || "14")));

  const postedAfter = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();

  const allStores = getConfiguredStores();
  const stores = allStores.filter((s) => !SKIPPED_STORES.has(s));
  const skipped = allStores.filter((s) => SKIPPED_STORES.has(s));

  // SyncLog entry — surfaced on /adjustments scan-history panel.
  const syncLog = await prisma.syncLog.create({
    data: { jobName: "adjustments-amazon-scan", status: "running" },
  });

  const results: StoreResult[] = [];

  for (const storeId of stores) {
    try {
      const events = await getFinancialEvents({ storeId, postedAfter });
      const parsed = parseAdjustments(events);

      const candidates = parsed.map((adj) => ({
        adj,
        externalId: buildAdjustmentExternalId(adj, storeId),
      }));

      // Bulk dedup — one query instead of N findUnique calls.
      const existing = await prisma.shippingAdjustment.findMany({
        where: { externalId: { in: candidates.map((c) => c.externalId) } },
        select: { externalId: true },
      });
      const existingIds = new Set(existing.map((e) => e.externalId));

      const toCreate = candidates
        .filter((c) => !existingIds.has(c.externalId))
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

      let newSaved = 0;
      if (toCreate.length > 0) {
        const r = await prisma.shippingAdjustment.createMany({
          data: toCreate,
        });
        newSaved = r.count;
      }

      results.push({
        store: storeId,
        ok: true,
        scanned: parsed.length,
        newSaved,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[adjustments/scan] ${storeId}:`, msg);
      results.push({
        store: storeId,
        ok: false,
        scanned: 0,
        newSaved: 0,
        error: msg,
      });
    }
  }

  const totalScanned = results.reduce((s, r) => s + r.scanned, 0);
  const totalNewSaved = results.reduce((s, r) => s + r.newSaved, 0);
  const anyError = results.some((r) => !r.ok);

  await prisma.syncLog.update({
    where: { id: syncLog.id },
    data: {
      status: anyError ? "error" : "done",
      completedAt: new Date(),
      itemsSynced: totalNewSaved,
      error: anyError
        ? results
            .filter((r) => !r.ok)
            .map((r) => `${r.store}: ${r.error}`)
            .join("; ")
        : null,
    },
  });

  return NextResponse.json({
    days,
    storesScanned: results.length,
    storesSkipped: skipped,
    totalScanned,
    totalNewSaved,
    perStore: results,
  });
}
