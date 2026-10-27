// Shared finance routes also serve personal records. A business Finance grant
// must never authorize a personal row merely because its ID was supplied.
import { NextRequest, NextResponse } from "next/server";
import { requireModuleAccess } from "@/lib/auth-server";
import { prisma } from "@/lib/prisma";

export async function requireFinanceAccess(req: NextRequest): Promise<NextResponse | null> {
  const auth = await requireModuleAccess(req, "finance");
  if (auth instanceof NextResponse) return auth;
  if (auth.isAdmin) return null;
  const denied = () => NextResponse.json({ error: "Owner access required for personal finance" }, { status: 403 });
  if (req.nextUrl.searchParams.get("scope") === "personal") return denied();
  const body = req.method === "GET" || req.method === "DELETE" ? {} : await req.clone().json().catch(() => ({}));
  const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const pathname = req.nextUrl.pathname;
  const funds: unknown[] = [b.fundId, b.fromFundId, b.toFundId, b.targetFundId, req.nextUrl.searchParams.get("fundId")];
  const expenses: unknown[] = [b.expenseId];
  const debts: unknown[] = [b.debtId];
  const receipts: unknown[] = [b.receiptId];
  const id = b.id ?? req.nextUrl.searchParams.get("id");
  if (pathname === "/api/finance/funds") funds.push(id);
  if (pathname === "/api/finance/expenses") expenses.push(id);
  if (pathname === "/api/finance/debts") debts.push(id);
  const fundPath = pathname.match(/^\/api\/finance\/funds\/([^/]+)$/)?.[1];
  if (fundPath && !["history", "needs", "auto-allocate", "transfer"].includes(fundPath)) funds.push(decodeURIComponent(fundPath));
  const strings = (values: unknown[]) => [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];
  const rows = await Promise.all([
    ...strings(funds).map((id) => prisma.fund.findUnique({ where: { id }, select: { scope: true } })),
    ...strings(expenses).map((id) => prisma.recurringExpense.findUnique({ where: { id }, select: { scope: true } })),
    ...strings(debts).map((id) => prisma.debt.findUnique({ where: { id }, select: { scope: true } })),
    ...strings(receipts).map((id) => prisma.receipt.findUnique({ where: { id }, select: { scope: true } })),
  ]);
  return rows.some((r) => r?.scope === "personal") ? denied() : null;
}
