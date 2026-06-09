// Refund (cancel) a Veeqo shipment for an order. Used by the Discard
// Label button on Shipping Labels when an Amazon order has its label
// already bought but needs to be cancelled (customer changed their
// mind, supplier failure, etc.).
//
// Mechanism:
//   1. GET /orders/{orderId} → walk allocations[] for the most recent
//      shipment id.
//   2. DELETE /shipments/{id} — Veeqo's documented "delete shipment" path.
//      Verified live 2026-06-09 (buy + immediate cancel on order
//      114-5911171-5223451): returns 200 with the order body and flips the
//      order back to `awaiting_fulfillment` with the shipment removed. If
//      billed through Veeqo, within 14 days, label unused → auto-triggers a
//      carrier refund request (FedEx/UPS/Amazon Buy Shipping), ~24-72h.
//
//      Endpoint gotchas confirmed during that debugging session:
//        - `POST /shipping/shipments/{id}/refund` (the old code) does NOT
//          exist → every call 404'd ({"status":404,"error":"Not Found"}),
//          so Discard Label never worked for Amazon orders.
//        - `DELETE /shipping/shipments/{id}` also 404s — `/shipping/shipments`
//          only accepts the POST that *buys* a label, not a DELETE.
//        - `GET /shipments/{id}` returns 404 (the resource implements DELETE
//          but not GET), which is misleading — don't probe with GET and
//          conclude the collection is unmounted. DELETE is what's wired up.
//
// On success Veeqo flips the order's status back from `shipped` to
// `awaiting_fulfillment`, which means /api/shipping/dashboard will see
// it as `ready_to_buy` again on the next refresh.

import { veeqoFetch } from "./client";

interface VeeqoOrderForRefund {
  id?: string | number;
  allocations?: Array<{
    shipment?: {
      id?: string | number;
      created_at?: string;
    } | null;
  }>;
}

export interface RefundResult {
  orderId: string;
  shipmentId: string;
  veeqoResponse: unknown;
}

export async function refundShipmentForOrder(
  orderId: string,
): Promise<RefundResult> {
  const order = (await veeqoFetch(
    `/orders/${orderId}`,
  )) as VeeqoOrderForRefund;

  // Pick the most recently-created shipment across all allocations.
  // Veeqo lets a single order have multiple allocations (split shipments)
  // but in practice for our flow there's exactly one — taking the latest
  // matches the operator's intent ("cancel the label I just bought").
  let pick: { id: string; createdAt: number } | null = null;
  for (const a of order.allocations ?? []) {
    const sid = a?.shipment?.id;
    if (sid == null) continue;
    const tStr = a.shipment?.created_at ?? "";
    const t = tStr ? Date.parse(tStr) : 0;
    if (!pick || t > pick.createdAt) {
      pick = { id: String(sid), createdAt: t };
    }
  }
  if (!pick) {
    throw new Error("No Veeqo shipment found on this order to refund");
  }

  const veeqoResponse = await veeqoFetch(`/shipments/${pick.id}`, {
    method: "DELETE",
  });
  return { orderId, shipmentId: pick.id, veeqoResponse };
}
