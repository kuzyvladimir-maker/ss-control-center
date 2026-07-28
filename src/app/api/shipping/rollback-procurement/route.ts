// POST /api/shipping/rollback-procurement
//
// Body: { orderId: string }
//
// Pops the order back to a pre-procurement state — all bought line items
// reset, the `Placed` tag stripped — so the order shows up again in
// Procurement for a re-buy. Used when the supplier failed to deliver
// and the operator needs to source the product again. The already-
// purchased shipping label is intentionally left intact (the operator
// will reuse it once the product is back in hand).

import { NextRequest, NextResponse } from "next/server";
import { rollbackOrderProcurement } from "@/lib/procurement/rollback-order";

export const dynamic = "force-dynamic";

interface Body {
  orderId?: string;
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body is fine; we'll fall back to querystring
  }

  const orderId =
    body.orderId ?? new URL(req.url).searchParams.get("orderId") ?? "";
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  try {
    const result = await rollbackOrderProcurement(orderId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[shipping/rollback-procurement]", { orderId, error: e });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
