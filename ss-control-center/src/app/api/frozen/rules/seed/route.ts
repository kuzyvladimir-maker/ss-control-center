// POST /api/frozen/rules/seed
//
// Idempotent: upserts the default rule set. Existing rows are NOT clobbered
// (we use `create: ..., update: {}`) so any tuning Vladimir has applied via
// PUT /api/frozen/rules survives a re-seed. Run once after a migration deploy
// (or never — the rules engine just returns "ok" when the table is empty,
// which is degraded but not broken).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DEFAULT_RULES } from "@/lib/frozen-analytics/default-rules";

// Auth: handled by /api/* middleware (session cookie OR SSCC_API_TOKEN).
export async function POST() {
  let created = 0;
  for (const r of DEFAULT_RULES) {
    const existing = await prisma.frozenRule.findUnique({
      where: { ruleCode: r.ruleCode },
    });
    if (existing) continue;
    await prisma.frozenRule.create({
      data: {
        ruleCode: r.ruleCode,
        ruleType: r.ruleType,
        description: r.description,
        conditions: JSON.stringify(r.conditions),
        riskLevel: r.riskLevel ?? null,
        modifier: r.modifier ?? null,
        recommendation: r.recommendation,
        priority: r.priority,
      },
    });
    created++;
  }

  return NextResponse.json({
    ok: true,
    created,
    skippedExisting: DEFAULT_RULES.length - created,
  });
}
