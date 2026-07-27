// Personal credit cards — CRUD + portfolio totals (utilization, minimums, interest).
//   GET ?owner=        → cards (computed minPayment/utilization/monthlyInterest) + totals
//   POST               → create a card
//   PATCH { id, ... }  → update a card
//   DELETE ?id=        → remove a card

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cardTotals, minPayment, utilization, monthlyInterest } from "@/lib/finance/cards";

const num = (v: unknown) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const round2 = (n: number) => Math.round(n * 100) / 100;
const AUTOPAY = new Set(["none", "min", "statement", "full", "fixed"]);

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  const cards = await prisma.creditCard.findMany({
    where: { scope: "personal", ...(owner ? { owner } : {}) },
    orderBy: [{ active: "desc" }, { currentBalance: "desc" }],
  });
  const totals = cardTotals(cards);
  const enriched = cards.map((c) => ({
    ...c,
    minPayment: minPayment(c),
    utilization: utilization(c),
    monthlyInterest: monthlyInterest(c),
  }));
  return NextResponse.json({ cards: enriched, totals });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.issuer && !b.name) return NextResponse.json({ error: "issuer or name required" }, { status: 400 });
    const card = await prisma.creditCard.create({
      data: {
        scope: "personal",
        owner: b.owner ?? null,
        issuer: String(b.issuer ?? b.name),
        name: b.name ?? null,
        last4: b.last4 ?? null,
        creditLimit: num(b.creditLimit) ?? 0,
        currentBalance: num(b.currentBalance) ?? 0,
        statementBalance: num(b.statementBalance) ?? num(b.currentBalance) ?? 0,
        apr: num(b.apr) ?? null,
        minPaymentFixed: num(b.minPaymentFixed) ?? 0,
        minPaymentPct: num(b.minPaymentPct) ?? 0,
        statementDay: num(b.statementDay) ?? null,
        dueDay: num(b.dueDay) ?? null,
        autopay: AUTOPAY.has(b.autopay) ? b.autopay : "none",
        autopayAmount: num(b.autopayAmount) ?? null,
        fundId: b.fundId ?? null,
        notes: b.notes ?? null,
      },
    });
    return NextResponse.json({ ok: true, card });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const data: Record<string, unknown> = {};
    for (const k of ["owner", "issuer", "name", "last4", "notes", "fundId"]) if (b[k] !== undefined) data[k] = b[k] === "" ? null : b[k];
    for (const k of ["creditLimit", "currentBalance", "statementBalance", "minPaymentFixed", "minPaymentPct"]) {
      if (b[k] !== undefined) data[k] = round2(num(b[k]) ?? 0);
    }
    for (const k of ["apr", "statementDay", "dueDay", "autopayAmount"]) {
      if (b[k] !== undefined) data[k] = b[k] === null || b[k] === "" ? null : num(b[k]) ?? null;
    }
    if (b.autopay !== undefined) data.autopay = AUTOPAY.has(b.autopay) ? b.autopay : "none";
    if (b.active != null) data.active = Boolean(b.active);
    const card = await prisma.creditCard.update({ where: { id: b.id }, data });
    return NextResponse.json({ ok: true, card });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.cardEntry.deleteMany({ where: { cardId: id } });
  await prisma.creditCard.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
