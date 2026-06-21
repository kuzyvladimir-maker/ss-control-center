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
  const entries = await prisma.fundEntry.findMany({ where: { fundId: id }, orderBy: { createdAt: "desc" } });
  const planned = entries.filter((e) => e.status === "planned");
  // Recurring expense PRESETS for this fund = the expense items whose category
  // matches the fund name. They show inside the fund as payments to make.
  const presets = await prisma.recurringExpense.findMany({
    where: { category: fund.name, active: true }, orderBy: { name: "asc" },
  });
  return NextResponse.json({
    fund,
    entries,
    presets,
    plannedTotal: round2(planned.reduce((s, e) => s + e.amount, 0)), // negative
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fund = await prisma.fund.findUnique({ where: { id } });
  if (!fund) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const b = await req.json();

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
    // spend (debit) or deposit (credit) — applied immediately.
    const amount = kind === "deposit" ? round2(mag) : -round2(mag);
    const entry = await prisma.fundEntry.create({
      data: { fundId: id, type: kind === "deposit" ? "adjustment" : "spend", amount, description: b.description ?? null, status: "applied" },
    });
    await prisma.fund.update({ where: { id }, data: { balance: { increment: amount } } });
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
