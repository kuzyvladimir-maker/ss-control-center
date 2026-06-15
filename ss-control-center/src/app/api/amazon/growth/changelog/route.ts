/**
 * GET /api/amazon/growth/changelog
 *
 * The audit trail of every Amazon listing write we made: what, when, source,
 * before→after values + metrics, and the measured outcome (useful/neutral/
 * harmful). Powers the Change Log view + rollback.
 *
 * Query: storeIndex, sku?, outcome? (useful|neutral|harmful|pending),
 *        source? (optimizer|advisor|bulk|manual), limit (50, max 200), offset.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

function safe(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const sku = (sp.get("sku") ?? "").trim();
  const outcome = sp.get("outcome");
  const source = sp.get("source");
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);
  const offset = Number(sp.get("offset") ?? 0);

  const where: Prisma.AmazonChangeLogWhereInput = { storeIndex };
  if (sku) where.sku = { contains: sku };
  if (source) where.source = source;
  if (outcome === "pending") where.afterMeasuredAt = null;
  else if (outcome) where.outcome = outcome;

  const [total, rows, useful, neutral, harmful, pending, agg] = await Promise.all([
    prisma.amazonChangeLog.count({ where }),
    prisma.amazonChangeLog.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.amazonChangeLog.count({ where: { storeIndex, outcome: "useful" } }),
    prisma.amazonChangeLog.count({ where: { storeIndex, outcome: "neutral" } }),
    prisma.amazonChangeLog.count({ where: { storeIndex, outcome: "harmful" } }),
    prisma.amazonChangeLog.count({ where: { storeIndex, afterMeasuredAt: null } }),
    prisma.amazonChangeLog.count({ where: { storeIndex } }),
  ]);

  return NextResponse.json({
    storeIndex,
    summary: { total: agg, useful, neutral, harmful, pending },
    changes: rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      asin: r.asin,
      itemName: r.itemName,
      source: r.source,
      changeType: r.changeType,
      field: r.field,
      beforeValue: safe(r.beforeValue),
      afterValue: safe(r.afterValue),
      amazonStatus: r.amazonStatus,
      beforeHealthScore: r.beforeHealthScore,
      afterHealthScore: r.afterHealthScore,
      beforeConversion: r.beforeConversion,
      afterConversion: r.afterConversion,
      beforeErrorCount: r.beforeErrorCount,
      afterErrorCount: r.afterErrorCount,
      outcome: r.outcome,
      rolledBack: r.rolledBack,
      createdAt: r.createdAt,
      afterMeasuredAt: r.afterMeasuredAt,
      canRollback: r.changeType === "attribute-set" && !r.rolledBack,
    })),
    worklist: { total, limit, offset },
  });
}
