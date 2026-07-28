// Recurring expenses (OpEx master list). The categories are the FP1 funds.
//   GET                         → { expenses, byCategory:[{category,monthly}], monthlyTotal }
//   POST { name, category, amount, frequency, ... }   → create
//   POST ?import=1 { csv }                            → bulk import a Sellerboard CSV
//   PATCH { id, ...fields }                           → edit
//   DELETE ?id=                                       → remove

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { monthlyAmount, parseSellerboardExpensesCsv, EXPENSE_CATEGORIES } from "@/lib/finance/expenses";
import { scopeOf, type Scope } from "@/lib/finance/scope";
import { personalFundPriority } from "@/lib/finance/personal";

/** Ensure an FP1 fund exists for each given category (so expenses map to funds). */
async function ensureCategoryFunds(categories: string[], scope: Scope) {
  for (const name of [...new Set(categories)]) {
    if (!name) continue;
    const existing = await prisma.fund.findFirst({ where: { name, group: "FP1", scope } });
    if (!existing) {
      const order = EXPENSE_CATEGORIES.indexOf(name as (typeof EXPENSE_CATEGORIES)[number]);
      const priority = scope === "personal" ? personalFundPriority(name) : 10 + (order < 0 ? 9 : order);
      await prisma.fund.create({
        data: { scope, name, group: "FP1", allocationType: "percent", value: 0, priority, active: true },
      });
    }
  }
}

async function summary(scope: Scope) {
  const expenses = await prisma.recurringExpense.findMany({ where: { scope }, orderBy: [{ category: "asc" }, { name: "asc" }] });
  const byCat = new Map<string, number>();
  for (const e of expenses) {
    if (!e.active) continue;
    byCat.set(e.category, Math.round(((byCat.get(e.category) ?? 0) + monthlyAmount(e.amount, e.frequency)) * 100) / 100);
  }
  const byCategory = [...byCat.entries()].map(([category, monthly]) => ({ category, monthly }));
  const monthlyTotal = Math.round(byCategory.reduce((s, c) => s + c.monthly, 0) * 100) / 100;
  return { expenses, byCategory, monthlyTotal };
}

export async function GET(req: NextRequest) {
  return NextResponse.json(await summary(scopeOf(req)));
}

export async function POST(req: NextRequest) {
  try {
    const scope = scopeOf(req);
    const b = await req.json();
    if (req.nextUrl.searchParams.get("import") === "1") {
      // Sellerboard import is business-only.
      const rows = parseSellerboardExpensesCsv(String(b.csv ?? ""));
      if (!rows.length) return NextResponse.json({ error: "no rows parsed" }, { status: 400 });
      await ensureCategoryFunds(rows.map((r) => r.category), "business");
      let created = 0;
      for (const r of rows) {
        // Upsert-by-name: replace amount/frequency if the expense already exists.
        const existing = await prisma.recurringExpense.findFirst({ where: { name: r.name, category: r.category, scope: "business" } });
        if (existing) {
          await prisma.recurringExpense.update({ where: { id: existing.id }, data: { amount: r.amount, frequency: r.frequency, marketplace: r.marketplace, product: r.product, isAdSpend: r.isAdSpend } });
        } else {
          await prisma.recurringExpense.create({ data: { ...r, scope: "business", source: "sellerboard" } });
          created++;
        }
      }
      return NextResponse.json({ ok: true, parsed: rows.length, created });
    }

    if (!b.name || !b.category) return NextResponse.json({ error: "name + category required" }, { status: 400 });
    await ensureCategoryFunds([b.category], scope);
    const expense = await prisma.recurringExpense.create({
      data: {
        scope, name: String(b.name), category: String(b.category), amount: Number(b.amount) || 0,
        frequency: ["monthly", "weekly", "daily", "yearly", "one_time"].includes(b.frequency) ? b.frequency : "monthly",
        owner: b.owner ?? null, dueDay: b.dueDay != null && b.dueDay !== "" ? Number(b.dueDay) : null,
        marketplace: b.marketplace ?? null, product: b.product ?? null,
        isAdSpend: Boolean(b.isAdSpend), source: "manual", notes: b.notes ?? null,
      },
    });
    return NextResponse.json({ ok: true, expense });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const data: Record<string, unknown> = {};
    for (const k of ["name", "category", "marketplace", "product", "notes", "owner"]) if (b[k] != null) data[k] = b[k];
    if (b.amount != null) data.amount = Number(b.amount) || 0;
    if (b.dueDay !== undefined) data.dueDay = b.dueDay === null || b.dueDay === "" ? null : Number(b.dueDay);
    if (b.frequency && ["monthly", "weekly", "daily", "yearly", "one_time"].includes(b.frequency)) data.frequency = b.frequency;
    // Manual balance override (start-of-plan alignment): set начислено / выплачено.
    if (b.accrued != null) data.accrued = Math.max(0, Math.round(Number(b.accrued) * 100) / 100);
    if (b.paid != null) data.paid = Math.max(0, Math.round(Number(b.paid) * 100) / 100);
    if (b.active != null) data.active = Boolean(b.active);
    if (b.isAdSpend != null) data.isAdSpend = Boolean(b.isAdSpend);
    if (b.category) await ensureCategoryFunds([b.category], scopeOf(req));
    const expense = await prisma.recurringExpense.update({ where: { id: b.id }, data });
    return NextResponse.json({ ok: true, expense });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.recurringExpense.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
