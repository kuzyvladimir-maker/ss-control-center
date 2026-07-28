/**
 * POST /api/shipping/mark-placed
 *
 * Quick "skip Procurement" button on the Shipping page — adds the Placed
 * tag to a Veeqo order so it advances from waiting_placed to ready_to_buy
 * without making Vladimir go to /procurement first.
 *
 * Use cases:
 *   * Merged orders — Veeqo creates a NEW order on merge without copying
 *     the source orders' Placed tag, so merged rows are stuck at
 *     "Waiting for procurement" even though every component was already
 *     procured. One click here un-sticks them.
 *   * Shopify / NAN / other channels that aren't sourced from suppliers
 *     (Vladimir holds the stock or buys per-order independently of the
 *     Procurement queue). No need to drive them through /procurement —
 *     mark them Placed here and they go straight to buy-label.
 *
 * Body: { orderId: string | number }
 */
import { NextRequest, NextResponse } from "next/server";
import { addTagToOrder, PROCUREMENT_TAGS } from "@/lib/veeqo/tags";

export async function POST(request: NextRequest) {
  let body: { orderId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const raw = body.orderId;
  const orderId =
    typeof raw === "number" || typeof raw === "string" ? raw : null;
  if (!orderId) {
    return NextResponse.json(
      { error: "orderId is required (string or number)" },
      { status: 400 },
    );
  }
  try {
    await addTagToOrder(orderId, PROCUREMENT_TAGS.PLACED);
    return NextResponse.json({ ok: true, orderId, tag: PROCUREMENT_TAGS.PLACED });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[mark-placed]", orderId, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
