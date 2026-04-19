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

async function persistTransactions(
  reportDate: string,
  txs: WalmartReconTransaction[],
  storeIndex: number
): Promise<{ inserted: number; skipped: number }> {
  const reportDt = new Date(reportDate);
  let inserted = 0;
  let skipped = 0;

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
  }

  return { inserted, skipped };
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
    error?: string;
  }> = [];

  for (const date of dates) {
    try {
      const txs = await reports.getFullReconReport(date);
      const { inserted, skipped } = await persistTransactions(
        date,
        txs,
        storeIndex
      );
      summary.push({ date, transactions: txs.length, inserted, skipped });
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
        error: msg.slice(0, 200),
      });
    }
  }

  const totalInserted = summary.reduce((s, r) => s + r.inserted, 0);
  const totalSkipped = summary.reduce((s, r) => s + r.skipped, 0);

  return NextResponse.json({
    ok: true,
    storeIndex,
    datesProcessed: summary.length,
    totalInserted,
    totalSkipped,
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
