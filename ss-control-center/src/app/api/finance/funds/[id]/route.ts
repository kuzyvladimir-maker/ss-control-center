// One fund's detail: balance + ledger (allocations, spends, planned expenses).
//   GET                      → { fund, entries }
//   POST  { kind, amount, description, dueDate }
//         kind = spend (debit now) | planned (debit when paid) | deposit (credit now)
//   PATCH { entryId, action } action = pay | delete

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function round2(n: number) { return Math.round(n * 100) / 100; }

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fund = await prisma.fund.findUnique({ where: { id } });
  if (!fund) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Read-only: meters advance once a day via /api/cron/finance-accrual (NOT on every
  // view — per-load writes caused SQLite write-lock contention and hung the app).
  const entries = await prisma.fundEntry.findMany({ where: { fundId: id }, orderBy: { createdAt: "desc" } });
  // The fund's expenses (= category) with their accrued (owed) amounts.
  const expenses = await prisma.recurringExpense.findMany({
    where: { category: fund.name, active: true }, orderBy: { name: "asc" },
  });
  // Owed (остаток) = accrued (начислено) − paid (выплачено), per expense.
  const owedTotal = round2(expenses.reduce((s, e) => s + Math.max(0, (e.accrued ?? 0) - (e.paid ?? 0)), 0));
  const accruedTotal = round2(expenses.reduce((s, e) => s + (e.accrued ?? 0), 0));
  const paidTotal = round2(expenses.reduce((s, e) => s + (e.paid ?? 0), 0));
  return NextResponse.json({ fund, entries, expenses, owedTotal, accruedTotal, paidTotal });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fund = await prisma.fund.findUnique({ where: { id } });
  if (!fund) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const b = await req.json();

    // Pay (part of) an expense's accrued meter → debit the fund, reduce accrued.
    if (b.kind === "pay_expense") {
      const exp = await prisma.recurringExpense.findUnique({ where: { id: b.expenseId } });
      if (!exp) return NextResponse.json({ error: "expense not found" }, { status: 404 });
      const amount = Math.abs(Number(b.amount));
      if (!Number.isFinite(amount) || amount === 0) return NextResponse.json({ error: "amount required" }, { status: 400 });
      // Atomic: ledger debit + fund balance + grow the expense's PAID (выплачено).
      // Owed (остаток) = accrued − paid, so paying raises `paid`, leaving accrued
      // (начислено, the running counter) intact.
      const [entry] = await prisma.$transaction([
        prisma.fundEntry.create({ data: { fundId: id, type: "spend", amount: -round2(amount), description: `${exp.name} (paid)`, status: "applied" } }),
        prisma.fund.update({ where: { id }, data: { balance: { decrement: round2(amount) } } }),
        prisma.recurringExpense.update({ where: { id: exp.id }, data: { paid: round2((exp.paid ?? 0) + amount) } }),
      ]);
      return NextResponse.json({ ok: true, entry });
    }

    // Generate unpaid bills from this fund's expense-item presets (per period).
    if (b.kind === "generate_bills") {
      const presets = await prisma.recurringExpense.findMany({ where: { category: fund.name, active: true } });
      const existing = await prisma.fundEntry.findMany({ where: { fundId: id, type: "planned_expense", status: "planned" } });
      const have = new Set(existing.map((e) => e.description));
      let created = 0;
      for (const p of presets) {
        if (have.has(p.name)) continue; // already an unpaid bill
        await prisma.fundEntry.create({ data: { fundId: id, type: "planned_expense", amount: -round2(p.amount), description: p.name, status: "planned" } });
        created++;
      }
      return NextResponse.json({ ok: true, created });
    }

    const mag = Math.abs(Number(b.amount));
    if (!Number.isFinite(mag) || mag === 0) return NextResponse.json({ error: "amount required" }, { status: 400 });
    const kind = b.kind === "planned" ? "planned" : b.kind === "deposit" ? "deposit" : "spend";

    if (kind === "planned") {
      // Debit that only hits the balance when marked paid.
      const entry = await prisma.fundEntry.create({
        data: { fundId: id, type: "planned_expense", amount: -round2(mag), description: b.description ?? null, status: "planned", dueDate: b.dueDate ?? null },
      });
      return NextResponse.json({ ok: true, entry });
    }
    // spend (debit) or deposit (credit) — applied immediately, atomically.
    const amount = kind === "deposit" ? round2(mag) : -round2(mag);
    const [entry] = await prisma.$transaction([
      prisma.fundEntry.create({ data: { fundId: id, type: kind === "deposit" ? "adjustment" : "spend", amount, description: b.description ?? null, status: "applied" } }),
      prisma.fund.update({ where: { id }, data: { balance: { increment: amount } } }),
    ]);
    return NextResponse.json({ ok: true, entry });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const b = await req.json();
    const entry = await prisma.fundEntry.findUnique({ where: { id: b.entryId } });
    if (!entry || entry.fundId !== id) return NextResponse.json({ error: "entry not found" }, { status: 404 });

    if (b.action === "pay") {
      if (entry.status !== "planned") return NextResponse.json({ error: "not a planned entry" }, { status: 400 });
      // Optionally override the amount actually paid (e.g. biweekly salary total).
      const amount = b.amount != null ? -Math.abs(round2(Number(b.amount))) : entry.amount;
      await prisma.fundEntry.update({ where: { id: entry.id }, data: { status: "applied", amount } });
      await prisma.fund.update({ where: { id }, data: { balance: { increment: amount } } }); // negative → debits
      return NextResponse.json({ ok: true });
    }
    if (b.action === "unpay") {
      if (entry.status !== "applied") return NextResponse.json({ error: "not a paid entry" }, { status: 400 });
      await prisma.fundEntry.update({ where: { id: entry.id }, data: { status: "planned" } });
      await prisma.fund.update({ where: { id }, data: { balance: { decrement: entry.amount } } }); // reverse the debit
      return NextResponse.json({ ok: true });
    }
    // Manual edit of a ledger row (description and/or amount). For an already-applied
    // entry, changing the amount adjusts the fund balance by the delta.
    if (b.action === "edit") {
      const data: Record<string, unknown> = {};
      if (b.description !== undefined) data.description = b.description;
      if (b.amount != null && Number.isFinite(Number(b.amount))) {
        const newAmount = round2(Number(b.amount));
        data.amount = newAmount;
        if (entry.status === "applied") {
          const delta = round2(newAmount - entry.amount);
          if (delta !== 0) await prisma.fund.update({ where: { id }, data: { balance: { increment: delta } } });
        }
      }
      await prisma.fundEntry.update({ where: { id: entry.id }, data });
      return NextResponse.json({ ok: true });
    }
    if (b.action === "delete") {
      if (entry.status === "applied") {
        await prisma.fund.update({ where: { id }, data: { balance: { decrement: entry.amount } } }); // reverse
      }
      // Unlink any receipt (keep the image; allow re-filing later).
      await prisma.receipt.updateMany({ where: { fundEntryId: entry.id }, data: { fundEntryId: null, fundId: null, status: "parsed" } });
      await prisma.fundEntry.delete({ where: { id: entry.id } });
      return NextResponse.json({ ok: true });
    }
    // Move a spend/adjustment to another fund (e.g. logged on the wrong fund).
    if (b.action === "move") {
      const target = await prisma.fund.findUnique({ where: { id: b.targetFundId } });
      if (!target) return NextResponse.json({ error: "target fund not found" }, { status: 404 });
      if (target.id === id) return NextResponse.json({ ok: true }); // no-op
      if (entry.status === "applied") {
        await prisma.fund.update({ where: { id }, data: { balance: { decrement: entry.amount } } }); // remove here
      }
      const moved = await prisma.fundEntry.create({
        data: { fundId: target.id, type: entry.type, amount: entry.amount, description: entry.description, status: entry.status, dueDate: entry.dueDate },
      });
      if (entry.status === "applied") {
        await prisma.fund.update({ where: { id: target.id }, data: { balance: { increment: entry.amount } } }); // add there
      }
      await prisma.receipt.updateMany({ where: { fundEntryId: entry.id }, data: { fundId: target.id, fundEntryId: moved.id } });
      await prisma.fundEntry.delete({ where: { id: entry.id } });
      return NextResponse.json({ ok: true, movedTo: target.id });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
