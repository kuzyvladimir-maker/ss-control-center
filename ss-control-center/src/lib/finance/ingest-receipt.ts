// Email-receipt ingest (Jackie's spec). Takes a parsed purchase/refund record from a
// store confirmation email and lands it in the Restock reserve fund:
//   business purchase → spend (debit)   ·   business refund → credit
//   home purchase     → recorded for audit, NO fund movement
//   unknown / low confidence → recorded as "review", NO fund movement (human approves)
// Deduplicated by (channel + order_id) so the many emails of one order ingest once.

import { prisma } from "@/lib/prisma";

const round2 = (n: number) => Math.round(n * 100) / 100;
export const RESTOCK_FUND_NAME = "Restock reserve";

export interface ReceiptRecord {
  store: string;
  channel: string;
  type: "purchase" | "refund";
  classification: "business" | "home" | "unknown";
  order_id?: string | null;
  date?: string | null;
  amount: number; // + purchase, − refund
  currency?: string;
  ship_to?: string;
  source_inbox?: string;
  email_id?: string;
  confidence?: number;
  subject?: string;
}

export type IngestStatus = "ingested" | "duplicate" | "home_skipped" | "review" | "error";

export async function ingestReceipt(r: ReceiptRecord): Promise<{ status: IngestStatus; reason?: string; receiptId?: string; amount?: number }> {
  if (!Number.isFinite(r.amount) || r.amount === 0) return { status: "error", reason: "no amount" };

  // Dedup: one order has many emails (confirmed/shipped/delivered) — ingest once.
  if (r.order_id) {
    const dup = await prisma.receipt.findFirst({ where: { channel: r.channel, orderId: r.order_id } });
    if (dup) return { status: "duplicate", receiptId: dup.id };
  }

  const base = {
    imageUrl: `gmail:${r.email_id ?? "?"}`,
    merchant: r.store,
    total: round2(r.amount),
    date: r.date ?? null,
    currency: r.currency ?? "USD",
    channel: r.channel,
    orderId: r.order_id ?? null,
    classification: r.classification,
    sourceInbox: r.source_inbox ?? null,
    emailId: r.email_id ?? null,
    rawText: JSON.stringify(r),
    notes: r.subject ?? null,
  };

  // HOME purchase — not a business cost. Record for audit, no fund movement.
  if (r.classification === "home") {
    const receipt = await prisma.receipt.create({ data: { ...base, status: "home" } });
    return { status: "home_skipped", receiptId: receipt.id };
  }
  // Unknown / low confidence — needs a human to confirm before it touches the fund.
  if (r.classification === "unknown" || (r.confidence ?? 1) < 0.5) {
    const receipt = await prisma.receipt.create({ data: { ...base, status: "review" } });
    return { status: "review", receiptId: receipt.id };
  }

  // Business: purchase debits the Restock reserve, refund credits it.
  const fund = await prisma.fund.findFirst({ where: { name: RESTOCK_FUND_NAME } });
  if (!fund) return { status: "error", reason: "Restock reserve fund not found" };

  const isRefund = r.type === "refund";
  const mag = round2(Math.abs(r.amount));
  const signed = isRefund ? mag : -mag; // refund → +credit, purchase → −debit
  const desc = `${r.store}${r.order_id ? ` #${r.order_id}` : ""}${isRefund ? " (refund)" : ""}`;

  const [entry, receipt] = await prisma.$transaction([
    prisma.fundEntry.create({ data: { fundId: fund.id, type: isRefund ? "adjustment" : "spend", amount: signed, description: desc, status: "applied" } }),
    prisma.receipt.create({ data: { ...base, status: isRefund ? "refund" : "saved", fundId: fund.id } }),
    prisma.fund.update({ where: { id: fund.id }, data: { balance: { increment: signed } } }),
  ]);
  await prisma.receipt.update({ where: { id: receipt.id }, data: { fundEntryId: entry.id } });
  return { status: "ingested", receiptId: receipt.id, amount: signed };
}
