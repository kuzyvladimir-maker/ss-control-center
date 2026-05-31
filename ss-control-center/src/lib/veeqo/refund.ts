// Refund (cancel) a Veeqo shipment for an order. Used by the Discard
// Label button on Shipping Labels when an Amazon order has its label
// already bought but needs to be cancelled (customer changed their
// mind, supplier failure, etc.).
//
// Mechanism:
//   1. GET /orders/{orderId} → walk allocations[] for the most recent
//      shipment id.
//   2. POST /shipping/shipments/{id}/refund — Veeqo's documented refund
//      path. Carrier (FedEx/UPS) processes the credit within 24-72h.
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

  const veeqoResponse = await veeqoFetch(
    `/shipping/shipments/${pick.id}/refund`,
    { method: "POST" },
  );
  return { orderId, shipmentId: pick.id, veeqoResponse };
}
