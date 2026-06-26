// One credit card: ledger + actions.
//   GET                                   → { card, entries }
//   POST { kind:"payment", amount, fundId? } → pay the card (debit a fund, lower balance)
//   POST { kind:"charge",  amount, description } → a new charge (raise balance)
//   POST { kind:"interest"|"fee", amount }       → interest/fee (raise balance)
//   POST { kind:"undo", entryId }                → reverse a ledger entry (refund a payment)

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CREDIT_CARDS_FUND } from "@/lib/finance/personal";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await prisma.creditCard.findUnique({ where: { id } });
  if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
  const entries = await prisma.cardEntry.findMany({ where: { cardId: id }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ card, entries });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await prisma.creditCard.findUnique({ where: { id } });
  if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
  const label = card.name || card.issuer;
  try {
    const b = await req.json();
    const today = new Date().toISOString().slice(0, 10);

    // A payment: lower the balance (and the statement balance) and, if a fund is
    // given (default = the card's fund, else the "Credit Cards" fund), debit it.
    if (b.kind === "payment") {
      const amount = round2(Math.abs(Number(b.amount)));
      if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount required" }, { status: 400 });
      let fundId: string | null = b.fundId ?? card.fundId ?? null;
      if (!fundId) {
        const ccFund = await prisma.fund.findFirst({ where: { name: CREDIT_CARDS_FUND, scope: "personal" } });
        fundId = ccFund?.id ?? null;
      }
      let fundEntryId: string | null = null;
      if (fundId) {
        const fund = await prisma.fund.findUnique({ where: { id: fundId } });
        if (fund) {
          const entry = await prisma.fundEntry.create({
            data: { fundId: fund.id, type: "spend", amount: -amount, description: `Card payment: ${label}`, status: "applied" },
          });
          await prisma.fund.update({ where: { id: fund.id }, data: { balance: { decrement: amount } } });
          fundEntryId = entry.id;
        }
      }
      const cardEntry = await prisma.cardEntry.create({
        data: { cardId: id, type: "payment", amount: -amount, description: b.description ?? `Payment`, fundId, fundEntryId, date: b.date ?? today },
      });
      await prisma.creditCard.update({
        where: { id },
        data: {
          currentBalance: Math.max(0, round2(card.currentBalance - amount)),
          statementBalance: Math.max(0, round2(card.statementBalance - amount)),
        },
      });
      return NextResponse.json({ ok: true, entry: cardEntry });
    }

    // A charge / interest / fee: raise the balance, log the ledger row.
    if (b.kind === "charge" || b.kind === "interest" || b.kind === "fee") {
      const amount = round2(Math.abs(Number(b.amount)));
      if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount required" }, { status: 400 });
      const cardEntry = await prisma.cardEntry.create({
        data: { cardId: id, type: b.kind, amount, description: b.description ?? null, date: b.date ?? today },
      });
      await prisma.creditCard.update({ where: { id }, data: { currentBalance: round2(card.currentBalance + amount) } });
      return NextResponse.json({ ok: true, entry: cardEntry });
    }

    // Undo a ledger entry: reverse its balance effect, and refund the fund if it was a payment.
    if (b.kind === "undo") {
      const entry = await prisma.cardEntry.findUnique({ where: { id: b.entryId } });
      if (!entry || entry.cardId !== id) return NextResponse.json({ error: "entry not found" }, { status: 404 });
      // entry.amount is signed (− for payment, + for charge); reversing means subtract it.
      await prisma.creditCard.update({ where: { id }, data: { currentBalance: Math.max(0, round2(card.currentBalance - entry.amount)) } });
      if (entry.type === "payment" && entry.fundId && entry.fundEntryId) {
        await prisma.fund.update({ where: { id: entry.fundId }, data: { balance: { increment: Math.abs(entry.amount) } } });
        await prisma.fundEntry.delete({ where: { id: entry.fundEntryId } }).catch(() => {});
      }
      await prisma.cardEntry.delete({ where: { id: entry.id } });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
