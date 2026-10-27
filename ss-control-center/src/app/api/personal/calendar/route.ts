// Personal payment calendar — every upcoming due date (cards + bills + loans + dated
// events) in one timeline, so nothing is missed. GET ?window=60 → entries sorted by date,
// plus what is ALREADY late (`overdue`) and payments with no fixed date (`undated`).
//
// Debts come from both pools (a business-plan debt is still the owner's payment).
// A card/debt with a known next due date skips earlier occurrences; a dated
// payment event replaces that day's minimum (BJ's full statement).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";
import { buildPersonalCalendar } from "@/lib/finance/personal-calendar";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const windowDays = Math.min(120, Math.max(7, Number(req.nextUrl.searchParams.get("window") ?? "60") || 60));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [cards, bills, loans, events] = await Promise.all([
    prisma.creditCard.findMany({ where: { scope: "personal", active: true } }),
    prisma.recurringExpense.findMany({ where: { scope: "personal", active: true } }),
    prisma.debt.findMany({ where: { status: "open" } }),
    // Keep unresolved events regardless of age and completed replacements so
    // their minimums remain suppressed. Cancelled events restore the minimum.
    prisma.obligationEvent.findMany({ where: { scope: "personal", status: { not: "cancelled" } } }),
  ]);
  return NextResponse.json(buildPersonalCalendar({ cards, bills, loans, events }, today, windowDays));
}
