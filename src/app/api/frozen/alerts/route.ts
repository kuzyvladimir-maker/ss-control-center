// GET /api/frozen/alerts — list predictive risk alerts.
//
// Query params:
//   status     — filter exact: pending | applied | ignored | resolved
//   min_level  — show only at-or-above this level (low/medium/high/critical)
//   limit      — cap (default 50)

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { LEVEL_ORDER } from "@/lib/frozen-analytics/rules-engine";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const status = sp.get("status") || undefined;
  const minLevel = sp.get("min_level");
  const limit = Math.min(parseInt(sp.get("limit") || "100", 10), 500);

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (minLevel) {
    const idx = LEVEL_ORDER.indexOf(minLevel as (typeof LEVEL_ORDER)[number]);
    if (idx >= 0) {
      where.riskLevel = { in: LEVEL_ORDER.slice(idx) };
    }
  }

  const alerts = await prisma.frozenRiskAlert.findMany({
    where,
    orderBy: [{ shipDate: "asc" }, { riskScore: "desc" }],
    take: limit,
  });

  return NextResponse.json({
    alerts: alerts.map((a) => ({
      ...a,
      triggeredRules: safeParseArray(a.triggeredRules),
      recommendations: safeParseArray(a.recommendations),
    })),
  });
}

function safeParseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
