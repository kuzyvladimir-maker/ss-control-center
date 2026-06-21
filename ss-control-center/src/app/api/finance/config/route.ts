// Finance reserve config (Setting-backed). GET current, POST to update.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DEFAULT_MANUAL_PCT, DEFAULT_WINDOW_WEEKS } from "@/lib/finance/reserve-rate";

const K = {
  method: "finance:reserve:method",
  manualPct: "finance:reserve:manualPct",
  windowWeeks: "finance:reserve:windowWeeks",
  taxRatePct: "finance:taxRatePct", // tax set-aside as % of sales turnover
};
const DEFAULT_TAX_RATE_PCT = 1;

async function get(key: string) {
  return (await prisma.setting.findUnique({ where: { key } }))?.value ?? null;
}
async function set(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export async function GET() {
  const manual = Number(await get(K.manualPct));
  const ww = Number(await get(K.windowWeeks));
  const tax = Number(await get(K.taxRatePct));
  return NextResponse.json({
    method: (await get(K.method)) === "auto" ? "auto" : "manual",
    manualPct: Number.isFinite(manual) && manual > 0 ? manual : DEFAULT_MANUAL_PCT,
    windowWeeks: Number.isFinite(ww) && ww > 0 ? ww : DEFAULT_WINDOW_WEEKS,
    taxRatePct: Number.isFinite(tax) && tax >= 0 ? tax : DEFAULT_TAX_RATE_PCT,
  });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (b.method === "manual" || b.method === "auto") await set(K.method, b.method);
    if (b.manualPct != null) {
      const p = Math.max(0, Math.min(1, Number(b.manualPct)));
      await set(K.manualPct, String(p));
    }
    if (b.windowWeeks != null) await set(K.windowWeeks, String(Math.max(1, Number(b.windowWeeks))));
    if (b.taxRatePct != null) await set(K.taxRatePct, String(Math.max(0, Number(b.taxRatePct))));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
