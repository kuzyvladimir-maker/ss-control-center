// Daily Finance accrual cron: tick every fund's owed-debt meter (recurring expenses
// + installment debts) up to today, so the per-fund debt grows even on days nobody
// opens the app. Idempotent (keyed on lastAccruedDate). Gate with CRON_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { accrueCategory, accrueInstallments } from "@/lib/finance/accrual";

export const maxDuration = 120;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev: no gate
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const expenses = await accrueCategory(null, today);
    const installments = await accrueInstallments(today);
    return NextResponse.json({ ok: true, today, accrued: { expenses, installments } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
