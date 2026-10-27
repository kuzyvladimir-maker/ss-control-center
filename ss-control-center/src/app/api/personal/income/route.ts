// Personal income = the personal pool's "money in" (Payout, scope=personal).
//   GET                                   → recent income + totals
//   POST { action:"manual", amount, requestId, note? } → record income
//   POST { action:"draw", fromFundId, amount, requestId, note? } → FREE bridge:
//        debit business FREE AND record the same personal income atomically.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";
import { IncomeError, recordPersonalIncome } from "@/lib/finance/personal-income";
import { isFinanceWriteConflict } from "@/lib/finance/treasury";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const incomes = await prisma.payout.findMany({
    where: { scope: "personal" },
    orderBy: { depositDate: "desc" },
    take: 100,
  });
  const undistributed = incomes.filter((p) => !p.distributed);
  return NextResponse.json({
    incomes,
    totals: {
      count: incomes.length,
      undistributedCount: undistributed.length,
      undistributedNet: round2(undistributed.reduce((s, p) => s + p.netAmount, 0)),
      totalNet: round2(incomes.reduce((s, p) => s + p.netAmount, 0)),
    },
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const b = await req.json();
    const depositDate = b.depositDate ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    if (!["manual", "draw"].includes(b.action) || typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount <= 0
      || typeof b.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(b.requestId)
      || typeof depositDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(depositDate)
      || !Number.isFinite(Date.parse(depositDate)) || new Date(depositDate).toISOString().slice(0, 10) !== depositDate
      || (b.note != null && (typeof b.note !== "string" || b.note.length > 500))) {
      return NextResponse.json({ error: "Valid action, positive amount, request ID and date required" }, { status: 400 });
    }
    const result = await recordPersonalIncome({ action: b.action, amount: b.amount, requestId: b.requestId, depositDate, note: b.note?.trim() ?? "", fromFundId: b.fromFundId });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (isFinanceWriteConflict(e)) return NextResponse.json({ ok: false, error: "Another finance update is in progress. Retry this same income request." }, { status: 409 });
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: e instanceof IncomeError || e instanceof SyntaxError ? 400 : 500 });
  }
}
