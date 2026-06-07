/**
 * POST /api/procurement/inquiry-status
 *
 * Body:  { orderNumbers: string[] }   // Walmart customerOrderIds
 * Returns: { results: { [orderNumber]: QuantityInquiryFlag } }
 *
 * The /procurement page calls this in parallel with /api/procurement/items
 * (like the cancellation sweep) so each card can show whether a quantity
 * clarification has been sent to the buyer and whether they've replied. Keyed
 * by customerOrderId so the client can match it to the order header.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export interface QuantityInquiryFlag {
  status: string; // SENT | ANSWERED | TIMEOUT
  sentAt: string;
  repliedAt: string | null;
  replyText: string | null;
  productTitle: string | null;
  orderedQty: number | null;
  totalUnits: number | null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const raw = Array.isArray(body?.orderNumbers) ? body.orderNumbers : [];
    const orderNumbers: string[] = raw
      .map((v: unknown) => String(v ?? "").trim())
      .filter(Boolean);

    if (orderNumbers.length === 0) {
      return NextResponse.json({ results: {} });
    }

    const rows = await prisma.walmartCustomerInquiry.findMany({
      where: { customerOrderId: { in: orderNumbers } },
      select: {
        customerOrderId: true,
        status: true,
        sentAt: true,
        repliedAt: true,
        replyText: true,
        productTitle: true,
        orderedQty: true,
        totalUnits: true,
      },
    });

    const results: Record<string, QuantityInquiryFlag> = {};
    for (const r of rows) {
      if (!r.customerOrderId) continue;
      results[r.customerOrderId] = {
        status: r.status,
        sentAt: r.sentAt.toISOString(),
        repliedAt: r.repliedAt ? r.repliedAt.toISOString() : null,
        replyText: r.replyText,
        productTitle: r.productTitle,
        orderedQty: r.orderedQty,
        totalUnits: r.totalUnits,
      };
    }

    return NextResponse.json({ results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/inquiry-status] error", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
