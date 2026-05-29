/**
 * POST /api/adjustments/walmart/sync
 *
 * Pulls every Walmart reconciliation report we don't already have and stores
 * each row in WalmartReconTransaction. Idempotent — the unique compound key
 * (transactionPostedTimestamp, purchaseOrderId, transactionType, amount)
 * deduplicates re-runs of the same date.
 *
 * Body (optional):
 *   { storeIndex?: number, maxDates?: number }
 *
 * If `maxDates` is set, only the N newest available dates are processed
 * (useful for first-time sync or a quick refresh of recent settlements).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartReportsApi } from "@/lib/walmart/reports";
import type { WalmartReconTransaction } from "@/lib/walmart/types";

/**
 * Decide whether a Walmart recon row represents a shipping adjustment
 * worth mirroring into ShippingAdjustment (the unified table the
 * /adjustments page reads from).
 *
 * Walmart's `transaction_type` values include Sales / Refunds /
 * Adjustments / Fees. The "Adjustments" bucket is what we want;
 * additionally we keep any fee row whose description names shipping
 * (e.g. "Shipping cost adjustment", "Label cost reconciliation").
 */
function isShippingAdjustment(tx: WalmartReconTransaction): boolean {
  const type = (tx.transactionType || "").toLowerCase();
  const desc = (tx.transactionDescription || "").toLowerCase();
  const fee = (tx.feeType || "").toLowerCase();
  if (type.includes("adjust")) return true;
  if (
    /ship|postage|carrier|weight|dimens/.test(desc) &&
    /adjust|chargeback|reweigh|reconcil/.test(desc)
  )
    return true;
  if (/ship|postage/.test(fee) && /adjust/.test(fee)) return true;
  return false;
}

/** Map a Walmart recon row into ShippingAdjustment create-data. */
function toShippingAdjustment(
  tx: WalmartReconTransaction,
  storeIndex: number
) {
  const ts = tx.transactionPostedTimestamp.toISOString();
  const amountCents = Math.round(tx.amount * 100);
  const externalId = `walmart:store${storeIndex}:${tx.transactionType}:${tx.purchaseOrderId ?? "none"}:${ts}:${amountCents}`;
  return {
    externalId,
    channel: "Walmart" as const,
    storeId: `walmart-store${storeIndex}`,
    currency: "USD",
    orderId: tx.purchaseOrderId ?? null,
    walmartOrderId: tx.purchaseOrderId ?? null,
    adjustmentDate: ts.slice(0, 10),
    adjustmentType: "WeightAdjustment", // best-effort; Walmart doesn't sub-classify
    rawType: tx.transactionDescription ?? tx.transactionType,
    adjustmentAmount: tx.amount,
    adjustmentReason: tx.transactionDescription ?? tx.transactionType,
    sku: tx.sku ?? null,
    productName: tx.productName ?? null,
  };
}

async function persistTransactions(
  reportDate: string,
  txs: WalmartReconTransaction[],
  storeIndex: number
): Promise<{
  inserted: number;
  skipped: number;
  adjustmentsInserted: number;
  adjustmentsEnriched: number;
}> {
  const reportDt = new Date(reportDate);
  let inserted = 0;
  let skipped = 0;
  let adjustmentsInserted = 0;
  let adjustmentsEnriched = 0;

  for (const tx of txs) {
    try {
      await prisma.walmartReconTransaction.create({
        data: {
          storeIndex,
          reportDate: reportDt,
          transactionPostedTimestamp: tx.transactionPostedTimestamp,
          transactionType: tx.transactionType,
          transactionDescription: tx.transactionDescription,
          purchaseOrderId: tx.purchaseOrderId,
          customerOrderId: tx.customerOrderId,
          sku: tx.sku,
          productName: tx.productName,
          quantity: tx.quantity,
          amount: tx.amount,
          feeType: tx.feeType,
          rawData: JSON.stringify(tx.raw),
        },
      });
      inserted++;
    } catch (err) {
      // Unique constraint = already-seen row (the dedup key matched)
      const msg = (err as Error).message;
      if (msg.includes("Unique") || msg.includes("UNIQUE")) {
        skipped++;
      } else {
        throw err;
      }
    }

    // Mirror shipping-adjustment rows into the unified table so the
    // /adjustments page picks them up alongside Amazon adjustments.
    if (isShippingAdjustment(tx)) {
      const data = toShippingAdjustment(tx, storeIndex);
      const result = await prisma.shippingAdjustment.upsert({
        where: { externalId: data.externalId },
        create: data,
        update: {
          sku: data.sku,
          productName: data.productName,
          adjustmentReason: data.adjustmentReason,
        },
      });
      if (Date.now() - result.createdAt.getTime() < 1500) {
        adjustmentsInserted++;
      } else {
        adjustmentsEnriched++;
      }
    }
  }

  return { inserted, skipped, adjustmentsInserted, adjustmentsEnriched };
}

export async function POST(request: NextRequest) {
  let body: { storeIndex?: number; maxDates?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }
  const storeIndex = body.storeIndex ?? 1;
  const maxDates = body.maxDates;

  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }

  const reports = new WalmartReportsApi(client);

  let dates: string[];
  try {
    dates = await reports.getAvailableReconReportDates();
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }

  if (maxDates) dates = dates.slice(0, maxDates);

  const summary: Array<{
    date: string;
    transactions: number;
    inserted: number;
    skipped: number;
    adjustmentsInserted: number;
    adjustmentsEnriched: number;
    error?: string;
  }> = [];

  for (const date of dates) {
    try {
      const txs = await reports.getFullReconReport(date);
      const {
        inserted,
        skipped,
        adjustmentsInserted,
        adjustmentsEnriched,
      } = await persistTransactions(date, txs, storeIndex);
      summary.push({
        date,
        transactions: txs.length,
        inserted,
        skipped,
        adjustmentsInserted,
        adjustmentsEnriched,
      });
    } catch (err) {
      const msg =
        err instanceof WalmartApiError
          ? `${err.status}: ${err.message}`
          : (err as Error).message;
      summary.push({
        date,
        transactions: 0,
        inserted: 0,
        skipped: 0,
        adjustmentsInserted: 0,
        adjustmentsEnriched: 0,
        error: msg.slice(0, 200),
      });
    }
  }

  const totalInserted = summary.reduce((s, r) => s + r.inserted, 0);
  const totalSkipped = summary.reduce((s, r) => s + r.skipped, 0);
  const totalAdjustmentsInserted = summary.reduce(
    (s, r) => s + r.adjustmentsInserted,
    0,
  );
  const totalAdjustmentsEnriched = summary.reduce(
    (s, r) => s + r.adjustmentsEnriched,
    0,
  );

  return NextResponse.json({
    ok: true,
    storeIndex,
    datesProcessed: summary.length,
    totalInserted,
    totalSkipped,
    totalAdjustmentsInserted,
    totalAdjustmentsEnriched,
    summary,
  });
}

export async function GET() {
  return NextResponse.json({
    description:
      "POST to sync Walmart reconciliation reports. Idempotent (dedupes on insert).",
    body: {
      storeIndex: "default 1",
      maxDates: "optional — limit to N newest report dates",
    },
  });
}
