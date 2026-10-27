import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireModuleAccess } from "@/lib/auth-server";
import { getTreasuryConfig } from "@/lib/finance/treasury-config";
import { isRate, TREASURY_KEY, type TreasurySettings } from "@/lib/finance/treasury";

export async function GET(req: NextRequest) {
  const auth = await requireModuleAccess(req, "finance");
  if (auth instanceof NextResponse) return auth;
  const config = await getTreasuryConfig();
  return NextResponse.json({ ...config, method: "manual", manualPct: config.grossMargin.rate == null ? null : 1 - config.grossMargin.rate, windowWeeks: 4 });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  if ((b.grossMargin !== undefined && (!b.grossMargin || b.grossMargin.source !== "constant" || !isRate(b.grossMargin.rate)))
    || (b.manualPct !== undefined && !isRate(b.manualPct))
    || (b.grossMargin !== undefined && b.manualPct !== undefined)
    || (b.personalShare !== undefined && b.personalShare !== null && !isRate(b.personalShare))
    || (b.method !== undefined && b.method !== "manual")
    || (b.taxRatePct !== undefined && (typeof b.taxRatePct !== "number" || !Number.isFinite(b.taxRatePct) || b.taxRatePct < 0 || b.taxRatePct > 100))) {
    return NextResponse.json({ error: "Use a constant gross margin and a personal share between 0% and 100%. Economics is not connected yet." }, { status: 400 });
  }
  await prisma.$transaction(async (tx) => {
    const current = await getTreasuryConfig(tx);
    const settings: TreasurySettings = {
      updatedAt: new Date().toISOString(),
      grossMargin: b.grossMargin ?? (b.manualPct !== undefined ? { source: "constant", rate: 1 - b.manualPct } : { source: current.grossMargin.source, rate: current.grossMargin.rate }),
      personalShare: b.personalShare !== undefined ? b.personalShare : current.personalShare,
    };
    await tx.setting.upsert({ where: { key: TREASURY_KEY }, create: { key: TREASURY_KEY, value: JSON.stringify(settings) }, update: { value: JSON.stringify(settings) } });
    if (b.taxRatePct !== undefined) await tx.setting.upsert({ where: { key: "finance:taxRatePct" }, create: { key: "finance:taxRatePct", value: String(b.taxRatePct) }, update: { value: String(b.taxRatePct) } });
  });
  return NextResponse.json({ ok: true, ...await getTreasuryConfig() });
}
