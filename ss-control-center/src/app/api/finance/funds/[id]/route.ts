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
  return NextResponse.json({
    fund,
    entries,
    plannedTotal: round2(planned.reduce((s, e) => s + e.amount, 0)), // negative
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fund = await prisma.fund.findUnique({ where: { id } });
  if (!fund) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const b = await req.json();
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
      await prisma.fundEntry.update({ where: { id: entry.id }, data: { status: "applied" } });
      await prisma.fund.update({ where: { id }, data: { balance: { increment: entry.amount } } }); // amount negative
      return NextResponse.json({ ok: true });
    }
    if (b.action === "delete") {
      if (entry.status === "applied") {
        await prisma.fund.update({ where: { id }, data: { balance: { decrement: entry.amount } } }); // reverse
      }
      await prisma.fundEntry.delete({ where: { id: entry.id } });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
