/**
 * POST /api/adjustments/settlement-sync
 *
 * Pulls every settlement report (V2 TSV) released in the past `days` days
 * for each configured store, extracts the shipping adjustment rows, and
 * upserts them into ShippingAdjustment.
 *
 * Settlement rows produce the SAME externalId as Phase A's Financial
 * Events rows, so this acts as an enrichment pass: existing Phase A rows
 * (no orderId, no SKU) get updated with the SKU + order linkage; rows
 * Phase A missed get inserted fresh.
 *
 * Banned/suspended store handling matches /api/adjustments/scan: skip
 * store2 (Personal — 403), include store5 (US-suspended but SP-API
 * still returns).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchSettlementAdjustments } from "@/lib/amazon-sp-api/settlement-reports";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";
import { rebuildSkuProfilesFor } from "@/lib/adjustments/sku-profiles";
import { enrichAdjustmentsFromShippingPlan } from "@/lib/adjustments/enrich";

const SKIPPED_STORES = new Set<string>(["store2"]);

type StoreResult = {
  store: string;
  ok: boolean;
  reportsProcessed: number;
  adjustmentsFound: number;
  inserted: number;
  enriched: number;
  error?: string;
};

export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const days = Math.max(7, Math.min(120, parseInt(sp.get("days") || "60")));

  const stores = getConfiguredStores().filter((s) => !SKIPPED_STORES.has(s));
  const skipped = getConfiguredStores().filter((s) =>
    SKIPPED_STORES.has(s)
  );

  const syncLog = await prisma.syncLog.create({
    data: { jobName: "adjustments-amazon-settlement", status: "running" },
  });

  const results: StoreResult[] = [];
  const touchedSkus: Array<string | null> = [];

  for (const storeId of stores) {
    try {
      const { reports, adjustments } = await fetchSettlementAdjustments(
        storeId,
        days
      );

      let inserted = 0;
      let enriched = 0;

      // Upsert each adjustment. Settlement is authoritative — its
      // orderId / sku always wins when the underlying row already exists.
      for (const rec of adjustments) {
        if (rec.sku) touchedSkus.push(rec.sku);
        const result = await prisma.shippingAdjustment.upsert({
          where: { externalId: rec.externalId },
          create: rec,
          update: {
            orderId: rec.orderId,
            amazonOrderId: rec.amazonOrderId,
            sku: rec.sku,
            currency: rec.currency,
            adjustmentReason: rec.adjustmentReason,
            // Keep Phase A's adjustmentType/rawType as-is — both sources
            // agree on the classification.
          },
        });
        // Upsert doesn't tell us which path ran; infer by createdAt vs now.
        // Newly-created rows have createdAt ~= now (within 1s).
        if (Date.now() - result.createdAt.getTime() < 1500) {
          inserted++;
        } else {
          enriched++;
        }
      }

      results.push({
        store: storeId,
        ok: true,
        reportsProcessed: reports.length,
        adjustmentsFound: adjustments.length,
        inserted,
        enriched,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[adjustments/settlement-sync] ${storeId}:`, msg);
      results.push({
        store: storeId,
        ok: false,
        reportsProcessed: 0,
        adjustmentsFound: 0,
        inserted: 0,
        enriched: 0,
        error: msg,
      });
    }
  }

  const totalAdjustments = results.reduce((s, r) => s + r.adjustmentsFound, 0);
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const totalEnriched = results.reduce((s, r) => s + r.enriched, 0);
  const anyError = results.some((r) => !r.ok);

  // Enrich rows with carrier + productName from ShippingPlanItem (Veeqo
  // outgoing-label records). Coverage is partial — only orders shipped
  // via the Veeqo pipeline match — but it's what powers the carrier
  // filter on the /adjustments page.
  const enrich = await enrichAdjustmentsFromShippingPlan();

  // Rebuild SKU profiles for every SKU touched by this sync — drives the
  // SKU Issues panel + "needs SKU-DB update" flag.
  const { profilesUpdated } = await rebuildSkuProfilesFor(touchedSkus);

  await prisma.syncLog.update({
    where: { id: syncLog.id },
    data: {
      status: anyError ? "error" : "done",
      completedAt: new Date(),
      itemsSynced: totalInserted + totalEnriched,
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
    totalAdjustments,
    totalInserted,
    totalEnriched,
    profilesUpdated,
    enrichment: enrich,
    perStore: results,
  });
}
